import { describe, expect, it } from "vitest";
import { isParked, NO_PARKING, park, readParking, resting, settle, unpark } from "../../src/core/parking";
import { view } from "../vscode/helpers";

const HOUR = 3_600_000;
const NOW = 100 * HOUR;
const DAY = 24 * HOUR;

describe("parking", () => {
  it("parks only a session whose turn is over", () => {
    expect(["idle", "done", "working", "waiting", "unknown"].map((state) => resting(view({ state: state as never })))).toEqual([true, true, false, false, false]);
    const parked = park(NO_PARKING, "s1");
    expect(isParked(view({ id: "s1", state: "idle" }), parked, NOW, DAY)).toBe(true);
    expect(isParked(view({ id: "s1", state: "done" }), parked, NOW, DAY)).toBe(true);
    expect(isParked(view({ id: "s1", state: "working" }), parked, NOW, DAY)).toBe(false);
    expect(isParked(view({ id: "s2", state: "idle", since: NOW - HOUR }), parked, NOW, DAY)).toBe(false);
  });

  it("parks a session resting longer than the setting, unless the user brought it back or the setting is 0", () => {
    const old = view({ id: "s1", state: "idle", since: NOW - DAY });
    expect(isParked(old, NO_PARKING, NOW, DAY)).toBe(true);
    expect(isParked({ ...old, since: NOW - DAY + 1 }, NO_PARKING, NOW, DAY)).toBe(false);
    expect(isParked({ ...old, since: undefined }, NO_PARKING, NOW, DAY)).toBe(false);
    expect(isParked(old, NO_PARKING, NOW, 0)).toBe(false);
    expect(isParked(old, unpark(NO_PARKING, "s1"), NOW, DAY)).toBe(false);
    // Parking it again wins over having brought it back.
    expect(isParked(old, park(unpark(NO_PARKING, "s1"), "s1"), NOW, 0)).toBe(true);
  });

  it("lets a session that works or waits again leave Parked, and keeps those it does not see", () => {
    const parking = { parked: ["s1", "s2", "gone"], kept: ["s3", "s4"] };
    const settled = settle(parking, [view({ id: "s1", state: "working" }), view({ id: "s2", state: "done" }), view({ id: "s3", state: "waiting" }), view({ id: "s4", state: "idle" })]);
    expect(settled).toEqual({ parked: ["s2", "gone"], kept: ["s4"] });
  });

  it("keeps the newest first, each id once, and reads only ids back", () => {
    expect(park(park(NO_PARKING, "a"), "b")).toEqual({ parked: ["b", "a"], kept: [] });
    expect(park(park(NO_PARKING, "a"), "a")).toEqual({ parked: ["a"], kept: [] });
    expect(unpark(park(NO_PARKING, "a"), "a")).toEqual({ parked: [], kept: ["a"] });
    expect(readParking({ parked: ["a", 3, null], kept: "b" })).toEqual({ parked: ["a"], kept: [] });
    expect(readParking(undefined)).toEqual(NO_PARKING);
  });
});
