import * as fs from "node:fs";
import * as path from "node:path";
import { HistoryIndex, termsOf, type HistoryMessage, type SearchResult } from "../../history";
import { findLastLine, JsonlTail, readLineAt } from "../../jsonlTail";
import { messageOf } from "./history";
import { PastTranscripts } from "./past";
import type { ProcessTable } from "../../proc";
import type { Evidence } from "../../types";
import type { AgentProvider, AgentSession, AgentStatus, PastSession, SearchOutcome } from "../agent";
import { findTranscript, sessionsDir } from "./paths";
import { SessionRegistry } from "./registry";
import type { SessionFile } from "./sessionFile";
import { activityOf, agentsOf, applyLine, contextWindowOf, emptyTranscript, pulseOf, spendOf, titleOf, type OpenTool, type TranscriptState } from "./transcript";
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
  /** Its messages, built on the first search. */
  history?: HistoryIndex;
  /** Epoch ms the transcript was last modified. */
  writtenAt?: number;
}

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
  private readonly pastIndexes = new Map<string, HistoryIndex>();
  /** Plan titles by file, read again when the file changes. */
  private readonly plans = new Map<string, { mtimeMs: number; title: string | undefined }>();
  /** The open tool call of the subagent transcript last read, by file version. */
  private subagentCall: { file: string; mtimeMs: number; tool: OpenTool | undefined } | undefined;

  constructor(
    private readonly configDir: string,
    proc: ProcessTable,
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
      const status = statusOf(file, now);
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
        activity: status === "working" ? activityOf(transcript) : undefined,
        agents: status === "working" ? agentsOf(transcript) : 0,
        lastReply: transcript.lastReply,
        model: transcript.model,
        contextTokens: transcript.contextTokens,
        contextWindow: contextWindowOf(transcript.model, transcript.contextTokens),
        pulse: pulseOf(transcript, now, file.startedAt),
        spend: spendOf(transcript),
      };
    });
    for (const id of this.tracked.keys()) if (!live.has(id)) this.tracked.delete(id);
    return sessions;
  }

  past(cwds: readonly string[], exclude: ReadonlySet<string>): PastSession[] {
    const list = this.pastTranscripts.list(cwds, exclude);
    this.pastFiles = new Map(list.map((p) => [p.id, p.file]));
    for (const id of [...this.pastIndexes.keys()]) if (!this.pastFiles.has(id)) this.pastIndexes.delete(id);
    return list.map((p) => ({ agent: this.id, id: p.id, cwd: p.cwd, title: p.title, modifiedAt: p.modifiedAt }));
  }

  /**
   * Searches the live and the past sessions' transcripts. Each is read into
   * memory on its first search, then only what was appended; a first read
   * happens only while the budget allows, the live sessions first.
   */
  search(query: string, limit: number, budgetMs: number): SearchOutcome {
    const terms = termsOf(query);
    if (terms.length === 0) return { results: [], pending: 0 };
    const started = Date.now();
    const results: SearchResult[] = [];
    let pending = 0;
    for (const id of [...this.tracked.keys(), ...this.pastFiles.keys()]) {
      const index = this.indexFor(id);
      if (!index) continue;
      if (!index.ready && Date.now() - started >= budgetMs) {
        pending++;
        continue;
      }
      index.refresh();
      const { count, hits } = index.search(terms, limit);
      if (count > 0) results.push({ id, count, hits });
    }
    return { results, pending };
  }

  history(id: string): HistoryMessage[] | undefined {
    const index = this.indexFor(id);
    if (!index) return undefined;
    index.refresh();
    return index.messages;
  }

  /** The session's conversation index, live or past; nothing until its transcript is known. */
  private indexFor(id: string): HistoryIndex | undefined {
    const tracked = this.tracked.get(id);
    if (tracked) {
      if (!tracked.file) return undefined;
      tracked.history ??= new HistoryIndex(tracked.file, messageOf);
      return tracked.history;
    }
    const file = this.pastFiles.get(id);
    if (!file) return undefined;
    let index = this.pastIndexes.get(id);
    if (!index) {
      index = new HistoryIndex(file, messageOf);
      this.pastIndexes.set(id, index);
    }
    return index;
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
        tracked.tail = this.openTranscript(transcript, tracked.state);
      } else tracked.nextLookupAt = now + TRANSCRIPT_LOOKUP_MS;
    }
    const read = tracked.tail?.read();
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
  private openTranscript(file: string, state: TranscriptState): JsonlTail {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // Opening the tail reports the missing file.
    }
    if (size <= BACKFILL_BYTES) return new JsonlTail(file, { startAt: 0 });
    // Whatever is skipped, the title must not be: Claude Code stamps it once,
    // and again on resume just before a checkpoint.
    seedTitles(file, state);
    const checkpoint = findLastLine(file, '"type":"cost-state"', CHECKPOINT_SEARCH_BYTES);
    if (checkpoint !== undefined && size - checkpoint <= CHECKPOINT_READ_BYTES) {
      // Claude Code writes a checkpoint right after a turn's last reply; read
      // from that reply so the board still knows what the session last said
      // and asked. Usage before the checkpoint is dropped when it is read.
      const reply = findLastLine(file, '"type":"assistant"', CHECKPOINT_SEARCH_BYTES);
      const start = reply !== undefined && size - reply <= CHECKPOINT_READ_BYTES ? Math.min(reply, checkpoint) : checkpoint;
      return new JsonlTail(file, { startAt: start });
    }
    state.joinedLate = true;
    return new JsonlTail(file, { backfillBytes: BACKFILL_BYTES });
  }
}
