import * as fs from "node:fs";
import type { AgentHostSessions } from "../../agentHost";
import { questionIn, quoteAsk } from "../../asks";
import { branchAt } from "../../git";
import { HistoryIndexes, type HistoryIndex, type HistoryMessage, type SnippetSize } from "../../history";
import { findLastLine, JsonlTail, readLineAt } from "../../jsonlTail";
import type { NamedProcess, ProcessFinder } from "../../proc";
import { pulseBins } from "../../pulse";
import type { BackgroundReads } from "../../background";
import { readConversationsAhead, searchConversations, type Searchable } from "../../search";
import type { Query } from "../../terms";
import type { Evidence } from "../../types";
import type { UsageSnapshot } from "../../usage";
import type { AgentProvider, AgentSession, AgentStatus, PastList, PastScope, PastSession, ResumeCommand, SearchOutcome, SessionSpend } from "../agent";
import { ROLLOUT_LINES } from "./history";
import { PastRollouts, type PastRollout } from "./past";
import { fromTerminal, matchRollouts, type LiveProcess, type RolloutInfo } from "./match";
import { CODEX, lockedThread, sessionIndexFile, sessionsDir, ThreadNames } from "./paths";
import { invocationOf, serverOf, type CodexServer } from "./process";
import { activityOf, applyRolloutLine, approvalCall, emptyRollout, turnRunning, waitReason, type RolloutState } from "./rollout";
import { RolloutCatalog } from "./rollouts";
import { metersOf } from "./usage";

/**
 * The first read of a rollout starts this far before its end; `session_meta`
 * is read on its own. A longer rollout's earlier replies go unpriced, so its
 * price is left out.
 */
const BACKFILL_BYTES = 8 * 1024 * 1024;
/** With no session running, the limits come from the newest rollout of this many days. */
const USAGE_DAYS = 7;
/** How a Codex session's price is reached. */
const PRICE_BASIS = "Lookout's sum of each reply's tokens at OpenAI's API list prices; a ChatGPT plan is not billed per token";
/** Codex names a thread after its first exchange; until then the first prompt, cut to this length, stands in. */
const TITLE_MAX = 60;
/** Where the held files cannot be read (Windows): an editor's thread written in this long counts as loaded in its app-server. */
const BLIND_PANEL_MS = 10 * 60_000;

/** A thread an app-server or an `exec` run holds, as its lock says. */
interface Held {
  process: NamedProcess;
  server: CodexServer;
  rollout: RolloutInfo;
}

interface Tracked {
  tail: JsonlTail;
  state: RolloutState;
  /** The file's mtime at the last look, to tell which rollouts moved since. */
  mtimeMs?: number;
  /** The last read failed. */
  unreadable: boolean;
  /** The first read started past the beginning: replies before it were not priced. */
  joinedLate: boolean;
}

/**
 * Codex: the live sessions are the `codex` processes running interactively,
 * each tied to the rollout it writes (see `match.ts`), and the threads an
 * app-server (the VS Code extension's, one per window) or a `codex exec` run
 * holds, as their thread locks say. The state is read from the rollout's last
 * records, since Codex keeps no state file.
 */
export class CodexProvider implements AgentProvider {
  readonly id = CODEX;
  readonly label = "Codex";

  private readonly catalog: RolloutCatalog;
  private readonly names: ThreadNames;
  private readonly tracked = new Map<string, Tracked>();
  /** The rollout of each live session, by id. */
  private liveFiles = new Map<string, string>();
  /** The mtimes seen at the previous poll, by file. */
  private previous = new Map<string, number>();
  private readonly pastRollouts: PastRollouts;
  /** The past sessions last listed, by id. */
  private pastListed = new Map<string, PastRollout>();
  /** The threads' messages, by rollout, built on the first search: a thread that ends or resumes keeps its own. */
  private readonly indexes = new HistoryIndexes(ROLLOUT_LINES);

  constructor(
    private readonly home: string,
    private readonly finder: ProcessFinder,
    /** VS Code's ids for the threads its own Chat runs. */
    private readonly agentHost?: AgentHostSessions,
  ) {
    this.catalog = new RolloutCatalog(sessionsDir(home));
    this.names = new ThreadNames(sessionIndexFile(home));
    this.pastRollouts = new PastRollouts(sessionsDir(home), this.names);
  }

  poll(now: number): AgentSession[] {
    const found = this.finder.find();
    const processes = found.map((process) => ({ process, call: invocationOf(process.args) })).filter(({ call }) => call.session);
    const held = this.heldThreads(found, now);
    if (processes.length === 0 && held.size === 0) {
      this.tracked.clear();
      this.liveFiles.clear();
      return [];
    }
    const live: LiveProcess[] = processes.map(({ process, call }) => ({ pid: process.pid, cwd: call.cd ?? process.cwd, startedMs: process.startedMs, resumeId: call.resumeId }));
    const since = Math.min(now, ...live.map((p) => p.startedMs ?? now - 86_400_000));
    // A thread a process holds is that process's: the terminal sessions are matched among the others.
    const rollouts = this.catalog.recent(since - 2_000, now).filter((rollout) => !held.has(rollout.id));
    for (const p of live) {
      if (!p.resumeId || rollouts.some((r) => r.id === p.resumeId)) continue;
      const found = this.catalog.find(p.resumeId, now);
      if (found) rollouts.push(found);
    }
    const moved = (file: string) => {
      const before = this.previous.get(file);
      const now = rollouts.find((r) => r.file === file)?.mtimeMs;
      return before !== undefined && now !== undefined && now > before;
    };
    const matched = matchRollouts(live, rollouts, moved);
    this.previous = new Map(rollouts.map((r) => [r.file, r.mtimeMs]));
    const files = new Map<string, string>();
    const sessions = processes.map(({ process }) => {
      const rollout = matched.get(process.pid);
      if (!rollout) return this.empty(process);
      const session = this.session(process, rollout, now, false);
      files.set(session.id, rollout.file);
      return session;
    });
    for (const { process, server, rollout } of held.values()) {
      // An app-server's threads are its editor's: placed in the panel of the window whose extension host runs it.
      const session = this.session(process, rollout, now, server === "app-server");
      // VS Code's own Chat runs it (its Codex session type): placed by its folder, opened there.
      const vscodeSession = this.vscodeSessionOf(rollout.id, rollout.originator, rollout.createdAt);
      if (vscodeSession) session.vscodeSession = vscodeSession;
      files.set(session.id, rollout.file);
      sessions.push(session);
    }
    const used = new Set(files.values());
    for (const file of this.tracked.keys()) if (!used.has(file)) this.tracked.delete(file);
    this.liveFiles = files;
    return sessions;
  }

  /**
   * The threads the app-servers and the `exec` runs hold, by id: Codex holds a
   * thread's `thread-writer-locks/<id>.lock` while it has the thread loaded.
   * The daemon that serves the terminal sessions is left out: it keeps a
   * thread loaded after its terminal has ended, so those are matched to their
   * terminal instead. Where the held files cannot be read (Windows), an
   * app-server's threads are the editor's threads written in the last 10 minutes.
   */
  private heldThreads(found: readonly NamedProcess[], now: number): Map<string, Held> {
    const held = new Map<string, Held>();
    const blind: NamedProcess[] = [];
    for (const process of found) {
      const server = serverOf(process.args);
      if (server !== "app-server" && server !== "exec") continue;
      const files = this.finder.heldFiles?.(process.pid);
      if (files === undefined) {
        if (server === "app-server") blind.push(process);
        continue;
      }
      for (const file of files) {
        const id = lockedThread(file);
        const rollout = id === undefined ? undefined : this.catalog.find(id, now);
        if (id !== undefined && rollout) held.set(id, { process, server, rollout });
      }
    }
    const newest = blind.sort((a, b) => (b.startedMs ?? 0) - (a.startedMs ?? 0))[0];
    if (newest) {
      for (const rollout of this.catalog.recent(now - BLIND_PANEL_MS, now)) {
        if (held.has(rollout.id) || fromTerminal(rollout) || now - rollout.mtimeMs > BLIND_PANEL_MS || !/vscode/i.test(rollout.originator ?? "")) continue;
        held.set(rollout.id, { process: newest, server: "app-server", rollout });
      }
    }
    return held;
  }

  /**
   * The threads that are not running, newest first: those of the window's
   * folders, or every one. A thread of the window's folders resumes in a
   * terminal there, or, when the VS Code extension wrote it, in the
   * extension's panel. Compressed rollouts are not read, and the list says how many.
   */
  past(scope: PastScope, exclude: ReadonlySet<string>): PastList {
    const { rollouts, capped, incomplete, also, compressed } = this.pastRollouts.list(scope, exclude);
    this.pastListed = new Map([...rollouts, ...also].map((r) => [r.id, r]));
    this.indexes.keepOnly([...[...this.pastListed.values()].map((r) => r.file), ...this.tracked.keys()]);
    const session = (r: PastRollout): PastSession => {
      const base: PastSession = { agent: this.id, id: r.id, cwd: r.cwd, title: r.title, resumable: r.inFolders, modifiedAt: r.modifiedAt };
      if (!editorThread(r.originator)) return base;
      const vscodeSession = r.inFolders ? this.vscodeSessionOf(r.id, r.originator) : undefined;
      return { ...base, resumesIn: "panel", ...(vscodeSession ? { vscodeSession } : {}) };
    };
    const notes = compressed > 0 ? [`${compressed} older Codex ${compressed === 1 ? "session is" : "sessions are"} compressed (.jsonl.zst) and not listed or searched.`] : undefined;
    return { sessions: rollouts.map(session), capped, incomplete, also: also.map(session), notes };
  }

  /** Searches the live and the past threads: what you wrote and what Codex replied (see `searchConversations`). */
  search(parsed: Query, limit: number, budgetMs: number, snippet?: SnippetSize, background?: BackgroundReads): SearchOutcome {
    return searchConversations(this.conversations(), parsed, limit, budgetMs, snippet, background);
  }

  readAhead(background: BackgroundReads): void {
    readConversationsAhead(this.conversations(), background);
  }

  /** The threads a search covers: the live ones, then the past ones last listed. */
  *conversations(): Iterable<Searchable> {
    for (const [id, file] of this.liveFiles) {
      const cwd = this.tracked.get(file)?.state.cwd ?? "";
      yield { id, cwd, branch: cwd ? branchAt(cwd) : undefined, index: () => this.indexFor(id), file };
    }
    for (const [id, past] of this.pastListed) {
      if (this.liveFiles.has(id)) continue;
      // Codex records no branch: `branch:` picks only the live sessions, whose branch git tells.
      yield { id, pastModifiedAt: past.modifiedAt, cwd: past.cwd, index: () => this.indexFor(id), file: past.file };
    }
  }

  /** The rollout of a live or a past thread. */
  fileOf(id: string): string | undefined {
    return this.liveFiles.get(id) ?? this.pastListed.get(id)?.file;
  }

  history(id: string, background?: BackgroundReads): HistoryMessage[] | undefined {
    const index = this.indexFor(id);
    if (!index) return undefined;
    index.update(background);
    return index.messages;
  }

  /** VS Code's address for a thread its own Chat runs (`originator` `vscode_agent_host`): `agent-host-codex:/<VS Code id>`. */
  private vscodeSessionOf(id: string, originator: string | undefined, createdAt?: number): string | undefined {
    if (!originator || !/agent_host/i.test(originator)) return undefined;
    const vscodeId = this.agentHost?.idOf(id, createdAt);
    return vscodeId ? `agent-host-codex:/${vscodeId}` : undefined;
  }

  /** `codex resume <id>`, in the folder the thread worked in; none for the VS Code extension's threads, which resume in its panel. */
  resumeCommand(id: string): ResumeCommand | undefined {
    const past = this.pastListed.get(id);
    if (!past || !past.cwd || editorThread(past.originator)) return undefined;
    return { args: ["codex", "resume", id], cwd: past.cwd };
  }

  private indexFor(id: string): HistoryIndex | undefined {
    const live = this.liveFiles.get(id);
    if (live) return this.tracked.has(live) ? this.indexes.of(live) : undefined;
    const past = this.pastListed.get(id);
    return past ? this.indexes.of(past.file) : undefined;
  }

  /** A session with nothing sent yet: Codex writes its rollout with the first prompt. */
  private empty(process: NamedProcess): AgentSession {
    return {
      agent: this.id,
      id: `codex-pid-${process.pid}-${process.startedMs ?? 0}`,
      pid: process.pid,
      status: "idle",
      evidence: { source: "process", at: process.startedMs, note: "nothing sent yet" },
      since: process.startedMs,
      cwd: process.cwd ?? "",
      panel: false,
      empty: true,
    };
  }

  private session(process: NamedProcess, rollout: RolloutInfo, now: number, panel: boolean): AgentSession {
    const tracked = this.read(rollout.file);
    const state = tracked.state;
    const running = turnRunning(state);
    const approval = running ? approvalCall(state) : undefined;
    let status: AgentStatus;
    let since: number | undefined;
    if (tracked.unreadable) {
      status = "unknown";
    } else if (approval) {
      status = "waiting";
      since = approval.at;
    } else if (state.question) {
      status = "waiting";
      since = state.question.at;
    } else if (running) {
      status = "working";
      since = state.turnAt;
    } else {
      status = "idle";
      since = state.turnAt ?? state.lastRecordAt;
    }
    const id = state.id ?? rollout.id;
    const cwd = state.cwd ?? rollout.cwd ?? process.cwd ?? "";
    const reply = status === "idle" && state.lastReply?.final ? state.lastReply : undefined;
    const asked = reply ? questionIn(reply.text) : undefined;
    return {
      agent: this.id,
      id,
      pid: process.pid,
      status,
      reason: status === "waiting" ? waitReason(state) : undefined,
      evidence: this.evidenceOf(tracked, approval !== undefined),
      question: asked ? { text: asked, at: reply!.at } : undefined,
      lastWriteAt: tracked.mtimeMs,
      since: since ?? process.startedMs,
      title: this.names.get(id) ?? (state.firstPrompt ? quoteAsk(state.firstPrompt, TITLE_MAX) : undefined),
      cwd,
      panel,
      activity: status === "working" ? activityOf(state) : undefined,
      branch: cwd ? branchAt(cwd) : undefined,
      model: state.model,
      effort: state.effort,
      contextTokens: state.contextTokens,
      contextWindow: state.contextWindow,
      pulse: pulseBins(state.toolCallTimes, now, process.startedMs),
      spend: this.spendOf(tracked),
    };
  }

  /** The thread's tokens so far, and what they would cost through the API, when every reply's model has a price. */
  private spendOf(tracked: Tracked): SessionSpend | undefined {
    const totals = tracked.state.totals;
    if (!totals) return undefined;
    const { state } = tracked;
    const priced = !tracked.joinedLate && !state.unpriced && state.priced.size > 0;
    return {
      input: Math.max(0, totals.input - totals.cached - totals.cacheWrite),
      cacheRead: totals.cached,
      cacheWrite: totals.cacheWrite,
      output: totals.output,
      costUsd: priced ? state.costUsd : undefined,
      estimated: true,
      partial: false,
      basis: PRICE_BASIS,
    };
  }

  /** The newest file of the limits read with no session running, and what it said. */
  private lastUsage: { file: string; mtimeMs: number; snapshot: UsageSnapshot | undefined } | undefined;

  /**
   * The account's limits as Codex last recorded them (`token_count`
   * `rate_limits`): from the live sessions' rollouts, or, with none running,
   * from the newest rollout of the last week. When Codex runs on an API key it
   * records none.
   */
  usage(now: number): UsageSnapshot | undefined {
    let newest: { at: number; snapshot: UsageSnapshot } | undefined;
    for (const file of this.liveFiles.values()) {
      const limits = this.tracked.get(file)?.state.rateLimits;
      if (!limits || (newest && newest.at >= limits.at)) continue;
      const meters = metersOf(limits);
      if (meters.length) newest = { at: limits.at, snapshot: { fetchedAt: limits.at, meters } };
    }
    if (newest) return newest.snapshot;
    const latest = this.catalog.recent(now - USAGE_DAYS * 86_400_000, now).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (!latest) return undefined;
    if (this.lastUsage?.file !== latest.file || this.lastUsage.mtimeMs !== latest.mtimeMs) {
      const state = emptyRollout();
      // A token_count without limits says "rate_limits":null; the last one with them counts.
      const at = findLastLine(latest.file, '"rate_limits":{', BACKFILL_BYTES);
      const line = at === undefined ? undefined : readLineAt(latest.file, at);
      if (line !== undefined) applyRolloutLine(state, line);
      const meters = state.rateLimits ? metersOf(state.rateLimits) : [];
      this.lastUsage = { file: latest.file, mtimeMs: latest.mtimeMs, snapshot: state.rateLimits && meters.length ? { fetchedAt: state.rateLimits.at, meters } : undefined };
    }
    return this.lastUsage.snapshot;
  }

  /** The state is Codex's own records, read from the rollout's end: the hover says so, and how old they are. */
  private evidenceOf(tracked: Tracked, approval: boolean): Evidence {
    if (tracked.unreadable) return { source: "rollout tail", at: tracked.mtimeMs, note: "it cannot be read" };
    return { source: "rollout tail", at: tracked.mtimeMs, note: approval ? "a command that asked to leave the sandbox has no result yet" : undefined };
  }

  /** Reads what was appended to a rollout since the last look; the first look reads its first line and its last 2 MB. */
  private read(file: string): Tracked {
    let tracked = this.tracked.get(file);
    if (!tracked) {
      const state = emptyRollout();
      const first = readLineAt(file, 0, 4 * 1024 * 1024);
      if (first !== undefined) applyRolloutLine(state, first);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        // Read below, and found unreadable there.
      }
      tracked = { tail: new JsonlTail(file, { backfillBytes: BACKFILL_BYTES }), state, unreadable: false, joinedLate: size > BACKFILL_BYTES };
      this.tracked.set(file, tracked);
    }
    let read = tracked.tail.read();
    if (read?.reset) {
      tracked.state = emptyRollout();
      tracked.tail = new JsonlTail(file, { backfillBytes: BACKFILL_BYTES });
      read = tracked.tail.read();
    }
    tracked.unreadable = read === null;
    if (read) {
      tracked.mtimeMs = read.mtimeMs;
      for (const line of read.lines) applyRolloutLine(tracked.state, line);
    }
    return tracked;
  }

  /** Codex appends to its rollouts; the sessions folder is watched, its date folders and all. */
  watch(listener: () => void): { dispose(): void } | undefined {
    try {
      const watcher = fs.watch(sessionsDir(this.home), { persistent: false, recursive: true }, () => listener());
      watcher.on("error", () => watcher.close());
      return { dispose: () => watcher.close() };
    } catch {
      return undefined;
    }
  }
}

/** A thread an editor wrote: the OpenAI extension's (`codex_vscode`) or VS Code's own Chat's (`vscode_agent_host`); it opens there, not in a terminal. */
function editorThread(originator: string | undefined): boolean {
  return originator !== undefined && /vscode/i.test(originator);
}
