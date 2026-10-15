import { describe, expect, it } from "vitest";
import { BEAM, groupSessions, hostChip, layoutBlips, secondLine } from "../../src/webview/model";
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

describe("layoutBlips", () => {
  const distance = (b: { x: number; y: number }) => Math.hypot(b.x - BEAM.originX, b.y - BEAM.originY);

  it("sends each state to its own side and keeps every blip inside the strip", () => {
    const now = 60 * 60_000;
    const blips = layoutBlips(
      [view({ id: "w", state: "waiting", since: now - 60_000 }), view({ id: "b", state: "working", since: now - 60_000 }), view({ id: "i", state: "idle", since: now - 60_000 })],
      now,
    );
    const byId = Object.fromEntries(blips.map((b) => [b.id, b]));
    expect(byId.w!.x).toBeLessThan(BEAM.originX);
    expect(byId.b!.x).toBeGreaterThan(BEAM.originX);
    expect(byId.i!.x).toBeGreaterThan(byId.b!.x);
    for (const blip of blips) {
      expect(blip.x).toBeGreaterThanOrEqual(0);
      expect(blip.x).toBeLessThanOrEqual(BEAM.width);
      expect(blip.y).toBeGreaterThanOrEqual(0);
      expect(blip.y).toBeLessThan(BEAM.originY);
    }
  });

  it("puts a session farther out the longer it has been in its state, up to the edge", () => {
    const now = 10 * 3_600_000;
    const [fresh, minute, hour, day] = layoutBlips(
      [
        view({ id: "fresh", state: "working", since: now }),
        view({ id: "minute", state: "working", since: now - 60_000 }),
        view({ id: "hour", state: "working", since: now - 3_600_000 }),
        view({ id: "day", state: "working", since: now - 86_400_000 }),
      ],
      now,
    );
    expect(distance(fresh!)).toBeCloseTo(BEAM.minRadius, 0);
    expect(distance(minute!)).toBeGreaterThan(distance(fresh!));
    expect(distance(hour!)).toBeGreaterThan(distance(minute!));
    expect(distance(day!)).toBeCloseTo(BEAM.maxRadius, 0);
    expect(layoutBlips([view({ since: undefined })], now).map(distance)[0]).toBeCloseTo(BEAM.minRadius, 0);
  });

  it("spreads the sessions of one state across its sector", () => {
    const blips = layoutBlips([view({ id: "a", state: "working" }), view({ id: "b", state: "working" }), view({ id: "c", state: "working" })], 0);
    const xs = blips.map((b) => b.x);
    expect(xs[0]).toBeLessThan(xs[1]!);
    expect(xs[1]).toBeLessThan(xs[2]!);
    expect(blips.map((b) => b.title)).toEqual(["Wire the cache", "Wire the cache", "Wire the cache"]);
  });
});
