import type { SessionView } from "./types";

/** At most this many sessions are remembered in each list; the oldest go first. */
const LIMIT = 500;

/**
 * Live sessions put out of the way, newest first. `parked`: the user parked
 * them. `kept`: the user brought them back from Parked, so the time rule
 * leaves them out until they work again.
 */
export interface Parking {
  parked: string[];
  kept: string[];
}

export const NO_PARKING: Parking = { parked: [], kept: [] };

/** The lists as stored, with anything that is not a session id dropped. */
export function readParking(raw: unknown): Parking {
  const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return { parked: ids(record.parked), kept: ids(record.kept) };
}

/** Its turn is over: idle, or finished and not looked at. Only such a session parks. */
export function resting(view: SessionView): boolean {
  return view.state === "idle" || view.state === "done";
}

/**
 * The lists without the sessions that work or wait again: such a session
 * leaves Parked, and parks on its own again once it rests long enough.
 * Sessions not listed stay: they may run where this window does not look.
 */
export function settle(parking: Parking, views: readonly SessionView[]): Parking {
  const active = new Set(views.filter((view) => !resting(view)).map((view) => view.id));
  return { parked: parking.parked.filter((id) => !active.has(id)), kept: parking.kept.filter((id) => !active.has(id)) };
}

/** In Parked: parked by the user, or resting for `afterMs` (0: never on its own) unless the user brought it back. */
export function isParked(view: SessionView, parking: Parking, now: number, afterMs: number): boolean {
  if (!resting(view)) return false;
  if (parking.parked.includes(view.id)) return true;
  return afterMs > 0 && view.since !== undefined && now - view.since >= afterMs && !parking.kept.includes(view.id);
}

/** Parks a session; the user's choice wins over the time rule. */
export function park(parking: Parking, id: string): Parking {
  return { parked: [id, ...parking.parked.filter((other) => other !== id)].slice(0, LIMIT), kept: parking.kept.filter((other) => other !== id) };
}

/** Brings a session back from Parked, and keeps the time rule from parking it again until it works. */
export function unpark(parking: Parking, id: string): Parking {
  return { parked: parking.parked.filter((other) => other !== id), kept: [id, ...parking.kept.filter((other) => other !== id)].slice(0, LIMIT) };
}
