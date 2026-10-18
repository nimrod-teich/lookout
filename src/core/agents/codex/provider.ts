import * as fs from "node:fs";
import { questionIn, quoteAsk } from "../../asks";
import { branchAt } from "../../git";
import { HistoryIndex, type HistoryMessage, type SnippetSize } from "../../history";
import { JsonlTail, readLineAt } from "../../jsonlTail";
import type { NamedProcess, ProcessFinder } from "../../proc";
import { pulseBins } from "../../pulse";
import { searchConversations, type Searchable } from "../../search";
import type { Query } from "../../terms";
import type { Evidence } from "../../types";
import type { AgentProvider, AgentSession, AgentStatus, PastList, PastScope, PastSession, ResumeCommand, SearchOutcome } from "../agent";
import { factsOf } from "./history";
import { PastRollouts, type PastRollout } from "./past";
import { matchRollouts, type LiveProcess, type RolloutInfo } from "./match";
import { CODEX, sessionIndexFile, sessionsDir, ThreadNames } from "./paths";
import { invocationOf } from "./process";
import { activityOf, applyRolloutLine, approvalCall, emptyRollout, turnRunning, waitReason, type RolloutState } from "./rollout";
import { RolloutCatalog } from "./rollouts";

/** The first read of a rollout starts this far before its end; `session_meta` is read on its own. */
const BACKFILL_BYTES = 2 * 1024 * 1024;
/** Codex names a thread after its first exchange; until then the first prompt, cut to this length, stands in. */
const TITLE_MAX = 60;

interface Tracked {
  tail: JsonlTail;
  state: RolloutState;
  /** Its messages, built on the first search. */
  history?: HistoryIndex;
  /** The file's mtime at the last look, to tell which rollouts moved since. */
  mtimeMs?: number;
  /** The last read failed. */
  unreadable: boolean;
}

/**
 * Codex: the live sessions are the `codex` processes running interactively,
 * each tied to the rollout it writes (see `match.ts`); the state is read from
 * the rollout's last records, since Codex keeps no state file.
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
  private readonly pastIndexes = new Map<string, HistoryIndex>();

  constructor(
    private readonly home: string,
    private readonly finder: ProcessFinder,
  ) {
    this.catalog = new RolloutCatalog(sessionsDir(home));
    this.names = new ThreadNames(sessionIndexFile(home));
    this.pastRollouts = new PastRollouts(sessionsDir(home), this.names);
  }

  poll(now: number): AgentSession[] {
    const processes = this.finder
      .find()
      .map((process) => ({ process, call: invocationOf(process.args) }))
      .filter(({ call }) => call.session);
    if (processes.length === 0) {
      this.tracked.clear();
      this.liveFiles.clear();
      return [];
    }
    const live: LiveProcess[] = processes.map(({ process, call }) => ({ pid: process.pid, cwd: call.cd ?? process.cwd, startedMs: process.startedMs, resumeId: call.resumeId }));
    const since = Math.min(...live.map((p) => p.startedMs ?? now - 86_400_000));
    const rollouts = this.catalog.recent(since - 2_000, now);
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
      const session = this.session(process, rollout, now);
      files.set(session.id, rollout.file);
      return session;
    });
    const used = new Set(files.values());
    for (const file of this.tracked.keys()) if (!used.has(file)) this.tracked.delete(file);
    this.liveFiles = files;
    return sessions;
  }

  /**
   * The threads that are not running, newest first: those of the window's
   * folders, or every one. A thread of the window's folders resumes in a
   * terminal there. Compressed rollouts are not read, and the list says how many.
   */
  past(scope: PastScope, exclude: ReadonlySet<string>): PastList {
    const { rollouts, capped, incomplete, also, compressed } = this.pastRollouts.list(scope, exclude);
    this.pastListed = new Map([...rollouts, ...also].map((r) => [r.id, r]));
    for (const id of [...this.pastIndexes.keys()]) if (!this.pastListed.has(id)) this.pastIndexes.delete(id);
    const session = (r: PastRollout): PastSession => ({ agent: this.id, id: r.id, cwd: r.cwd, title: r.title, resumable: r.inFolders, modifiedAt: r.modifiedAt });
    const notes = compressed > 0 ? [`${compressed} older Codex ${compressed === 1 ? "session is" : "sessions are"} compressed (.jsonl.zst) and not listed or searched.`] : undefined;
    return { sessions: rollouts.map(session), capped, incomplete, also: also.map(session), notes };
  }

  /** Searches the live and the past threads: what you wrote and what Codex replied (see `searchConversations`). */
  search(parsed: Query, limit: number, budgetMs: number, snippet?: SnippetSize): SearchOutcome {
    const conversations = function* (this: CodexProvider): Iterable<Searchable> {
      for (const [id, file] of this.liveFiles) {
        const cwd = this.tracked.get(file)?.state.cwd ?? "";
        yield { id, cwd, branch: cwd ? branchAt(cwd) : undefined, index: () => this.indexFor(id) };
      }
      for (const [id, past] of this.pastListed) {
        if (this.liveFiles.has(id)) continue;
        // Codex records no branch: `branch:` picks only the live sessions, whose branch git tells.
        yield { id, pastModifiedAt: past.modifiedAt, cwd: past.cwd, index: () => this.indexFor(id) };
      }
    };
    return searchConversations(conversations.call(this), parsed, limit, budgetMs, snippet);
  }

  history(id: string): HistoryMessage[] | undefined {
    const index = this.indexFor(id);
    if (!index) return undefined;
    index.refresh();
    return index.messages;
  }

  /** `codex resume <id>`, in the folder the thread worked in. */
  resumeCommand(id: string): ResumeCommand | undefined {
    const past = this.pastListed.get(id);
    if (!past || !past.cwd) return undefined;
    return { args: ["codex", "resume", id], cwd: past.cwd };
  }

  private indexFor(id: string): HistoryIndex | undefined {
    const live = this.liveFiles.get(id);
    if (live) {
      const tracked = this.tracked.get(live);
      if (!tracked) return undefined;
      tracked.history ??= new HistoryIndex(live, factsOf);
      return tracked.history;
    }
    const past = this.pastListed.get(id);
    if (!past) return undefined;
    let index = this.pastIndexes.get(id);
    if (!index) {
      index = new HistoryIndex(past.file, factsOf);
      this.pastIndexes.set(id, index);
    }
    return index;
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

  private session(process: NamedProcess, rollout: RolloutInfo, now: number): AgentSession {
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
      panel: false,
      activity: status === "working" ? activityOf(state) : undefined,
      branch: cwd ? branchAt(cwd) : undefined,
      model: state.model,
      effort: state.effort,
      contextTokens: state.contextTokens,
      contextWindow: state.contextWindow,
      pulse: pulseBins(state.toolCallTimes, now, process.startedMs),
    };
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
      tracked = { tail: new JsonlTail(file, { backfillBytes: BACKFILL_BYTES }), state, unreadable: false };
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
