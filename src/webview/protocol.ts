import type { SearchResult } from "../core/history";
import type { PastView, SessionView } from "../core/types";
import type { Pace } from "../core/pace";
import type { UsageMeter } from "../core/usage";

export interface BoardUsage {
  /** Epoch ms the numbers were fetched; none when there are no numbers to show. */
  fetchedAt?: number;
  /** Old, and nothing will bring them up to date. */
  stale: boolean;
  meters: UsageMeter[];
  /** Pace per meter key, where the readings allow one. */
  pace: Record<string, Pace>;
  /** The extension can fetch fresh numbers. */
  canRefresh: boolean;
  /** Why the numbers are not kept fresh, when that needs saying. */
  note?: string;
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
