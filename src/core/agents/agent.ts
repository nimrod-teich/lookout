import type { HistoryMessage, SearchResult } from "../history";
import type { Evidence, PromptCache, Reason, TypedQuestion } from "../types";

export type AgentStatus = "working" | "waiting" | "idle" | "unknown";

/** One live session, as an agent provider reports it. */
export interface AgentSession {
  /** Id of the provider that reported it. */
  agent: string;
  id: string;
  pid: number;
  status: AgentStatus;
  /** Why the session waits for the user, when it does. */
  reason?: Reason;
  /** Where the status comes from, and how old that is. */
  evidence?: Evidence;
  /** The question the session's last message asks, while it is idle. */
  question?: TypedQuestion;
  /** Epoch ms the session last wrote to its transcript. */
  lastWriteAt?: number;
  /** Epoch ms of the last status change. */
  since?: number;
  title?: string;
  /** The session's current directory. */
  cwd: string;
  /** Runs in the agent's own editor panel, as opposed to a terminal. */
  panel: boolean;
  /** What the session is doing right now, e.g. "Bash · npm test". */
  activity?: string;
  /** Subagents in flight. */
  agents?: number;
  /** First line of the assistant's latest message. */
  lastReply?: string;
  model?: string;
  /** Tokens in the context window at the last model call. */
  contextTokens?: number;
  /** Size of that window, when the agent knows it. */
  contextWindow?: number;
  /** Tool calls per minute over the last 15 minutes, oldest first. */
  pulse?: number[];
  /** Indices into `pulse` of the minutes the conversation was compacted. */
  pulseMarks?: number[];
  /** Times the agent compacted the conversation. */
  compactions?: number;
  /** Epoch ms of the last compaction. */
  compactedAt?: number;
  /** The model's prompt cache, as the agent's last call left it. */
  cache?: PromptCache;
  /** Tokens the session used so far, and what they cost. */
  spend?: SessionSpend;
}

export interface SessionSpend {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD at list prices; undefined when a model's prices are unknown. */
  costUsd: number | undefined;
  /** Part of the total is an estimate rather than the agent's own figure. */
  estimated: boolean;
  /** Earlier usage is missing: the transcript was joined late. */
  partial: boolean;
}

/** A session that is not running, known from its transcript. */
export interface PastSession {
  /** Id of the provider that reported it. */
  agent: string;
  id: string;
  cwd: string;
  title: string;
  /** Epoch ms the transcript was last written. */
  modifiedAt: number;
}

/** A search's outcome: the sessions with matches, and how many were not read within the time given. */
export interface SearchOutcome {
  results: SearchResult[];
  pending: number;
}

/**
 * A coding agent Lookout can watch. A provider turns whatever the agent
 * records about its sessions into `AgentSession`s; everything after that
 * (location, ordering, the UI) is the same for every agent.
 */
export interface AgentProvider {
  readonly id: string;
  /** Name shown to the user. */
  readonly label: string;
  /** The sessions that are alive right now. */
  poll(now: number): AgentSession[];
  /**
   * Calls `listener` when a session may have changed, so a poll can follow at
   * once instead of at the next interval. Returns nothing when the agent's
   * records can't be watched, in which case polling alone keeps up.
   */
  watch?(listener: () => void): { dispose(): void } | undefined;
  /**
   * Searches the conversations of the live and the past sessions: what the
   * user wrote and what the agent replied. Returns only sessions with matches,
   * each with its newest `limit` matches. A conversation not read yet is read
   * only while `budgetMs` allows; the rest are counted as pending.
   */
  search?(query: string, limit: number, budgetMs: number): SearchOutcome;
  /** The sessions of these working directories that are not running, newest first, without the ids in `exclude`. */
  past?(cwds: readonly string[], exclude: ReadonlySet<string>): PastSession[];
  /** The conversation of one live session, oldest first; undefined when the agent keeps no transcript for it. */
  history?(id: string): HistoryMessage[] | undefined;
}
