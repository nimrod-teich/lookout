import type { UsageMeter, UsageSnapshot } from "./usage";

/** One reading of a meter. */
export interface Sample {
  /** Epoch ms the numbers were fetched. */
  at: number;
  percent: number;
}

/** The readings of one meter in its current window. */
export interface MeterSamples {
  /** When that window resets; a reading with another reset time belongs to another window. */
  resetsAt?: number;
  samples: Sample[];
}

/** Readings per meter key, kept across reloads. */
export type SampleStore = Record<string, MeterSamples>;

export const MAX_SAMPLES = 48;
/** A pace needs readings at least this far apart. */
export const MIN_SPAN_MS = 10 * 60_000;
/** Reset times of one window can differ by a little between fetches. */
const SAME_WINDOW_MS = 5 * 60_000;
const HOUR = 3_600_000;

export interface Pace {
  /** Percentage points per hour. */
  perHour: number;
  /** Epoch ms the meter reaches 100% at this pace, when it is rising. */
  fullAt?: number;
  /** It reaches 100% before the window resets. */
  runsOut: boolean;
  /** Where it ends up when the window resets, when it does not run out first. */
  atReset?: number;
}

function sameWindow(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a - b) < SAME_WINDOW_MS;
}

/**
 * Adds a snapshot's readings to the store. A meter whose window changed, or
 * whose percentage fell (it reset), starts over; each meter keeps its newest
 * readings. A reading older than the newest one kept is left out: numbers
 * come back older only when something rewrote the cache from an old copy.
 * Returns whether the store changed.
 */
export function addSamples(store: SampleStore, snapshot: UsageSnapshot): boolean {
  let changed = false;
  for (const meter of snapshot.meters) {
    let entry = store[meter.key];
    const last = entry?.samples.at(-1);
    if (last && snapshot.fetchedAt < last.at) continue;
    if (!entry || !sameWindow(entry.resetsAt, meter.resetsAt) || (last && meter.percent < last.percent)) {
      entry = { resetsAt: meter.resetsAt, samples: [] };
      store[meter.key] = entry;
      changed = true;
    }
    if (entry.samples.some((sample) => sample.at === snapshot.fetchedAt)) continue;
    entry.samples.push({ at: snapshot.fetchedAt, percent: meter.percent });
    if (entry.samples.length > MAX_SAMPLES) entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
    entry.resetsAt = meter.resetsAt;
    changed = true;
  }
  return changed;
}

/**
 * The pace of a meter from its readings in this window: the change in
 * percentage points between the oldest and the newest reading, per hour.
 * Nothing until the readings span ten minutes, once the window has reset, or
 * once the meter is full. Token counts play no part.
 */
export function paceOf(entry: MeterSamples | undefined, meter: UsageMeter, now: number = Date.now()): Pace | undefined {
  if (!entry || !sameWindow(entry.resetsAt, meter.resetsAt) || entry.samples.length < 2) return undefined;
  if (meter.resetsAt !== undefined && meter.resetsAt <= now) return undefined;
  const first = entry.samples[0]!;
  const last = entry.samples.at(-1)!;
  if (last.percent >= 100) return undefined;
  const span = last.at - first.at;
  if (span < MIN_SPAN_MS) return undefined;
  const perMs = (last.percent - first.percent) / span;
  const perHour = Math.round(perMs * HOUR * 10) / 10;
  if (perMs <= 0) return { perHour: Math.max(0, perHour), runsOut: false, atReset: meter.resetsAt === undefined ? undefined : last.percent };
  const fullAt = Math.round(last.at + (100 - last.percent) / perMs);
  if (meter.resetsAt === undefined) return { perHour, fullAt, runsOut: false };
  if (fullAt < meter.resetsAt) return { perHour, fullAt, runsOut: true };
  return { perHour, fullAt, runsOut: false, atReset: Math.min(100, Math.round(last.percent + perMs * (meter.resetsAt - last.at))) };
}
