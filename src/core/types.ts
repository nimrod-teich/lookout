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

/**
 * Why a session needs the user: a permission prompt, a question, a plan to
 * approve, any other dialog, or a question typed at the end of a turn. The
 * last is Lookout's own reading of the reply, so it is less certain.
 */
export type ReasonKind = "permission" | "question" | "plan" | "dialog" | "typed";

export interface Reason {
  kind: ReasonKind;
  /** What the session asks, quoted: Markdown stripped, at most 160 characters. */
  ask: string;
  /** The answers a question offers. */
  options?: string[];
  /** The agent's own word for the wait, e.g. "permission prompt" or "sandbox request". */
  raw?: string;
  /** Only the agent's word is known yet; its transcript may say more a moment later. */
  tentative?: boolean;
}

/** Where a session's state comes from, and how old that is. */
export interface Evidence {
  source: "session file" | "transcript" | "process";
  /** Epoch ms the source was written, when known. */
  at?: number;
  /** What the source says, when the state needs explaining, e.g. "records no state". */
  note?: string;
}

/** A question the agent's last message asks the user. */
export interface TypedQuestion {
  /** The question, quoted: Markdown stripped, at most 160 characters. */
  text: string;
  /** Epoch ms of the message, when known. */
  at?: number;
}

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
  /** Why the session needs the user, when it does. */
  reason?: Reason;
  /** Where the state comes from. */
  evidence?: Evidence;
  /** The question its last message asks, while it is idle. */
  question?: TypedQuestion;
  /** Epoch ms the session last wrote to its transcript. */
  lastWriteAt?: number;
  project: string;
  worktree?: string;
  cwd: string;
  host: Host;
  /** Shell pid of the integrated terminal the session runs in, when `host` is "terminal". */
  terminalPid?: number;
  /** Name of the other VS Code window the session runs in, when `host` is "window". */
  windowLabel?: string;
  /** Extension host pid of that window: where a jump to the session is sent. */
  windowPid?: number;
  /** What the session is doing right now, e.g. "Bash · npm test". */
  activity?: string;
  /** Subagents in flight. */
  agents: number;
  /** The git branch it works on. */
  branch?: string;
  model?: string;
  /** The reasoning effort the model last answered with. */
  effort?: string;
  /** Tokens in the context window at the last model call. */
  contextTokens?: number;
  /** Size of that window, when the agent knows it. */
  contextWindow?: number;
  /** Tool calls per minute over the last 15 minutes, oldest first. */
  pulse?: number[];
  /** Indices into `pulse` of the minutes the conversation was compacted. */
  pulseMarks?: number[];
  /** Tokens the session used so far, and what they cost. */
  spend?: SessionSpend;
}

/** A session that is not running, shown collapsed under the live ones. */
export interface PastView {
  id: string;
  agent: string;
  title: string;
  project: string;
  worktree?: string;
  /** The git branch it last worked on. */
  branch?: string;
  cwd: string;
  /** The agent can resume it in this window; else it runs again from a window open on its folder. */
  resumable: boolean;
  /** Epoch ms the transcript was last written. */
  modifiedAt: number;
}

export interface SessionSpend {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD at list prices; undefined when a model's prices are unknown. */
  costUsd: number | undefined;
  /** Part of the total is an estimate rather than the agent's own figure. */
  estimated: boolean;
  /** Earlier usage is missing: the transcript was joined late. */
  partial: boolean;
}
