import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Usage } from "../../src/vscode/controller";
import { StatusBar, type StatusBarInput } from "../../src/vscode/statusBar";
import { stub, type Op } from "./stub-vscode";

const ITEM = "statusBar:lookout.status";
const L = "$(lookout-lighthouse)";

function itemOps(): Op[] {
  return stub.ops.filter(([target]) => target === ITEM);
}

function lastSet(prop: string): unknown {
  return itemOps().filter(([, action]) => action === `set:${prop}`).at(-1)?.[2];
}

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    fetchedAt: 0,
    stale: false,
    meters: [
      { key: "session", label: "Session (5hr)", percent: 18, resetsAt: 2 * 3_600_000, windowMs: 5 * 3_600_000 },
      { key: "weekly_all", label: "Weekly (7 day)", percent: 31, resetsAt: 3 * 86_400_000 },
      { key: "weekly_scoped:Fable", label: "Weekly Fable", percent: 84 },
    ],
    ...overrides,
  };
}

function input(overrides: Partial<StatusBarInput> = {}): StatusBarInput {
  return { usage: undefined, enabled: true, showUsage: true, showReset: false, canRefreshUsage: true, ...overrides };
}

describe("StatusBar", () => {
  let bar: StatusBar;

  beforeEach(() => {
    vi.useFakeTimers();
    stub.reset();
    bar = new StatusBar("lookout.showBoard");
    stub.ops.length = 0;
  });

  afterEach(() => {
    bar.dispose();
    vi.useRealTimers();
  });

  it("opens the board when clicked, and shows the lighthouse alone with no usage to show", () => {
    expect(stub.ops.length).toBe(0);
    const fresh = new StatusBar("lookout.showBoard");
    expect(stub.ops).toContainEqual([ITEM, "set:command", "lookout.showBoard"]);
    fresh.dispose();
    bar.render(input());
    expect(lastSet("text")).toBe(L);
    expect(lastSet("accessibilityInformation")).toEqual({ label: "Lookout" });
    expect(itemOps().at(-1)).toEqual([ITEM, "show"]);
    const tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).toContain("No usage reported; run Lookout: Refresh Usage");
    expect(tip).toContain("Click to open Lookout");
  });

  it("shows the usage and nothing about the sessions, with every limit in the hover", () => {
    bar.render(input({ usage: usage() }), 3 * 60_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18%`);
    expect(lastSet("color")).toMatchObject({ id: "charts.green" });
    expect(lastSet("accessibilityInformation")).toEqual({ label: "Lookout: usage Session (5hr) 18%" });
    const tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).toContain("**Claude usage**");
    // As Claude Code's panel has them: the limits, their share used and when they reset; no forecast, no age.
    expect(tip).toContain("Session \\(5hr\\): 18% · resets in 1h  \n");
    expect(tip).toContain("Weekly \\(7 day\\): 31% · resets in 2d  \n");
    expect(tip).toContain("Weekly Fable: 84%  \n");
    // Each limit with a bar coloured as the board's: green, amber from half, red from 80%.
    expect(tip).toContain('<span style="color:#89d185;">▰▰▱▱▱▱▱▱▱▱</span> Session');
    expect(tip).toContain('<span style="color:#f14c4c;">▰▰▰▰▰▰▰▰▱▱</span> Weekly Fable');
    expect(tip).not.toContain("As of");
    expect(tip).toContain("Click to open Lookout");
  });

  it("shows the lighthouse alone when usage is off", () => {
    bar.render(input({ usage: usage(), showUsage: false }));
    expect(lastSet("text")).toBe(L);
    expect(lastSet("color")).toBeUndefined();
    const tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).not.toContain("Claude usage");
    expect(tip).toBe("Click to open Lookout");
  });

  it("turns red when a limit is nearly used up, unless the numbers are stale", () => {
    const high = usage({ meters: [{ key: "session", label: "5h", percent: 97 }] });
    bar.render(input({ usage: high }), 0);
    expect(lastSet("backgroundColor")).toMatchObject({ id: "statusBarItem.errorBackground" });
    expect(lastSet("color")).toMatchObject({ id: "charts.red" });
    expect(lastSet("text")).toBe(`${L} ▰▰▰▰▰▰▰▰▰▰ 97%`);
    bar.render(input({ usage: { ...high, stale: true } }), 0);
    expect(lastSet("backgroundColor")).toBeUndefined();
  });

  it("colours the bar by the 5-hour usage alone and leaves the week to the hover", () => {
    const meters = (session: number, week: number) => usage({ meters: [{ key: "session", label: "5h", percent: session }, { key: "weekly_all", label: "Week", percent: week }] });
    bar.render(input({ usage: meters(55, 90) }), 0);
    expect(lastSet("text")).toBe(`${L} ▰▰▰▰▰▰▱▱▱▱ 55%`);
    expect(lastSet("color")).toMatchObject({ id: "charts.yellow" });
    expect(lastSet("backgroundColor")).toBeUndefined();
    expect((lastSet("tooltip") as { value: string }).value).toContain("Week: 90%");
    bar.render(input({ usage: meters(80, 10) }), 0);
    expect(lastSet("color")).toMatchObject({ id: "charts.red" });
    expect(lastSet("text")).toBe(`${L} ▰▰▰▰▰▰▰▰▱▱ 80%`);
    // No 5-hour meter at all: the first one stands in.
    bar.render(input({ usage: usage({ meters: [{ key: "weekly_all", label: "Week", percent: 4 }] }) }), 0);
    expect(lastSet("text")).toBe(`${L} ▱▱▱▱▱▱▱▱▱▱ 4%`);
    expect(lastSet("accessibilityInformation")).toEqual({ label: "Lookout: usage Week 4%" });
  });

  it("counts down to the 5-hour reset after the bar, and keeps the countdown current", () => {
    vi.setSystemTime(3 * 60_000);
    bar.render(input({ usage: usage(), showReset: true }), 3 * 60_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h57m`);
    vi.advanceTimersByTime(60_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h56m`);
  });

  it("turns the countdown over with its minute, not with the minute ticker", () => {
    // 1h56m30s left: the text turns to 1h56m thirty seconds from now, as the board's does.
    vi.setSystemTime(3 * 60_000 + 30_000);
    bar.render(input({ usage: usage(), showReset: true }), 3 * 60_000 + 30_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h57m`);
    vi.advanceTimersByTime(29_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h57m`);
    vi.advanceTimersByTime(1_100);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h56m`);
    vi.advanceTimersByTime(60_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h55m`);
    // Without the setting only the minute ticker is left.
    bar.render(input({ usage: usage(), showReset: false }), Date.now());
    expect(vi.getTimerCount()).toBe(1);
  });

  it("turns the bar grey when the numbers are stale", () => {
    bar.render(input({ usage: usage({ stale: true }) }), 0);
    expect(lastSet("color")).toMatchObject({ id: "disabledForeground" });
  });

  it("says when there are no numbers, and how to fetch them when it can", () => {
    bar.render(input({ usage: undefined }), 0);
    expect((lastSet("tooltip") as { value: string }).value).toContain("No usage reported; run Lookout: Refresh Usage");
    bar.render(input({ usage: undefined, canRefreshUsage: false }), 0);
    const tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).toContain("No usage reported");
    expect(tip).not.toContain("Refresh Usage");
  });

  it("says why there are no numbers when the group knows", () => {
    bar.render(input({ usage: undefined, usageGroups: [{ agent: "claude-code", stale: false, meters: [], canRefresh: true, note: "Too many usage checks; next at 14:05" }] }), 0);
    const tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).toContain("Too many usage checks; next at 14:05");
    expect(tip).not.toContain("No usage reported");
  });

  it("writes nothing when the same input is rendered again, and only what changed otherwise", () => {
    bar.render(input({ usage: usage() }), 0);
    stub.ops.length = 0;
    bar.render(input({ usage: usage() }), 0);
    expect(itemOps()).toEqual([]);
    bar.render(input({ usage: usage({ meters: [{ key: "session", label: "Session (5hr)", percent: 97 }] }) }), 0);
    expect(itemOps().map(([, action]) => action)).toEqual(["set:text", "set:accessibilityInformation", "set:tooltip", "set:color", "set:backgroundColor"]);
  });

  it("refreshes the reset times in the hover once a minute while shown", () => {
    vi.setSystemTime(0);
    bar.render(input({ usage: usage() }));
    stub.ops.length = 0;
    vi.advanceTimersByTime(59_000);
    expect(itemOps()).toEqual([]);
    // A quarter of an hour before the 5-hour window resets.
    vi.advanceTimersByTime(6_241_000);
    expect((lastSet("tooltip") as { value: string }).value).toContain("Session \\(5hr\\): 18% · resets in 15m");
  });

  it("hides once when disabled, and shows again", () => {
    bar.render(input());
    stub.ops.length = 0;
    bar.render(input({ enabled: false }));
    bar.render(input({ enabled: false }));
    expect(itemOps()).toEqual([[ITEM, "hide"]]);
    stub.ops.length = 0;
    bar.render(input());
    expect(itemOps()).toEqual([[ITEM, "show"]]);
  });
});
