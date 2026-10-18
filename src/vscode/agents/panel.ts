import type { SessionView } from "../../core/types";
import type { Log } from "../log";

export type PanelReveal = "revealed" | "revealed-by-tab" | "refused-invalid" | "failed";

/** How Lookout reaches the sessions an agent hosts in its own editor panel. */
export interface PanelAdapter {
  /** Brings the session's tab to the front, at its newest message. Called only for sessions this window hosts. */
  reveal(view: SessionView, log: Log): Promise<PanelReveal>;
  /** The session's tab is the one in front. */
  isActive(view: SessionView): boolean;
  /**
   * Lets the user rename the session through the agent's own rename, which
   * writes the new title where the agent keeps it. Called only for sessions
   * this window hosts. Resolves false when the agent's rename could not be reached.
   */
  rename(view: SessionView, log: Log): Promise<boolean>;
  /** Opens a session that is not running in the agent's panel, where the agent resumes it. Resolves false when it could not. */
  resume(id: string, log: Log): Promise<boolean>;
}
