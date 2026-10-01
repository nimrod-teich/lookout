/**
 * What a session is doing. "done" is Lookout's own state: a session of this
 * window that finished a turn the user has not looked at yet.
 */
export type State = "waiting" | "done" | "working" | "unknown" | "idle";

/** Where a session runs, relative to the window Lookout serves. */
export type Host = "panel" | "terminal" | "elsewhere";

/** What the UI shows for one session. */
export interface SessionView {
  id: string;
  /** Id of the agent provider the session belongs to. */
  agent: string;
  pid: number;
  title: string;
  state: State;
  /** Epoch ms of the last state change. */
  since?: number;
  /** Why the session waits for the user, when it does. */
  needs?: string;
  project: string;
  worktree?: string;
  cwd: string;
  host: Host;
  /** Shell pid of the integrated terminal the session runs in, when `host` is "terminal". */
  terminalPid?: number;
}
