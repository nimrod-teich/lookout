import { describe, expect, it } from "vitest";
import { contextPercent, groupSessions, HARBOUR, hostChip, laneSegments, layoutBoats, pulseBars, secondLine, waterline } from "../../src/webview/model";
import { view } from "../vscode/helpers";

describe("groupSessions", () => {
  it("groups by state in display order and drops empty groups", () => {
    const groups = groupSessions([
      view({ id: "w", state: "waiting" }),
      view({ id: "d", state: "done" }),
      view({ id: "b", state: "working" }),
      view({ id: "u", state: "unknown" }),
      view({ id: "i", state: "idle" }),
    ]);
    expect(groups.map((g) => [g.key, g.label, g.views.map((v) => v.id)])).toEqual([
      ["waiting", "Needs you", ["w"]],
      ["done", "Finished", ["d"]],
      ["working", "Working", ["b"]],
      ["idle", "Idle", ["u", "i"]],
    ]);
    expect(groupSessions([view({ state: "working" })]).map((g) => g.key)).toEqual(["working"]);
    expect(groupSessions([])).toEqual([]);
  });
});

describe("card text", () => {
  it("names where a session runs, except the window's own panel", () => {
    expect(hostChip(view())).toBeUndefined();
    expect(hostChip(view({ host: "terminal" }))).toBe("terminal");
    expect(hostChip(view({ host: "window", windowLabel: "api" }))).toBe("window: api");
    expect(hostChip(view({ host: "window" }))).toBe("another window");
    expect(hostChip(view({ host: "elsewhere" }))).toBe("outside VS Code");
  });

  it("picks the second line by state", () => {
    expect(secondLine(view({ state: "waiting", needs: "permission prompt" }))).toBe("permission prompt");
    expect(secondLine(view({ state: "waiting" }))).toBe("input needed");
    expect(secondLine(view({ state: "working", activity: "Bash · npm test" }))).toBe("Bash · npm test");
    expect(secondLine(view({ state: "working" }))).toBe("thinking");
    expect(secondLine(view({ state: "done", lastReply: "All green." }))).toBe("All green.");
    expect(secondLine(view({ state: "idle" }))).toBeUndefined();
    expect(secondLine(view({ state: "unknown", lastReply: "x" }))).toBeUndefined();
  });
});

describe("waterline", () => {
  it("rises with the 5-hour usage and clamps", () => {
    expect(waterline(undefined)).toBe(HARBOUR.seaTop);
    expect(waterline(0)).toBe(HARBOUR.seaTop);
    expect(waterline(50)).toBe((HARBOUR.seaTop + HARBOUR.seaTopFull) / 2);
    expect(waterline(100)).toBe(HARBOUR.seaTopFull);
    expect(waterline(250)).toBe(HARBOUR.seaTopFull);
    expect(waterline(-5)).toBe(HARBOUR.seaTop);
  });
});

describe("layoutBoats", () => {
  const water = HARBOUR.seaTop;

  it("floats every boat on the water, by lane, and keeps it inside the harbour", () => {
    const now = 60 * 60_000;
    const boats = layoutBoats(
      [view({ id: "w", state: "waiting", since: now - 60_000 }), view({ id: "b", state: "working", since: now - 60_000 }), view({ id: "i", state: "idle", since: now - 60_000 })],
      now,
      water,
    );
    const byId = Object.fromEntries(boats.map((b) => [b.id, b]));
    expect(byId.w!.y).toBeLessThan(byId.b!.y);
    expect(byId.b!.y).toBeLessThan(byId.i!.y);
    for (const boat of boats) {
      expect(boat.y).toBeGreaterThan(water);
      expect(boat.y).toBeLessThan(HARBOUR.height);
      expect(boat.x).toBeGreaterThanOrEqual(HARBOUR.nearX);
      expect(boat.x).toBeLessThanOrEqual(HARBOUR.farX);
      expect(boat.bearing).toBeGreaterThan(0);
      expect(boat.bearing).toBeLessThan(90);
    }
  });

  it("puts a session farther from the shore the longer it has been in its state, up to the far edge", () => {
    const now = 10 * 3_600_000;
    const [fresh, minute, hour, day] = layoutBoats(
      [
        view({ id: "fresh", state: "working", since: now }),
        view({ id: "minute", state: "working", since: now - 60_000 }),
        view({ id: "hour", state: "working", since: now - 3_600_000 }),
        view({ id: "day", state: "working", since: now - 86_400_000 }),
      ],
      now,
      water,
    );
    expect(fresh!.x).toBeCloseTo(HARBOUR.nearX, 0);
    expect(minute!.x).toBeGreaterThan(fresh!.x);
    expect(hour!.x).toBeGreaterThan(minute!.x);
    expect(day!.x).toBeCloseTo(HARBOUR.farX, 0);
  });

  it("labels the sessions that need the user, at most two", () => {
    const now = 5 * 60_000;
    const boats = layoutBoats(
      [view({ id: "a", state: "waiting", title: "First", since: now - 3 * 60_000 }), view({ id: "b", state: "waiting", title: "Second", since: now - 3 * 60_000 }), view({ id: "c", state: "waiting", title: "Third" }), view({ id: "d", state: "working", title: "Busy" })],
      now,
      water,
    );
    expect(boats.map((b) => b.label)).toEqual(["First · 3m", "Second · 3m", undefined, undefined]);
  });

  it("follows the tide", () => {
    const low = layoutBoats([view({ state: "working" })], 0, waterline(0))[0]!;
    const high = layoutBoats([view({ state: "working" })], 0, waterline(100))[0]!;
    expect(high.y).toBeLessThan(low.y);
  });
});

describe("card telemetry", () => {
  it("scales the pulse to its busiest minute", () => {
    expect(pulseBars([0, 2, 4, 1])).toEqual([0, 0.5, 1, 0.25]);
    expect(pulseBars([0, 0])).toEqual([0, 0]);
    expect(pulseBars(undefined)).toEqual([]);
  });

  it("gives the context as a percentage only when the window is known", () => {
    expect(contextPercent(view({ contextTokens: 150_000, contextWindow: 200_000 }))).toBe(75);
    expect(contextPercent(view({ contextTokens: 1_200_000, contextWindow: 1_000_000 }))).toBe(100);
    expect(contextPercent(view({ contextTokens: 150_000 }))).toBeUndefined();
    expect(contextPercent(view({ contextWindow: 200_000 }))).toBeUndefined();
  });
});

describe("laneSegments", () => {
  const HOUR = 60 * 60_000;
  const MIN = 60_000;

  it("turns the points into segments across the window, clipped to it", () => {
    const now = 10 * HOUR;
    const segments = laneSegments(
      [
        { state: "idle", at: now - 90 * MIN },
        { state: "working", at: now - 30 * MIN },
        { state: "waiting", at: now - 6 * MIN },
      ],
      now,
      HOUR,
    );
    expect(segments.map((s) => [s.state, Math.round(s.left), Math.round(s.width)])).toEqual([
      ["idle", 0, 50],
      ["working", 50, 40],
      ["waiting", 90, 10],
    ]);
  });

  it("leaves the time before Lookout saw the session empty", () => {
    const now = 10 * HOUR;
    const segments = laneSegments([{ state: "working", at: now - 15 * MIN }], now, HOUR);
    expect(segments.map((s) => [s.state, Math.round(s.left), Math.round(s.width)])).toEqual([["working", 75, 25]]);
    expect(laneSegments([], now, HOUR)).toEqual([]);
    expect(laneSegments(undefined, now, HOUR)).toEqual([]);
    expect(laneSegments([{ state: "idle", at: now + MIN }], now, HOUR)).toEqual([]);
  });
});
