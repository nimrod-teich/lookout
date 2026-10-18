import type { SearchHit } from "../core/history";

/** A session with matches, as the search page lists it. */
export interface SearchPageSession {
  id: string;
  title: string;
  /** Id of its agent. */
  agent?: string;
  /** Its project, worktree and git branch, e.g. "api · ⎇ fix-login". */
  where?: string;
  /** Running now, as opposed to earlier. */
  live: boolean;
  /** Epoch ms of its first and its last message. */
  started?: number;
  lastActive?: number;
  /** How many of its messages match; operators alone pick sessions without words to match. */
  count: number;
  /** The newest matches, cut wide. */
  hits: SearchHit[];
}

/** Extension → search page. */
export type ToSearch =
  /** Put this query in the box and run it. */
  | { type: "query"; query: string }
  /** `pending` conversations were not read yet; the page asks again. */
  /** `markers`: tell the agents apart. */
  | { type: "results"; query: string; sessions: SearchPageSession[]; pending: number; markers?: boolean };

/** Search page → extension. */
export type FromSearch =
  | { type: "ready" }
  /** `zone`: the page's time zone, minutes behind UTC, for the days the query names. */
  | { type: "search"; query: string; zone?: number }
  /** Open a session's conversation in the conversation tab, at a message or at its newest match. */
  | { type: "open"; query: string; id: string; index?: number };
