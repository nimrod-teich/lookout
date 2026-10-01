import type { SessionView, State } from "./types";

/** "45s", "12m", "3h 05m", "2d". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

/** One line saying what a session is doing, e.g. "Needs you: permission prompt". */
export function describeState(view: SessionView): string {
  switch (view.state) {
    case "waiting":
      return `Needs you: ${view.needs ?? "input"}`;
    case "done":
      return "Finished";
    case "working":
      return "Working";
    case "idle":
      return "Idle";
    case "unknown":
      return "State unknown";
  }
}

/** "app" or, in a worktree, "app · fix-x". */
export function describeLocation(view: SessionView): string {
  return view.worktree ? `${view.project} · ${view.worktree}` : view.project;
}

export type Counts = Record<State, number>;

export function countStates(views: readonly SessionView[]): Counts {
  const counts: Counts = { waiting: 0, done: 0, working: 0, unknown: 0, idle: 0 };
  for (const view of views) counts[view.state]++;
  return counts;
}
