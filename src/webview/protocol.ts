import type { SessionView } from "../core/types";

/** Extension → webview. */
export type ToBoard = { type: "sessions"; sessions: SessionView[]; now: number };

/** Webview → extension. */
export type FromBoard = { type: "ready" } | { type: "jump"; id: string } | { type: "seen"; id: string } | { type: "seenAll" };
