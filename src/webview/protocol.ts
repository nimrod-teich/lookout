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
export type ToBoard = { type: "sessions"; sessions: SessionView[]; now: number; usage?: BoardUsage };

/** Webview → extension. */
export type FromBoard =
  | { type: "ready" }
  | { type: "jump"; id: string }
  | { type: "rename"; id: string }
  | { type: "remote"; id: string }
  | { type: "seen"; id: string }
  | { type: "seenAll" }
  | { type: "refreshUsage" };
