import type { BackgroundReads } from "../background";
import type { HistoryMessage, SearchResult, SnippetSize } from "../history";
import type { Query } from "../terms";
import type { UsageSnapshot } from "../usage";
import type { Background, Evidence, Reason, TypedQuestion } from "../types";
export type { Background };

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
  /**
   * VS Code's address for the session, when VS Code runs it in its Chat view
   * through its agent host (`agent-host-copilotcli:/<id>`): a jump opens it
   * there, and its folder says which window's it is.
   */
  vscodeSession?: string;
  /** Nothing sent yet: an open tab or terminal without a conversation. */
  empty?: boolean;
  /** What the session is doing right now, e.g. "Bash · npm test". */
  activity?: string;
  /** Subagents in flight. */
  agents?: number;
  /** The git branch it works on. */
  branch?: string;
  model?: string;
  /** Shell commands it left running after its turn: it counts as working while they run. */
  background?: Background;
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
  /** How the price was reached, when not as for Claude: said in the card's hover. */
  basis?: string;
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
  /** Where it resumes, when not where its agent's sessions do: a Codex thread of the VS Code extension resumes in its panel. */
  resumesIn?: "panel" | "terminal";
  /** VS Code's address for it, when VS Code ran it in its Chat view: a resume opens it there. */
  vscodeSession?: string;
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
  /** What the list leaves out and why, said under the Earlier group. */
  notes?: string[];
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
   * or, for a query of operators alone, the sessions they pick. With
   * `background`, conversations are read there and those not read yet are
   * counted as pending; without, a conversation not read yet is read here
   * only while `budgetMs` allows, and the rest are counted as pending.
   */
  search?(query: Query, limit: number, budgetMs: number, snippet?: SnippetSize, background?: BackgroundReads): SearchOutcome;
  /** Has `background` read the conversations the search covers, before anyone searches. */
  readAhead?(background: BackgroundReads): void;
  /** The sessions of the scope that are not running, newest first, without the ids in `exclude`. */
  past?(scope: PastScope, exclude: ReadonlySet<string>): PastList;
  /**
   * The conversation of one live session, oldest first; undefined when the
   * agent keeps no transcript for it. With `background`, what it gained is
   * read there, and shows on a later call.
   */
  history?(id: string, background?: BackgroundReads): HistoryMessage[] | undefined;
  /**
   * How to resume a session that is not running in a terminal: the command
   * and the folder to run it in. For agents whose sessions resume in a
   * terminal rather than in an editor panel.
   */
  resumeCommand?(id: string): ResumeCommand | undefined;
  /**
   * The account's limits, for agents that record them where Lookout can read
   * them: when they were read, and the meters.
   */
  usage?(now: number): UsageSnapshot | undefined;
}

/** A command that resumes a session in a terminal. */
export interface ResumeCommand {
  /** The program and its arguments, run as they are. */
  args: string[];
  cwd: string;
}
