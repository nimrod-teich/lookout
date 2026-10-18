import type { HistoryMessage, SearchResult, SnippetSize } from "../history";
import type { Query } from "../terms";
import type { Evidence, Reason, TypedQuestion } from "../types";

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
  /** The git branch it works on. */
  branch?: string;
  model?: string;
  /** The reasoning effort the model last answered with. */
  effort?: string;
  /** Tokens in the context window at the last model call. */
  contextTokens?: number;
  /** Size of that window, when the agent knows it. */
  contextWindow?: number;
  /** Tool calls per minute over the last 15 minutes, oldest first. */
  pulse?: number[];
  /** Indices into `pulse` of the minutes the conversation was compacted. */
  pulseMarks?: number[];
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
  /** The git branch it last worked on. */
  branch?: string;
  /** The agent can resume it in this window: it belongs to one of the window's folders. */
  resumable: boolean;
  /** Epoch ms the transcript was last written. */
  modifiedAt: number;
}

/** Which past sessions to list: those of this window's folders, or of every project; at most `limit`, the newest. */
export interface PastScope {
  /** This window's folders. */
  folders: readonly string[];
  /** Every project's sessions, not only the folders'. */
  all: boolean;
  limit: number;
  /** Sessions to list besides, by id, wherever they ran: the ones the user starred. */
  also?: readonly string[];
}

/** Past sessions; `capped` when the scope holds older ones beyond the limit, left out. */
export interface PastList {
  sessions: PastSession[];
  capped: boolean;
  /** Some transcripts were left for the next list, to keep this one quick: list again soon. */
  incomplete: boolean;
  /** The sessions of `scope.also` that `sessions` does not hold. */
  also: PastSession[];
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
   * user wrote and what the agent replied, narrowed by the query's operators.
   * Returns only sessions with matches, each with its newest `limit` matches,
   * or, for a query of operators alone, the sessions they pick. A
   * conversation not read yet is read only while `budgetMs` allows; the rest
   * are counted as pending.
   */
  search?(query: Query, limit: number, budgetMs: number, snippet?: SnippetSize): SearchOutcome;
  /** The sessions of the scope that are not running, newest first, without the ids in `exclude`. */
  past?(scope: PastScope, exclude: ReadonlySet<string>): PastList;
  /** The conversation of one live session, oldest first; undefined when the agent keeps no transcript for it. */
  history?(id: string): HistoryMessage[] | undefined;
}
