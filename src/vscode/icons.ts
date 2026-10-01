import type { State } from "../core/types";

/** Codicon for each session state; `~spin` animates in the VS Code UI. */
export const STATE_ICON: Record<State, string> = {
  waiting: "$(bell-dot)",
  done: "$(check)",
  working: "$(loading~spin)",
  unknown: "$(question)",
  idle: "$(circle-outline)",
};
