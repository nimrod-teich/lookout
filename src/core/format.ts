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

/** One line saying what a session is doing and for how long, e.g. "Needs you for 12m: permission prompt". */
export function describeState(view: SessionView, now: number): string {
  const elapsed = view.since === undefined ? undefined : formatElapsed(now - view.since);
  switch (view.state) {
    case "waiting":
      return `${elapsed ? `Needs you for ${elapsed}` : "Needs you"}: ${view.needs ?? "input"}`;
    case "done":
      return elapsed ? `Finished ${elapsed} ago` : "Finished";
    case "working":
      return elapsed ? `Working for ${elapsed}` : "Working";
    case "idle":
      return elapsed ? `Idle for ${elapsed}` : "Idle";
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

/** "850", "190k", "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "claude-fable-5-1[1m]" → "Fable 5.1"; unknown ids are returned as they are. */
export function shortModel(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (!match) return id;
  const family = match[1]!;
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${match[2]}.${match[3]}`;
}

/** "$0.42", "$118", "$1.2k". */
export function formatUsd(usd: number): string {
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${Math.round(usd)}`;
  return `$${(usd / 1000).toFixed(1)}k`;
}
