import * as fs from "node:fs";
import * as path from "node:path";
import { HistoryIndexes, type HistoryIndex, type HistoryMessage, type SnippetSize } from "../../history";
import { branchAt } from "../../git";
import type { Query } from "../../terms";
import type { BackgroundReads } from "../../background";
import { readConversationsAhead, searchConversations, type Searchable } from "../../search";
import { findLastLine, JsonlTail, lineStartAtOrAfter, readLineAt } from "../../jsonlTail";
import { TRANSCRIPT_LINES } from "./history";
import { PastTranscripts } from "./past";
import type { ProcessTable } from "../../proc";
import type { Evidence } from "../../types";
import type { AgentProvider, AgentSession, Background, AgentStatus, PastList, PastScope, PastSession, SearchOutcome } from "../agent";
import { findTranscript, sessionsDir } from "./paths";
import { SessionRegistry } from "./registry";
import type { SessionFile } from "./sessionFile";
import { activityOf, agentsOf, applyLine, contextWindowOf, emptyTranscript, pulseMarksOf, pulseOf, schedulesOf, spendOf, titleOf, type OpenTool, type TranscriptState } from "./transcript";
import { planFileTitle, questionOf, reasonOf } from "./waiting";

export const CLAUDE_CODE = "claude-code";

/** Entry point of sessions the Claude Code VS Code extension hosts in its panel. */
const PANEL_ENTRYPOINT = "claude-vscode";
/** A session has no transcript until its first prompt; look again this often. */
const TRANSCRIPT_LOOKUP_MS = 5000;
/** How far back the first read looks for Claude Code's last cost checkpoint. */
const CHECKPOINT_SEARCH_BYTES = 64 * 1024 * 1024;
/** Reading from a checkpoint farther back than this would be slow; the spend is then partial. */
const CHECKPOINT_READ_BYTES = 24 * 1024 * 1024;
const BACKFILL_BYTES = 1024 * 1024;
/** Once the main transcript has been silent this long, the subagents' transcripts are looked at too. */
const SUBAGENT_CHECK_AFTER_MS = 60_000;
/** A subagent's open tool call sits near the end of its transcript. */
const SUBAGENT_TAIL_BYTES = 256 * 1024;

interface Tracked {
  tail?: JsonlTail;
  state: TranscriptState;
  nextLookupAt: number;
  /** The transcript file, once found. */
  file?: string;
  /** Epoch ms the transcript was last modified. */
  writtenAt?: number;
}

/** A background job whose processes used no CPU for this long may be stuck, or waiting on something that will not come. */
const STALLED_MS = 15 * 60_000;
/** A process in its first minute has not written its state yet; it is idle, not unknown. */
const STARTING_MS = 60_000;

function starting(file: SessionFile, now: number): boolean {
  return file.startedAt !== undefined && now - file.startedAt < STARTING_MS;
}

function statusOf(file: SessionFile, now: number): AgentStatus {
  if (file.unreadable) return "unknown";
  switch (file.status) {
    case "busy":
      return "working";
    case "waiting":
      return "waiting";
    case "idle":
    case "shell":
      return "idle";
    default:
      return starting(file, now) ? "idle" : "unknown";
  }
}

/** Where a session's status comes from, and how old that is. */
function evidenceOf(file: SessionFile, now: number): Evidence {
  const written = file.updatedAt ?? file.writtenAt;
  if (file.unreadable) return { source: "session file", at: file.writtenAt, note: "it cannot be read" };
  if (file.status) return { source: "session file", at: written };
  if (starting(file, now)) return { source: "process", at: file.startedAt, note: "no state recorded yet" };
  return { source: "session file", at: written, note: "it records no state" };
}

/** Applies the last title entries of each kind, wherever they are in the file; lines read later override them in order. */

/** Whatever is skipped, the title must not be: Claude Code stamps it once, and again on resume just before a checkpoint. */
function seedTitles(file: string, state: TranscriptState): void {
  for (const needle of ['"type":"custom-title"', '"type":"ai-title"']) {
    const at = findLastLine(file, needle, CHECKPOINT_SEARCH_BYTES);
    if (at === undefined) continue;
    const line = readLineAt(file, at);
    if (line !== undefined) applyLine(state, line);
  }
}

/**
 * Claude Code: state from the per-process session files, title and current
 * directory from each session's transcript.
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = CLAUDE_CODE;
  readonly label = "Claude Code";

  private readonly registry: SessionRegistry;
  private readonly tracked = new Map<string, Tracked>();

  private readonly pastTranscripts: PastTranscripts;
  /** Transcript file by id, for the past sessions last listed. */
  private pastFiles = new Map<string, string>();
  /** Where the past sessions last listed ran and when they were last written, for the search's filters. */
  private pastMeta = new Map<string, { cwd: string; branch?: string; modifiedAt: number }>();
  /** The conversations' messages, by transcript, built on the first search: a session that ends or resumes keeps its own. */
  private readonly indexes = new HistoryIndexes(TRANSCRIPT_LINES);
  /** Plan titles by file, read again when the file changes. */
  private readonly plans = new Map<string, { mtimeMs: number; title: string | undefined }>();
  /** The open tool call of the subagent transcript last read, by file version. */
  /** Background jobs by pid: their CPU at the last look, and how long they have been busy. */
  private readonly jobs = new Map<number, { startedMs?: number; ticks?: number; size?: number; lastAt: number; busyAt: number; activeMs: number }>();
  private subagentCall: { file: string; mtimeMs: number; tool: OpenTool | undefined } | undefined;

  constructor(
    private readonly configDir: string,
    private readonly proc: ProcessTable,
  ) {
    this.registry = new SessionRegistry(sessionsDir(configDir), proc);
    this.pastTranscripts = new PastTranscripts(configDir);
  }

  poll(now: number): AgentSession[] {
    const files = this.registry.scan();
    const live = new Set<string>();
    const sessions = files.map((file): AgentSession => {
      live.add(file.sessionId);
      const transcript = this.readTranscript(file, now);
      const reported = statusOf(file, now);
      // A turn that is over while commands it started still run: still at work, in the background.
      const background = reported === "idle" ? this.backgroundOf(file.pid, now) : undefined;
      const status = background ? "working" : reported;
      return {
        agent: this.id,
        id: file.sessionId,
        pid: file.pid,
        status,
        reason: status === "waiting" ? reasonOf(file, transcript, { planTitle: (slug) => this.planTitle(slug), subagentTool: () => this.subagentTool(file.sessionId) }) : undefined,
        evidence: evidenceOf(file, now),
        question: status === "idle" ? questionOf(transcript) : undefined,
        lastWriteAt: this.lastWrite(file.sessionId, now),
        since: file.statusUpdatedAt ?? file.startedAt,
        title: titleOf(transcript),
        cwd: transcript.cwd ?? file.cwd,
        panel: file.entrypoint === PANEL_ENTRYPOINT,
        // Claude Code writes the transcript once something is sent.
        empty: this.tracked.get(file.sessionId)?.file === undefined,
        activity: status === "working" && !background ? activityOf(transcript) : undefined,
        agents: status === "working" && !background ? agentsOf(transcript) : 0,
        background,
        // Claude Code stamps the branch of the checkout it started in; a session working in a worktree is on that one's.
        branch: (transcript.cwd ? branchAt(transcript.cwd) : undefined) ?? transcript.gitBranch,
        effort: transcript.effort,
        model: transcript.model,
        contextTokens: transcript.contextTokens,
        contextWindow: contextWindowOf(transcript.model, transcript.contextTokens),
        pulse: pulseOf(transcript, now, file.startedAt),
        pulseMarks: pulseMarksOf(transcript, now, file.startedAt),
        spend: spendOf(transcript),
        schedules: schedulesOf(transcript, now),
      };
    });
    for (const id of this.tracked.keys()) if (!live.has(id)) this.tracked.delete(id);
    return sessions;
  }

  past(scope: PastScope, exclude: ReadonlySet<string>): PastList {
    const { transcripts, capped, incomplete, also } = this.pastTranscripts.list(scope, exclude);
    const all = [...transcripts, ...also];
    this.pastFiles = new Map(all.map((p) => [p.id, p.file]));
    this.pastMeta = new Map(all.map((p) => [p.id, { cwd: p.cwd, branch: p.branch, modifiedAt: p.modifiedAt }]));
    this.indexes.keepOnly([...this.pastFiles.values(), ...[...this.tracked.values()].flatMap((tracked) => (tracked.file ? [tracked.file] : []))]);
    const session = (p: (typeof all)[number]): PastSession => ({ agent: this.id, id: p.id, cwd: p.cwd, title: p.title, branch: p.branch, resumable: p.resumable, modifiedAt: p.modifiedAt });
    return { sessions: transcripts.map(session), capped, incomplete, also: also.map(session) };
  }

  /**
   * Searches the live and the past sessions' transcripts (see
   * `searchConversations`), the live sessions first. A session's project and
   * branch are where it works now, or, for a past one, where it last worked.
   */
  search(parsed: Query, limit: number, budgetMs: number, snippet?: SnippetSize, background?: BackgroundReads): SearchOutcome {
    return searchConversations(this.conversations(), parsed, limit, budgetMs, snippet, background);
  }

  readAhead(background: BackgroundReads): void {
    readConversationsAhead(this.conversations(), background);
  }

  /** The conversations a search covers: the live sessions', then the past ones last listed. */
  *conversations(): Iterable<Searchable> {
    for (const [id, tracked] of this.tracked) yield { id, cwd: tracked.state.cwd ?? "", branch: tracked.state.gitBranch, index: () => this.indexFor(id), ...(tracked.file ? { file: tracked.file } : {}) };
    for (const [id, file] of this.pastFiles) {
      if (this.tracked.has(id)) continue;
      // Without what the list said of it, no project or branch picks it.
      const meta = this.pastMeta.get(id);
      yield { id, pastModifiedAt: meta?.modifiedAt, cwd: meta?.cwd ?? "", branch: meta?.branch, index: () => this.indexFor(id), file };
    }
  }

  /** The transcript of a live or a past session, once known. */
  fileOf(id: string): string | undefined {
    return this.tracked.get(id)?.file ?? this.pastFiles.get(id);
  }

  /**
   * The shell commands a session left running in the background: children of
   * its process started from Claude Code's shell snapshot. Their count, and
   * when the oldest started.
   */
  private backgroundOf(pid: number, now: number): Background | undefined {
    const shells = (this.proc.children?.(pid) ?? []).filter((child) => child.args.includes("/shell-snapshots/snapshot-"));
    if (shells.length === 0) return undefined;
    let activeMs = 0;
    let orphaned = 0;
    let lastBusyAt = -Infinity;
    for (const shell of shells) {
      const ticks = this.proc.cpuTicks?.(shell.pid);
      const output = this.proc.output?.(shell.pid);
      // Claude Code deletes a job's output file when it forgets the job, as on a restart: nobody waits on it any more.
      if (output?.deleted) orphaned++;
      let seen = this.jobs.get(shell.pid);
      if (!seen || seen.startedMs !== shell.startedMs) {
        seen = { startedMs: shell.startedMs, ticks, size: output?.size, lastAt: now, busyAt: shell.startedMs ?? now, activeMs: 0 };
        this.jobs.set(shell.pid, seen);
      } else {
        // Busy since the last look when it used CPU or wrote output meanwhile (work in a container uses no CPU of its own);
        // a long gap counts a minute at most.
        const used = ticks !== undefined && seen.ticks !== undefined && ticks > seen.ticks;
        const wrote = output !== undefined && seen.size !== undefined && output.size > seen.size;
        if (used || wrote) {
          seen.activeMs += Math.min(now - seen.lastAt, 60_000);
          seen.busyAt = now;
        }
        seen.ticks = ticks;
        seen.size = output?.size;
        seen.lastAt = now;
      }
      activeMs += seen.activeMs;
      lastBusyAt = Math.max(lastBusyAt, seen.busyAt);
    }
    const starts = shells.map((shell) => shell.startedMs).filter((at): at is number => at !== undefined);
    const quietMs = now - lastBusyAt;
    return { count: shells.length, since: starts.length ? Math.min(...starts) : undefined, activeMs, idleMs: quietMs >= STALLED_MS ? quietMs : undefined, orphaned: orphaned || undefined };
  }


  history(id: string, background?: BackgroundReads): HistoryMessage[] | undefined {
    const index = this.indexFor(id);
    if (!index) return undefined;
    index.update(background);
    return index.messages;
  }

  /** The session's conversation index, live or past; nothing until its transcript is known. */
  private indexFor(id: string): HistoryIndex | undefined {
    const tracked = this.tracked.get(id);
    const file = tracked ? tracked.file : this.pastFiles.get(id);
    return file ? this.indexes.of(file) : undefined;
  }

  /** Session files are rewritten in place on every state change, which the directory watch reports. */
  watch(listener: () => void): { dispose(): void } | undefined {
    try {
      const watcher = fs.watch(sessionsDir(this.configDir), { persistent: false }, () => listener());
      watcher.on("error", () => watcher.close());
      return { dispose: () => watcher.close() };
    } catch {
      return undefined;
    }
  }

  private readTranscript(file: SessionFile, now: number): TranscriptState {
    let tracked = this.tracked.get(file.sessionId);
    if (!tracked) {
      tracked = { state: emptyTranscript(), nextLookupAt: 0 };
      this.tracked.set(file.sessionId, tracked);
    }
    if (!tracked.tail && now >= tracked.nextLookupAt) {
      const transcript = findTranscript(this.configDir, file.cwd, file.sessionId);
      if (transcript) {
        tracked.file = transcript;
        Object.assign(tracked, this.openTranscript(transcript, tracked.state));
      } else tracked.nextLookupAt = now + TRANSCRIPT_LOOKUP_MS;
    }
    let read = tracked.tail?.read();
    if (read?.reset && tracked.file) {
      // Replaced or cut short: start over as with a new transcript.
      tracked.state = emptyTranscript();
      Object.assign(tracked, this.openTranscript(tracked.file, tracked.state));
      read = tracked.tail?.read();
    }
    if (read) {
      if (read.reset) tracked.state = emptyTranscript();
      for (const line of read.lines) applyLine(tracked.state, line);
      tracked.writtenAt = Math.round(read.mtimeMs);
    }
    return tracked.state;
  }

  /**
   * When the session last wrote to its transcript, or to one of its
   * subagents' transcripts: a subagent at work leaves the main one silent.
   */
  private lastWrite(id: string, now: number): number | undefined {
    const main = this.tracked.get(id)?.writtenAt;
    if (main === undefined || now - main < SUBAGENT_CHECK_AFTER_MS) return main;
    return Math.max(main, this.subagentFiles(id)[0]?.mtimeMs ?? main);
  }

  /** The subagents' transcripts of a session, newest first. */
  private subagentFiles(id: string): { file: string; mtimeMs: number }[] {
    const tracked = this.tracked.get(id);
    if (!tracked?.file) return [];
    const dir = path.join(path.dirname(tracked.file), id, "subagents");
    const files: { file: string; mtimeMs: number }[] = [];
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        files.push({ file, mtimeMs: Math.round(fs.statSync(file).mtimeMs) });
      }
    } catch {
      // No subagents, or one just went away.
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * The tool call a subagent of this session has open: the subagent that
   * asked is the one that wrote last, before it stopped to wait.
   */
  private subagentTool(id: string): OpenTool | undefined {
    const newest = this.subagentFiles(id)[0];
    if (!newest) return undefined;
    if (this.subagentCall?.file === newest.file && this.subagentCall.mtimeMs === newest.mtimeMs) return this.subagentCall.tool;
    const state = emptyTranscript();
    for (const line of new JsonlTail(newest.file, { backfillBytes: SUBAGENT_TAIL_BYTES }).read()?.lines ?? []) applyLine(state, line, true);
    const tool = [...state.openTools.values()][0];
    this.subagentCall = { ...newest, tool };
    return tool;
  }

  /** The title of the session's plan, from Claude Code's plan file. */
  private planTitle(slug: string): string | undefined {
    if (!/^[\w.-]+$/.test(slug)) return undefined;
    const file = path.join(this.configDir, "plans", `${slug}.md`);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    const cached = this.plans.get(file);
    if (cached?.mtimeMs === mtimeMs) return cached.title;
    const title = planFileTitle(file);
    this.plans.set(file, { mtimeMs, title });
    return title;
  }

  /**
   * Starts reading at Claude Code's last cost checkpoint, so the spend is
   * complete, unless that is too far back; then the last megabyte is read and
   * the spend is marked partial.
   */
  private openTranscript(file: string, state: TranscriptState): { tail: JsonlTail } {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // Opening the tail reports the missing file.
    }
    if (size <= BACKFILL_BYTES) return { tail: new JsonlTail(file, { startAt: 0 }) };
    seedTitles(file, state);
    const checkpoint = findLastLine(file, '"type":"cost-state"', CHECKPOINT_SEARCH_BYTES);
    if (checkpoint !== undefined && size - checkpoint <= CHECKPOINT_READ_BYTES) {
      // Claude Code writes a checkpoint right after a turn's last reply; read
      // from that reply so the board still knows what the session last said
      // and asked. Usage before the checkpoint is dropped when it is read.
      const reply = findLastLine(file, '"type":"assistant"', CHECKPOINT_SEARCH_BYTES);
      const start = reply !== undefined && size - reply <= CHECKPOINT_READ_BYTES ? Math.min(reply, checkpoint) : checkpoint;
      return { tail: new JsonlTail(file, { startAt: start }) };
    }
    state.joinedLate = true;
    return { tail: new JsonlTail(file, { startAt: lineStartAtOrAfter(file, size - BACKFILL_BYTES) }) };
  }
}
