/**
 * What a session is doing. "done" is Lookout's own state: a session of this
 * window that finished a turn the user has not looked at yet.
 */
export type State = "waiting" | "done" | "working" | "unknown" | "idle";

/**
 * Where a session runs, relative to the window Lookout serves: in its agent
 * panel, in one of its terminals, in another VS Code window, or outside VS Code.
 */
export type Host = "panel" | "terminal" | "window" | "elsewhere";

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
  /** Name of the other VS Code window the session runs in, when `host` is "window". */
  windowLabel?: string;
  /** What the session is doing right now, e.g. "Bash · npm test". */
  activity?: string;
  /** Subagents in flight. */
  agents: number;
  /** First line of the assistant's latest message. */
  lastReply?: string;
  model?: string;
  /** Tokens in the context window at the last model call. */
  contextTokens?: number;
  /** Size of that window, when the agent knows it. */
  contextWindow?: number;
  /** Tool calls per minute over the last 15 minutes, oldest first. */
  pulse?: number[];
  /** The states the session went through in the last hour, oldest first, as this window saw them. */
  history?: { state: State; at: number }[];
}
