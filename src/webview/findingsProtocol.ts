import type { HistoryMessage } from "../core/history";

/** A message with its position in the conversation. */
export interface FindingsMessage extends HistoryMessage {
  index: number;
}

/** Extension → findings tab: a session's whole conversation. */
export type ToFindings = {
  type: "conversation";
  /** `where`: the session's project, worktree and git branch, e.g. "api · ⎇ fix-login". */
  session: { id: string; title: string; where?: string; agent?: string };
  messages: FindingsMessage[];
  /** The search to apply; the tab keeps its own afterwards. */
  query: string;
  /** The message to scroll to and outline; none means the newest match, or the end. */
  target: number | undefined;
  /** Tell the agents apart: the agent's mark and name in the heading. */
  markers?: boolean;
};

/** Findings tab → extension. */
export type FromFindings = { type: "ready" } | { type: "jump"; id: string };
