// Pure helpers for the board; no DOM here so they can be tested under Node.
import { clockTime, formatElapsed, formatTokens, formatUntil, quietFor, reasonLabel } from "../core/format";
import type { SessionView, State } from "../core/types";

export type GroupKey = "waiting" | "done" | "working" | "idle";

export interface Group {
  key: GroupKey;
  label: string;
  views: SessionView[];
}

export function isGroupKey(value: unknown): value is GroupKey {
  return value === "waiting" || value === "done" || value === "working" || value === "idle";
}

const GROUP_OF: Record<State, GroupKey> = { waiting: "waiting", done: "done", working: "working", unknown: "idle", idle: "idle" };
const LABELS: Record<GroupKey, string> = { waiting: "Needs you", done: "Finished", working: "Working", idle: "Idle" };
const ORDER: GroupKey[] = ["waiting", "done", "working", "idle"];

/** The sessions by group, in display order, without empty groups. The input is already sorted. */
export function groupSessions(views: readonly SessionView[]): Group[] {
  const groups = new Map<GroupKey, SessionView[]>();
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

/** The second line of a card: what the session asks, does, or last said, with a label for the kind of ask. */
export interface CardLine {
  /** "Permission", "Question", "quiet 12m"… */
  label?: string;
  text?: string;
  /** The answers a question offers. */
  options?: string[];
}

export function cardLine(view: SessionView, now: number): CardLine {
  switch (view.state) {
    case "waiting": {
      const reason = view.reason;
      if (!reason) return { text: "input needed" };
      // "Permission" over "permission prompt" says it twice.
      const text = reason.kind === "permission" && reason.ask === reason.raw ? undefined : reason.ask;
      return { label: reasonLabel(reason.kind), text, options: reason.options };
    }
    case "working": {
      const quiet = quietFor(view, now);
      return { label: quiet === undefined ? undefined : `quiet ${formatElapsed(quiet)}`, text: view.activity ?? "thinking" };
    }
    case "done":
    case "idle":
      return { text: view.lastReply };
    case "unknown":
      return { text: view.evidence?.note };
  }
}

/** The card's second line as one string, for the hover over a boat. */
export function secondLine(view: SessionView, now: number): string | undefined {
  const line = cardLine(view, now);
  if (line.text === undefined) return line.label;
  return line.label ? `${line.label} · ${line.text}` : line.text;
}

/** Bar heights for the pulse, 0..1, scaled to the busiest minute. */
export function pulseBars(pulse: readonly number[] | undefined): number[] {
  if (!pulse || pulse.length === 0) return [];
  const peak = Math.max(...pulse);
  return pulse.map((n) => (peak === 0 ? 0 : n / peak));
}

/** How full the context window is, 0..100, when the window is known. */
export function contextPercent(view: SessionView): number | undefined {
  if (!view.contextTokens || !view.contextWindow) return undefined;
  return Math.min(100, Math.round((view.contextTokens / view.contextWindow) * 100));
}

/** The context ring's colour: amber from 75%, red from 90%. */
export function contextLevel(percent: number): "ok" | "high" | "full" {
  return percent >= 90 ? "full" : percent >= 75 ? "high" : "ok";
}

/** The conversation was compacted after the agent's last call, whose context size the card shows. */
export function compactedSinceLastCall(view: SessionView): boolean {
  return view.compactedAt !== undefined && view.cache !== undefined && view.compactedAt > view.cache.lastCallAt;
}

/** A chip on a card, with what its hover explains. */
export interface Chip {
  text: string;
  title?: string;
  /** Extra class, for its look. */
  kind?: string;
}

/** "compacted ×2", when the agent compacted the conversation. */
export function compactionChip(view: SessionView, now: number): Chip | undefined {
  if (!view.compactions) return undefined;
  const times = view.compactions === 1 ? "once" : `${view.compactions} times`;
  const last = view.compactedAt === undefined ? "" : `, the last time at ${clockTime(view.compactedAt, now)}`;
  return {
    text: `compacted ×${view.compactions}`,
    title: `The agent compacted this conversation ${times}${last}: it replaced the older part with a summary to free its context window. What came before is known to it only from that summary.`,
    kind: "compacted",
  };
}

/**
 * Whether the next message finds the conversation in the model's prompt
 * cache: "cache warm, full price in 3m" or "cache cold". Not while the
 * session works, when every call keeps the cache warm.
 */
export function cacheChip(view: SessionView, now: number): Chip | undefined {
  const cache = view.cache;
  if (!cache || view.state === "working") return undefined;
  const until = cache.lastCallAt + cache.ttlMs;
  const life = cache.ttlMs >= 3_600_000 ? "an hour" : "5 minutes";
  // A compaction since that call left a shorter conversation than its count.
  const what = view.contextTokens && !compactedSinceLastCall(view) ? `its ${formatTokens(view.contextTokens)} tokens` : "it";
  if (now < until) {
    return {
      text: `cache warm, full price in ${formatUntil(until - now)}`,
      title: `The model's prompt cache keeps this conversation for ${life} after each call; the last went out at ${clockTime(cache.lastCallAt, now)}. A message sent before ${clockTime(until, now)} reads ${what} from the cache, for a fraction of the input price. After that, the conversation is written to the cache again, which costs more than the input price.`,
      kind: "cache warm",
    };
  }
  return {
    text: "cache cold",
    title: `The model's prompt cache let this conversation go at ${clockTime(until, now)}, ${life} after the agent's last call went out. The next message writes ${what} to the cache again, which costs more than the input price.`,
    kind: "cache cold",
  };
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
const LANES: Record<GroupKey, number> = { waiting: 8, working: 17, done: 26, idle: 35 };
/** Boats of one lane stay at least this far apart, so sessions started together stay visible. */
const MIN_GAP = 11;
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
    // Newest first in the lane, so the push for spacing goes away from the shore.
    const lane = [...group.views].sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
    let lastX = -Infinity;
    lane.forEach((view, i) => {
      const minutes = view.since === undefined ? 0 : Math.max(0, now - view.since) / 60_000;
      const t = Math.min(1, Math.log10(1 + minutes) / Math.log10(1 + MAX_MINUTES));
      const x = Math.min(HARBOUR.farX, Math.max(HARBOUR.nearX + (HARBOUR.farX - HARBOUR.nearX) * t, lastX + MIN_GAP));
      lastX = x;
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
