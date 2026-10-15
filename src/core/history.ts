import type { SessionView, State } from "./types";

/** A state a session entered, and when. */
export interface HistoryPoint {
  state: State;
  at: number;
}

/** How far back the history is kept. */
export const HISTORY_WINDOW_MS = 60 * 60_000;

/**
 * Remembers each session's run of states, from the moment Lookout first
 * sees it. Only the points inside the window, plus the one before it (which
 * says what the session was doing at the window's start), are kept.
 */
export class StateHistory {
  private readonly points = new Map<string, HistoryPoint[]>();

  /** Records the sessions' current states; call once per poll. */
  record(views: readonly SessionView[], now: number): void {
    const live = new Set<string>();
    for (const view of views) {
      live.add(view.id);
      const points = this.points.get(view.id) ?? [];
      const last = points.at(-1);
      if (!last || last.state !== view.state) points.push({ state: view.state, at: last ? now : (view.since ?? now) });
      this.points.set(view.id, this.prune(points, now));
    }
    for (const id of this.points.keys()) if (!live.has(id)) this.points.delete(id);
  }

  /** The session's points, oldest first; empty for an unknown session. */
  of(id: string): HistoryPoint[] {
    return [...(this.points.get(id) ?? [])];
  }

  private prune(points: HistoryPoint[], now: number): HistoryPoint[] {
    const start = now - HISTORY_WINDOW_MS;
    // Keep the last point before the window: it is the state at the window's start.
    let first = 0;
    for (let i = 0; i < points.length; i++) if (points[i]!.at <= start) first = i;
    return points.slice(first);
  }
}
