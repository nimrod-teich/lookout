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

/** Geometry of the beam strip, in SVG units. The lighthouse stands at the origin. */
export const BEAM = { width: 300, height: 112, originX: 150, originY: 100, minRadius: 26, maxRadius: 90 };

/** Where each state's blips go: an angle range from the vertical, negative to the left. */
const SECTORS: Record<Group["key"], [number, number]> = { waiting: [-68, -32], done: [-26, -4], working: [4, 38], idle: [44, 68] };
/** The outer edge of the strip means this long in a state. */
const MAX_MINUTES = 240;

export interface Blip {
  id: string;
  x: number;
  y: number;
  state: State;
  title: string;
}

/**
 * Places the sessions on the beam strip: the state picks the direction and
 * the time in that state the distance, on a log scale so the first minutes
 * are visible and hours still fit.
 */
export function layoutBlips(views: readonly SessionView[], now: number): Blip[] {
  const blips: Blip[] = [];
  for (const group of groupSessions(views)) {
    const [from, to] = SECTORS[group.key];
    group.views.forEach((view, i) => {
      const minutes = view.since === undefined ? 0 : Math.max(0, now - view.since) / 60_000;
      const t = Math.min(1, Math.log10(1 + minutes) / Math.log10(1 + MAX_MINUTES));
      const radius = BEAM.minRadius + (BEAM.maxRadius - BEAM.minRadius) * t;
      const angle = ((from + ((to - from) * (i + 1)) / (group.views.length + 1)) * Math.PI) / 180;
      blips.push({
        id: view.id,
        x: Math.round((BEAM.originX + radius * Math.sin(angle)) * 10) / 10,
        y: Math.round((BEAM.originY - radius * Math.cos(angle)) * 10) / 10,
        state: view.state,
        title: view.title,
      });
    });
  }
  return blips;
}
