export type AgentStatus = "working" | "waiting" | "idle" | "unknown";

/** One live session, as an agent provider reports it. */
export interface AgentSession {
  /** Id of the provider that reported it. */
  agent: string;
  id: string;
  pid: number;
  status: AgentStatus;
  /** Why the session waits for the user, when it does. */
  needs?: string;
  /** Epoch ms of the last status change. */
  since?: number;
  title?: string;
  /** The session's current directory. */
  cwd: string;
  /** Runs in the agent's own editor panel, as opposed to a terminal. */
  panel: boolean;
}

/**
 * A coding agent Lookout can watch. A provider turns whatever the agent
 * records about its sessions into `AgentSession`s; everything after that
 * (location, ordering, the UI) is the same for every agent.
 */
export interface AgentProvider {
  readonly id: string;
  /** Name shown to the user. */
  readonly label: string;
  /** The sessions that are alive right now. */
  poll(now: number): AgentSession[];
  /**
   * Calls `listener` when a session may have changed, so a poll can follow at
   * once instead of at the next interval. Returns nothing when the agent's
   * records can't be watched, in which case polling alone keeps up.
   */
  watch?(listener: () => void): { dispose(): void } | undefined;
}
