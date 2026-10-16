import type { SearchResult } from "../core/history";
import type { SessionView } from "../core/types";
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
  | { type: "sessions"; sessions: SessionView[]; now: number; usage?: BoardUsage }
  | { type: "search"; query: string; results: SearchResult[] };

/** Webview → extension. */
export type FromBoard =
  | { type: "ready" }
  | { type: "jump"; id: string }
  | { type: "rename"; id: string }
  | { type: "seen"; id: string }
  | { type: "seenAll" }
  | { type: "refreshUsage" }
  | { type: "search"; query: string }
  /** Open the session's conversation in the findings tab, at one message or at the newest match. */
  | { type: "openHit"; query: string; id: string; index?: number };
