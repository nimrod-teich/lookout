import { describe, expect, it } from "vitest";
import { addSamples, MAX_SAMPLES, paceOf, type SampleStore } from "../../src/core/pace";
import type { UsageMeter } from "../../src/core/usage";

const MIN = 60_000;
const HOUR = 60 * MIN;
const RESET = 5 * HOUR;
/** Every forecast is asked an hour in, well before the reset. */
const NOW = HOUR;
const meter = (percent: number, resetsAt: number | undefined = RESET): UsageMeter => ({ key: "session", label: "5h", percent, resetsAt, windowMs: 5 * HOUR });

function store(...readings: [at: number, percent: number][]): SampleStore {
  const s: SampleStore = {};
  for (const [at, percent] of readings) addSamples(s, { fetchedAt: at, meters: [meter(percent)] });
  return s;
}

describe("addSamples", () => {
  it("keeps one reading per fetch, newest last, and at most 48", () => {
    const s = store([0, 10], [10 * MIN, 12], [10 * MIN, 12]);
    expect(s.session?.samples).toEqual([{ at: 0, percent: 10 }, { at: 10 * MIN, percent: 12 }]);
    for (let i = 2; i < 60; i++) addSamples(s, { fetchedAt: i * 10 * MIN, meters: [meter(12 + i * 0.1)] });
    expect(s.session?.samples).toHaveLength(MAX_SAMPLES);
    expect(s.session?.samples.at(-1)?.at).toBe(59 * 10 * MIN);
  });

  it("starts over when the window resets or the share falls", () => {
    const s = store([0, 40], [10 * MIN, 45]);
    addSamples(s, { fetchedAt: 20 * MIN, meters: [meter(3, RESET + 5 * HOUR)] });
    expect(s.session).toEqual({ resetsAt: RESET + 5 * HOUR, samples: [{ at: 20 * MIN, percent: 3 }] });
    addSamples(s, { fetchedAt: 30 * MIN, meters: [meter(1, RESET + 5 * HOUR + 1_000)] });
    expect(s.session?.samples).toEqual([{ at: 30 * MIN, percent: 1 }]);
  });

  it("leaves out a reading older than the newest, instead of starting over", () => {
    const s = store([0, 10], [20 * MIN, 30]);
    expect(addSamples(s, { fetchedAt: 10 * MIN, meters: [meter(5)] })).toBe(false);
    expect(s.session?.samples).toEqual([{ at: 0, percent: 10 }, { at: 20 * MIN, percent: 30 }]);
  });

  it("reports whether anything changed", () => {
    const s = store([0, 10]);
    expect(addSamples(s, { fetchedAt: 0, meters: [meter(10)] })).toBe(false);
    expect(addSamples(s, { fetchedAt: MIN, meters: [meter(11)] })).toBe(true);
  });
});

describe("paceOf", () => {
  it("needs readings ten minutes apart", () => {
    expect(paceOf(store([0, 10], [9 * MIN, 12]).session, meter(12), NOW)).toBeUndefined();
    expect(paceOf(store([0, 10]).session, meter(10), NOW)).toBeUndefined();
    expect(paceOf(undefined, meter(10), NOW)).toBeUndefined();
  });

  it("projects when the meter fills from the change in percentage points, and whether that is before the reset", () => {
    // 20 points an hour from 40% at 1h: 100% at 4h, before the reset at 5h.
    const fast = paceOf(store([0, 20], [HOUR, 40]).session, meter(40), NOW);
    expect(fast).toEqual({ perHour: 20, fullAt: 4 * HOUR, runsOut: true });
    // 5 points an hour from 25% at 1h: 100% at 16h; at the reset it reads 45%.
    const slow = paceOf(store([0, 20], [HOUR, 25]).session, meter(25), NOW);
    expect(slow).toEqual({ perHour: 5, fullAt: 16 * HOUR, runsOut: false, atReset: 45 });
  });

  it("says nothing runs out while the share stands still, and has no reset to measure against without one", () => {
    expect(paceOf(store([0, 30], [HOUR, 30]).session, meter(30), NOW)).toEqual({ perHour: 0, runsOut: false, atReset: 30 });
    const unreset = (percent: number): UsageMeter => ({ ...meter(percent), resetsAt: undefined });
    const noReset: SampleStore = {};
    addSamples(noReset, { fetchedAt: 0, meters: [unreset(10)] });
    addSamples(noReset, { fetchedAt: HOUR, meters: [unreset(20)] });
    expect(paceOf(noReset.session, unreset(20), NOW)).toEqual({ perHour: 10, fullAt: 9 * HOUR, runsOut: false });
  });

  it("forecasts nothing once the window has reset, or once the meter is full", () => {
    const readings = store([0, 20], [HOUR, 40]).session;
    expect(paceOf(readings, meter(40), RESET - 1)).toBeDefined();
    expect(paceOf(readings, meter(40), RESET)).toBeUndefined();
    expect(paceOf(store([0, 60], [HOUR, 100]).session, meter(100), NOW)).toBeUndefined();
    expect(paceOf(store([0, 60], [HOUR, 105]).session, meter(105), NOW)).toBeUndefined();
  });

  it("ignores readings of another window", () => {
    expect(paceOf(store([0, 20], [HOUR, 40]).session, meter(40, RESET + 10 * HOUR), NOW)).toBeUndefined();
  });
});
