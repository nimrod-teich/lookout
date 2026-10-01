import type { SessionView } from "../../core/types";
import type { Log } from "../log";

export type PanelReveal = "revealed" | "revealed-by-tab" | "refused-invalid" | "failed";

/** How Lookout reaches the sessions an agent hosts in its own editor panel. */
export interface PanelAdapter {
  /** Brings the session's tab to the front. Called only for sessions this window hosts. */
  reveal(view: SessionView, log: Log): Promise<PanelReveal>;
  /** The session's tab is the one in front. */
  isActive(view: SessionView): boolean;
}
