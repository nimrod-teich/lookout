import type { SearchResult } from "../core/history";
import type { PastView, SessionView } from "../core/types";
import type { UsageMeter } from "../core/usage";

export interface BoardUsage {
  fetchedAt: number;
  stale: boolean;
  meters: UsageMeter[];
  /** The extension can fetch fresh numbers. */
  canRefresh: boolean;
}

/** Extension → webview. */
export type ToBoard =
  | { type: "sessions"; sessions: SessionView[]; past: PastView[]; now: number; usage?: BoardUsage }
  /** `pending` sessions were not read yet; the board asks again. */
  | { type: "search"; query: string; results: SearchResult[]; pending: number };

/** Webview → extension. */
export type FromBoard =
  | { type: "ready" }
  | { type: "jump"; id: string }
  | { type: "rename"; id: string }
  | { type: "seen"; id: string }
  /** Dismiss the question the session's last message asks. */
  | { type: "dismiss"; id: string }
  | { type: "seenAll" }
  | { type: "refreshUsage" }
  | { type: "search"; query: string }
  /** Open the session's conversation in the findings tab, at one message or at the newest match. */
  | { type: "openHit"; query: string; id: string; index?: number }
  /** Resume a session that is not running, in the agent's panel. */
  | { type: "resume"; id: string };
