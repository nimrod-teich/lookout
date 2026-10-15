// Pure helpers for the board; no DOM here so they can be tested under Node.
import type { SessionView, State } from "../core/types";

export interface Group {
  key: "waiting" | "done" | "working" | "idle";
  label: string;
  views: SessionView[];
}

const GROUP_OF: Record<State, Group["key"]> = { waiting: "waiting", done: "done", working: "working", unknown: "idle", idle: "idle" };
const LABELS: Record<Group["key"], string> = { waiting: "Needs you", done: "Finished", working: "Working", idle: "Idle" };
const ORDER: Group["key"][] = ["waiting", "done", "working", "idle"];

/** The sessions by group, in display order, without empty groups. The input is already sorted. */
export function groupSessions(views: readonly SessionView[]): Group[] {
  const groups = new Map<Group["key"], SessionView[]>();
  for (const view of views) {
    const key = GROUP_OF[view.state];
    const list = groups.get(key) ?? [];
    list.push(view);
    groups.set(key, list);
  }
  return ORDER.filter((key) => groups.has(key)).map((key) => ({ key, label: LABELS[key], views: groups.get(key)! }));
}

/** Where a session runs, for its chip; nothing for the window's own panel. */
export function hostChip(view: SessionView): string | undefined {
  switch (view.host) {
    case "terminal":
      return "terminal";
    case "window":
      return view.windowLabel ? `window: ${view.windowLabel}` : "another window";
    case "elsewhere":
      return "outside VS Code";
    default:
      return undefined;
  }
}

/** The second line of a card: what the session does, needs, or last said. */
export function secondLine(view: SessionView): string | undefined {
  switch (view.state) {
    case "waiting":
      return view.needs ?? "input needed";
    case "working":
      return view.activity ?? "thinking";
    case "done":
    case "idle":
      return view.lastReply;
    case "unknown":
      return undefined;
  }
}

/** Geometry of the harbour scene, in SVG units. The lighthouse stands on the left shore. */
export const HARBOUR = {
  width: 300,
  height: 156,
  lampX: 37,
  lampY: 50,
  /** Top of the sea when the 5-hour usage is 0%. */
  seaTop: 94,
  /** Top of the sea when it is 100%: the tide comes in. */
  seaTopFull: 70,
  /** Boats float between these distances from the shore. */
  nearX: 72,
  farX: 284,
};

/** How far below the waterline each group's boats float. */
const LANES: Record<Group["key"], number> = { waiting: 8, working: 17, done: 26, idle: 35 };
/** The far edge of the harbour means this long in a state. */
const MAX_MINUTES = 240;

/** Where the sea begins for a given 5-hour usage; the tide rises with it. */
export function waterline(usagePercent: number | undefined): number {
  const t = Math.min(100, Math.max(0, usagePercent ?? 0)) / 100;
  return Math.round((HARBOUR.seaTop - (HARBOUR.seaTop - HARBOUR.seaTopFull) * t) * 10) / 10;
}

export interface Boat {
  id: string;
  x: number;
  y: number;
  state: State;
  title: string;
  /** Shown on the water, for the sessions that need the user. */
  label?: string;
  /** Degrees below the horizontal, seen from the lamp. */
  bearing: number;
}

/**
 * Places the sessions on the water: the time in state sets the distance from
 * the shore (log scale: the first minutes spread out, hours still fit), the
 * state picks the lane. Sessions that need the user carry their title.
 */
export function layoutBoats(views: readonly SessionView[], now: number, water: number): Boat[] {
  const boats: Boat[] = [];
  for (const group of groupSessions(views)) {
    group.views.forEach((view, i) => {
      const minutes = view.since === undefined ? 0 : Math.max(0, now - view.since) / 60_000;
      const t = Math.min(1, Math.log10(1 + minutes) / Math.log10(1 + MAX_MINUTES));
      // Boats of one lane with the same age would stack; stagger them a little.
      const x = Math.min(HARBOUR.farX, HARBOUR.nearX + (HARBOUR.farX - HARBOUR.nearX) * t + (i % 3) * 7);
      const y = water + LANES[group.key] + (i % 2) * 3;
      const label = group.key === "waiting" && i < 2 ? `${view.title} · ${view.since === undefined ? "" : elapsed(now - view.since)}`.replace(/ · $/, "") : undefined;
      boats.push({
        id: view.id,
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        state: view.state,
        title: view.title,
        label,
        bearing: Math.round((Math.atan2(y - HARBOUR.lampY, x - HARBOUR.lampX) * 180) / Math.PI),
      });
    });
  }
  return boats;
}

function elapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
