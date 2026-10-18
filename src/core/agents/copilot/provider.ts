import * as fs from "node:fs";
import * as path from "node:path";
import { questionIn, quoteAsk } from "../../asks";
import { within } from "../../folders";
import { branchAt } from "../../git";
import type { AgentHostSessions } from "../../agentHost";
import { HistoryIndex, type HistoryMessage, type SnippetSize } from "../../history";
import { JsonlTail } from "../../jsonlTail";
import type { ProcessFinder, ProcessTable } from "../../proc";
import { pulseBins } from "../../pulse";
import { searchConversations, type Searchable } from "../../search";
import type { Query } from "../../terms";
import type { Evidence } from "../../types";
import type { AgentProvider, AgentSession, AgentStatus, PastList, PastScope, PastSession, ResumeCommand, SearchOutcome } from "../agent";
import { activityOf, applyCopilotLine, emptyCopilot, factsOf, openPermission, type CopilotState } from "./events";
import { COPILOT, lockPids, openSessionsFile, readOpenSessions, readWorkspace, sessionStateDir, type Workspace } from "./paths";
import { resumeIdOf } from "./process";

/** The terminal program; sessions Copilot runs for an editor say otherwise. */
const CLI_CLIENT = "github/cli";
/** VS Code, running Copilot in its Chat view through its agent host (the "Copilot" session type). */
const VSCODE_CLIENT = "vscode-agent-host";

/** A session Lookout watches: the terminal program's, or VS Code's. */
function watched(workspace: Workspace | undefined): boolean {
  return !workspace?.clientName || workspace.clientName === CLI_CLIENT || workspace.clientName === VSCODE_CLIENT;
}
const TITLE_MAX = 60;
/** The first read of a session's events starts this far before their end. */
const BACKFILL_BYTES = 8 * 1024 * 1024;
/** The session folders are looked through again at most this often. */
const SCAN_MS = 15_000;
/** A list reads at most this many folders it has not read yet. */
const READS_PER_LIST = 120;
/** Copilot names a session after its first exchange; until then the first prompt stands in. */
const PROMPT_SEARCH_BYTES = 512 * 1024;
const SPEND_BASIS = "Copilot bills premium requests, not tokens, so no price is shown";

interface Tracked {
  tail: JsonlTail;
  state: CopilotState;
  history?: HistoryIndex;
  mtimeMs?: number;
}

interface Folder {
  id: string;
  dir: string;
  workspace?: Workspace;
  /** When its events were last written. */
  mtimeMs: number;
}

/** The first thing you wrote in a session. */
function firstPromptOf(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(PROMPT_SEARCH_BYTES);
      const got = fs.readSync(fd, buffer, 0, buffer.length, 0);
      for (const line of buffer.subarray(0, got).toString("utf8").split("\n")) {
        if (!line.includes('"type":"user.message"')) continue;
        const state = emptyCopilot();
        applyCopilotLine(state, line);
        if (state.firstPrompt) return state.firstPrompt;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // No events yet.
  }
  return undefined;
}

/**
 * Copilot CLI: a session is a folder under `session-state`; it is running
 * while an `inuse.<pid>.lock` in it names a live `copilot` process, which also
 * says where it runs. Working or idle is Copilot's own `working` flag in
 * `open-sessions-state.json`; an approval prompt is a `permission.requested`
 * event without its `permission.completed`.
 *
 * VS Code's Copilot sessions (client `vscode-agent-host`) are kept the same
 * way, their lock naming the `copilot-runtime` that VS Code's agent host runs
 * for every window; VS Code's own id for each, read through
 * `AgentHostSessions`, is how a jump opens it in VS Code's Chat.
 */
export class CopilotProvider implements AgentProvider {
  readonly id = COPILOT;
  readonly label = "Copilot";

  private readonly tracked = new Map<string, Tracked>();
  /** The events file of each live session, by id. */
  private liveFiles = new Map<string, string>();
  private folders: { at: number; list: Folder[] } | undefined;
  private readonly prompts = new Map<string, string | undefined>();
  private pastListed = new Map<string, Folder & { title: string; cwd: string }>();
  private readonly pastIndexes = new Map<string, HistoryIndex>();

  constructor(
    private readonly home: string,
    private readonly finder: ProcessFinder,
    private readonly proc: ProcessTable,
    private readonly now: () => number = Date.now,
    /** The `copilot-runtime` processes VS Code's agent host runs. */
    private readonly runtimes?: ProcessFinder,
    /** VS Code's ids for the sessions it runs. */
    private readonly agentHost?: AgentHostSessions,
  ) {}

  /** VS Code's address for one of its sessions: `agent-host-copilotcli:/<VS Code id>`. */
  private vscodeSessionOf(id: string, workspace: Workspace | undefined): string | undefined {
    if (workspace?.clientName !== VSCODE_CLIENT) return undefined;
    const vscodeId = this.agentHost?.idOf(id, workspace.createdAt);
    return vscodeId ? `agent-host-copilotcli:/${vscodeId}` : undefined;
  }

  /** Every session folder, with its workspace and when its events were last written; looked through at most every 15 seconds. */
  private scan(force = false): Folder[] {
    const now = this.now();
    if (!force && this.folders && now - this.folders.at < SCAN_MS) return this.folders.list;
    const root = sessionStateDir(this.home);
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      // No sessions yet.
    }
    const list: Folder[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const dir = path.join(root, name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(path.join(dir, "events.jsonl")).mtimeMs;
      } catch {
        continue;
      }
      list.push({ id: name, dir, workspace: readWorkspace(dir), mtimeMs });
    }
    this.folders = { at: now, list };
    return list;
  }

  poll(now: number): AgentSession[] {
    const running = [...this.finder.find(), ...(this.runtimes?.find() ?? [])];
    const alive = (pid: number) => (running.length ? running.some((p) => p.pid === pid) : this.proc.get(pid) !== null);
    const open = readOpenSessions(openSessionsFile(this.home));
    // The open sessions first: Copilot lists them; then any folder whose lock names a live process.
    const candidates = new Map<string, string>();
    for (const id of open.keys()) candidates.set(id, path.join(sessionStateDir(this.home), id));
    for (const folder of this.scan()) candidates.set(folder.id, folder.dir);
    const sessions: AgentSession[] = [];
    const files = new Map<string, string>();
    // A resumed session has no lock until something is sent: its process names it.
    const resumed = new Map<string, number>();
    for (const process of running) {
      const id = resumeIdOf(process.args);
      if (id) resumed.set(id, process.pid);
    }
    for (const id of resumed.keys()) candidates.set(id, path.join(sessionStateDir(this.home), id));
    for (const [id, dir] of candidates) {
      const pid = lockPids(dir).find(alive) ?? resumed.get(id);
      if (pid === undefined) continue;
      const workspace = readWorkspace(dir);
      if (!watched(workspace)) continue;
      const file = path.join(dir, "events.jsonl");
      const session = this.session(id, pid, file, workspace, open.get(id), running.find((p) => p.pid === pid)?.startedMs ?? this.proc.get(pid)?.startedMs, now);
      sessions.push(session);
      files.set(id, file);
    }
    for (const file of this.tracked.keys()) if (![...files.values()].includes(file)) this.tracked.delete(file);
    this.liveFiles = files;
    return sessions;
  }

  private session(id: string, pid: number, file: string, workspace: Workspace | undefined, flag: { working: boolean; refreshedAt?: number } | undefined, startedMs: number | undefined, now: number): AgentSession {
    const tracked = this.read(file);
    const state = tracked?.state ?? emptyCopilot();
    const permission = openPermission(state);
    let status: AgentStatus;
    let since: number | undefined;
    let evidence: Evidence;
    if (!tracked) {
      status = "unknown";
      evidence = { source: "transcript", note: "its events cannot be read" };
    } else if (permission) {
      status = "waiting";
      since = permission.at;
      evidence = { source: "transcript", at: tracked.mtimeMs, note: "an approval Copilot asked for has no answer yet" };
    } else if (flag) {
      status = flag.working ? "working" : "idle";
      since = flag.working ? (state.promptAt ?? flag.refreshedAt) : (state.turnEndAt ?? flag.refreshedAt);
      evidence = { source: "session file", at: flag.refreshedAt };
    } else {
      // No flag: the last prompt with no turn ended after it is still being answered.
      const answering = state.promptAt !== undefined && (state.turnEndAt === undefined || state.turnEndAt < state.promptAt);
      status = answering ? "working" : "idle";
      since = answering ? state.promptAt : state.turnEndAt;
      evidence = { source: "transcript", at: tracked.mtimeMs, note: "Copilot's open-sessions file has no entry for it" };
    }
    const cwd = workspace?.cwd ?? state.cwd ?? "";
    const reply = status === "idle" ? state.lastReply : undefined;
    const asked = reply ? questionIn(reply.text) : undefined;
    const tokens = state.tokens;
    const used = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0;
    return {
      agent: this.id,
      id,
      pid,
      status,
      reason: status === "waiting" ? permission?.reason : undefined,
      evidence,
      question: asked ? { text: asked, at: reply!.at } : undefined,
      lastWriteAt: tracked?.mtimeMs,
      since: since ?? startedMs,
      title: workspace?.name ?? (state.firstPrompt ? quoteAsk(state.firstPrompt, TITLE_MAX) : undefined),
      cwd,
      panel: workspace?.clientName === VSCODE_CLIENT,
      vscodeSession: this.vscodeSessionOf(id, workspace),
      // Nothing sent yet: no prompt, and no name Copilot gave it.
      empty: state.promptAt === undefined && !workspace?.name,
      activity: status === "working" ? activityOf(state) : undefined,
      branch: cwd ? branchAt(cwd) : undefined,
      model: state.model,
      effort: state.effort,
      contextTokens: state.contextTokens,
      contextWindow: state.contextWindow,
      pulse: pulseBins(state.toolCallTimes, now, startedMs),
      // Copilot's input tokens include what it read from or wrote to the cache.
      spend: used ? { input: Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite), output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, costUsd: undefined, estimated: false, partial: false, basis: SPEND_BASIS } : undefined,
    };
  }

  /** What was appended to a session's events since the last look; undefined when they cannot be read. */
  private read(file: string): Tracked | undefined {
    let tracked = this.tracked.get(file);
    if (!tracked) {
      tracked = { tail: new JsonlTail(file, { backfillBytes: BACKFILL_BYTES }), state: emptyCopilot() };
      this.tracked.set(file, tracked);
    }
    let read = tracked.tail.read();
    if (read?.reset) {
      tracked.state = emptyCopilot();
      tracked.tail = new JsonlTail(file, { backfillBytes: BACKFILL_BYTES });
      read = tracked.tail.read();
    }
    if (!read) return undefined;
    tracked.mtimeMs = read.mtimeMs;
    for (const line of read.lines) applyCopilotLine(tracked.state, line);
    return tracked;
  }

  /** The sessions that are not running, newest first; one of the window's folders resumes with `copilot --resume`. */
  past(scope: PastScope, exclude: ReadonlySet<string>): PastList {
    const candidates = this.scan()
      .filter((f) => !exclude.has(f.id) && !this.liveFiles.has(f.id) && watched(f.workspace))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const listed: (Folder & { title: string; cwd: string })[] = [];
    let reads = 0;
    let unread = 0;
    let next = 0;
    const titled = (f: Folder) => {
      if (f.workspace?.name) return f.workspace.name;
      if (!this.prompts.has(f.dir)) {
        if (reads++ >= READS_PER_LIST) return null;
        this.prompts.set(f.dir, firstPromptOf(path.join(f.dir, "events.jsonl")));
      }
      const prompt = this.prompts.get(f.dir);
      return prompt ? quoteAsk(prompt, TITLE_MAX) : undefined;
    };
    for (; next < candidates.length && listed.length < scope.limit; next++) {
      const folder = candidates[next]!;
      const cwd = folder.workspace?.cwd ?? "";
      if (!scope.all && !within(cwd, scope.folders)) continue;
      const title = titled(folder);
      if (title === null) {
        unread++;
        continue;
      }
      if (title) listed.push({ ...folder, title, cwd });
    }
    const capped = candidates.slice(next).some((f) => scope.all || within(f.workspace?.cwd ?? "", scope.folders));
    const shown = new Set(listed.map((f) => f.id));
    const also: (Folder & { title: string; cwd: string })[] = [];
    for (const id of scope.also ?? []) {
      if (shown.has(id) || exclude.has(id)) continue;
      const folder = candidates.find((f) => f.id === id);
      const title = folder && titled(folder);
      if (folder && title) also.push({ ...folder, title, cwd: folder.workspace?.cwd ?? "" });
    }
    this.pastListed = new Map([...listed, ...also].map((f) => [f.id, f]));
    for (const id of [...this.pastIndexes.keys()]) if (!this.pastListed.has(id)) this.pastIndexes.delete(id);
    const session = (f: Folder & { title: string; cwd: string }): PastSession => {
      const base: PastSession = { agent: this.id, id: f.id, cwd: f.cwd, title: f.title, resumable: f.cwd !== "" && within(f.cwd, scope.folders), modifiedAt: Math.round(f.mtimeMs) };
      if (f.workspace?.clientName !== VSCODE_CLIENT) return base;
      // VS Code's own session: it opens again in VS Code's Chat, not with `copilot --resume`.
      const vscodeSession = base.resumable ? this.vscodeSessionOf(f.id, f.workspace) : undefined;
      return { ...base, resumesIn: "panel", ...(vscodeSession ? { vscodeSession } : {}) };
    };
    return { sessions: listed.map(session), capped, incomplete: unread > 0, also: also.map(session) };
  }

  /** Searches the live and the past sessions' messages (see `searchConversations`). */
  search(parsed: Query, limit: number, budgetMs: number, snippet?: SnippetSize): SearchOutcome {
    const conversations = function* (this: CopilotProvider): Iterable<Searchable> {
      for (const [id, file] of this.liveFiles) {
        const cwd = this.tracked.get(file)?.state.cwd ?? "";
        yield { id, cwd, branch: cwd ? branchAt(cwd) : undefined, index: () => this.indexFor(id) };
      }
      for (const [id, past] of this.pastListed) {
        if (this.liveFiles.has(id)) continue;
        // Copilot records no branch: `branch:` picks only the live sessions.
        yield { id, pastModifiedAt: Math.round(past.mtimeMs), cwd: past.cwd, index: () => this.indexFor(id) };
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

  /** `copilot --resume <id>`, in the folder the session worked in. */
  resumeCommand(id: string): ResumeCommand | undefined {
    const past = this.pastListed.get(id);
    if (!past?.cwd || past.workspace?.clientName === VSCODE_CLIENT) return undefined;
    return { args: ["copilot", "--resume", id], cwd: past.cwd };
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
      index = new HistoryIndex(path.join(past.dir, "events.jsonl"), factsOf);
      this.pastIndexes.set(id, index);
    }
    return index;
  }

  /** The session folders (events and locks) and the open-sessions file are watched. */
  watch(listener: () => void): { dispose(): void } | undefined {
    const watchers: fs.FSWatcher[] = [];
    try {
      watchers.push(fs.watch(sessionStateDir(this.home), { persistent: false, recursive: true }, () => listener()));
    } catch {
      // No sessions folder yet: the poll keeps up.
    }
    try {
      watchers.push(fs.watch(this.home, { persistent: false }, (_, name) => {
        if (name === path.basename(openSessionsFile(this.home))) listener();
      }));
    } catch {
      // No home yet.
    }
    for (const watcher of watchers) watcher.on("error", () => watcher.close());
    return watchers.length ? { dispose: () => watchers.forEach((watcher) => watcher.close()) } : undefined;
  }
}
