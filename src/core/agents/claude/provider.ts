import * as fs from "node:fs";
import { HistoryIndex, termsOf, type HistoryMessage, type SearchResult } from "../../history";
import { findLastLine, JsonlTail, readLineAt } from "../../jsonlTail";
import { messageOf } from "./history";
import { PastTranscripts } from "./past";
import type { ProcessTable } from "../../proc";
import type { AgentProvider, AgentSession, AgentStatus, PastSession, SearchOutcome } from "../agent";
import { findTranscript, sessionsDir } from "./paths";
import { SessionRegistry } from "./registry";
import type { SessionFile } from "./sessionFile";
import { activityOf, agentsOf, applyLine, contextWindowOf, emptyTranscript, pulseOf, spendOf, titleOf, type TranscriptState } from "./transcript";

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

interface Tracked {
  tail?: JsonlTail;
  state: TranscriptState;
  nextLookupAt: number;
  /** The transcript file, once found. */
  file?: string;
  /** Its messages, built on the first search. */
  history?: HistoryIndex;
}

/** A process in its first minute has not written its state yet; it is idle, not unknown. */
const STARTING_MS = 60_000;

function statusOf(file: SessionFile, now: number): AgentStatus {
  switch (file.status) {
    case "busy":
      return "working";
    case "waiting":
      return "waiting";
    case "idle":
    case "shell":
      return "idle";
    default:
      return file.startedAt !== undefined && now - file.startedAt < STARTING_MS ? "idle" : "unknown";
  }
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
        needs: status === "waiting" ? (file.needs ?? file.waitingFor) : undefined,
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
    }
    return tracked.state;
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
    if (checkpoint !== undefined && size - checkpoint <= CHECKPOINT_READ_BYTES) return new JsonlTail(file, { startAt: checkpoint });
    state.joinedLate = true;
    return new JsonlTail(file, { backfillBytes: BACKFILL_BYTES });
  }
}
