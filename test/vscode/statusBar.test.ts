import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../../src/core/types";
import type { Usage } from "../../src/vscode/controller";
import { StatusBar, type StatusBarInput } from "../../src/vscode/statusBar";
import { view } from "./helpers";
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
    pace: {},
    meters: [
      { key: "session", label: "5h", percent: 18, resetsAt: 2 * 3_600_000, windowMs: 5 * 3_600_000 },
      { key: "weekly_all", label: "Week", percent: 31 },
      { key: "weekly_scoped:Fable", label: "Week · Fable", percent: 84 },
    ],
    ...overrides,
  };
}

function input(views: SessionView[], overrides: Partial<StatusBarInput> = {}): StatusBarInput {
  return { views, usage: undefined, enabled: true, showUsage: true, showReset: false, canRefreshUsage: true, ...overrides };
}

describe("StatusBar", () => {
  let bar: StatusBar;

  beforeEach(() => {
    vi.useFakeTimers();
    stub.reset();
    bar = new StatusBar("lookout.jump");
    stub.ops.length = 0;
  });

  afterEach(() => {
    bar.dispose();
    vi.useRealTimers();
  });

  it("stays hidden and silent with no sessions and no usage", () => {
    bar.render(input([]));
    bar.render(input([]));
    vi.advanceTimersByTime(1000);
    expect(itemOps()).toEqual([]);
  });

  it("shows working, waiting and finished counts with a warning background", () => {
    bar.render(input([view({ state: "waiting", reason: { kind: "permission", ask: "permission prompt", raw: "permission prompt" } }), view({ id: "b", state: "working" }), view({ id: "c", state: "working" }), view({ id: "d", state: "done" })]));
    expect(lastSet("text")).toBe(`${L} ⠋ 2  $(bell-dot) 1  $(check) 1`);
    expect(lastSet("backgroundColor")).toMatchObject({ id: "statusBarItem.warningBackground" });
    expect(lastSet("accessibilityInformation")).toEqual({ label: "Lookout: 2 working, 1 waiting for you, 1 finished, 0 idle" });
    expect(itemOps().at(-1)).toEqual([ITEM, "show"]);
  });

  it("counts a question read from a reply with the waits, but lights the background only for a prompt the agent reports", () => {
    const typed = view({ state: "waiting", reason: { kind: "typed", ask: "Want me to open the PR?" } });
    bar.render(input([typed]), 0);
    expect(lastSet("text")).toBe(`${L} $(bell-dot) 1`);
    expect(itemOps().some(([, action]) => action === "set:backgroundColor")).toBe(false);
    const tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).toContain("$(comment-discussion) **Wire the cache**");
    expect(tip).toContain("Needs you for 0s: Asked you a question · Want me to open the PR?");
    bar.render(input([typed, view({ id: "b", state: "waiting", reason: { kind: "question", ask: "Which color?", options: ["Red", "Blue"] } })]), 0);
    expect(lastSet("text")).toBe(`${L} $(bell-dot) 2`);
    expect(lastSet("backgroundColor")).toMatchObject({ id: "statusBarItem.warningBackground" });
  });

  it("shows a working session that has gone quiet with a clock, and stops the spinner when every one has", () => {
    const now = 15 * 60_000;
    bar.render(input([view({ state: "working", since: 0, lastWriteAt: 0 }), view({ id: "b", state: "working", since: 0, lastWriteAt: now })]), now);
    expect(lastSet("text")).toBe(`${L} ⠋ 1  $(clock) 1`);
    expect(lastSet("accessibilityInformation")).toEqual({ label: "Lookout: 2 working (1 quiet), 0 waiting for you, 0 finished, 0 idle" });
    expect((lastSet("tooltip") as { value: string }).value).toContain("$(clock) **Wire the cache**  \napp · Working, quiet 15m");
    bar.render(input([view({ state: "working", since: 0, lastWriteAt: 0 })]), now);
    expect(lastSet("text")).toBe(`${L} $(clock) 1`);
    stub.ops.length = 0;
    vi.advanceTimersByTime(500);
    expect(itemOps()).toEqual([]);
  });

  it("notices a session go quiet on the minute tick, without new input", () => {
    vi.setSystemTime(0);
    bar.render(input([view({ state: "working", since: 0, lastWriteAt: 0 })]), 0);
    vi.advanceTimersByTime(11 * 60_000);
    expect(lastSet("text")).toBe(`${L} $(clock) 1`);
  });

  it("shows the idle count when nothing is active", () => {
    bar.render(input([view(), view({ id: "b" }), view({ id: "c", state: "unknown" })]));
    expect(lastSet("text")).toBe(`${L} $(question) 1  2 idle`);
    expect(itemOps().some(([, action]) => action === "set:backgroundColor")).toBe(false);
  });

  it("puts the usage under the same lighthouse, with every limit in the hover", () => {
    bar.render(input([view({ state: "working" })], { usage: usage() }), 3 * 60_000);
    expect(lastSet("text")).toBe(`${L} ⠋ 1   ▰▰▱▱▱▱▱▱▱▱ 18%`);
    expect(lastSet("color")).toMatchObject({ id: "charts.green" });
    expect(lastSet("accessibilityInformation")).toEqual({ label: "Lookout: 1 working, 0 waiting for you, 0 finished, 0 idle. Usage 5h 18%" });
    const tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).toContain("**Claude usage**");
    expect(tip).toContain("5h: 18% · resets in 1h 57m");
    expect(tip).toContain("Week · Fable: 84%");
    expect(tip).toContain("As of 3m ago");
    expect(tip).toContain("Click to jump to a session");
  });

  it("shows the usage alone when no session runs, and nothing when usage is off", () => {
    bar.render(input([], { usage: usage() }));
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18%`);
    expect((lastSet("tooltip") as { value: string }).value).toContain("No agent sessions running.");
    stub.ops.length = 0;
    bar.render(input([], { usage: usage(), showUsage: false }));
    expect(itemOps()).toEqual([[ITEM, "hide"]]);
    bar.render(input([view()], { usage: usage(), showUsage: false }));
    expect(lastSet("text")).toBe(`${L} 1 idle`);
    expect(lastSet("color")).toBeUndefined();
    expect((lastSet("tooltip") as { value: string }).value).not.toContain("Claude usage");
  });

  it("turns red when a limit is nearly used up, unless the numbers are stale or a session waits", () => {
    const high = usage({ meters: [{ key: "session", label: "5h", percent: 97 }] });
    bar.render(input([view()], { usage: high }), 0);
    expect(lastSet("backgroundColor")).toMatchObject({ id: "statusBarItem.errorBackground" });
    expect(lastSet("color")).toMatchObject({ id: "charts.red" });
    expect(lastSet("text")).toBe(`${L} 1 idle   ▰▰▰▰▰▰▰▰▰▰ 97%`);
    bar.render(input([view()], { usage: { ...high, stale: true } }), 0);
    expect(lastSet("backgroundColor")).toBeUndefined();
    expect((lastSet("tooltip") as { value: string }).value).toMatch(/As of 0s ago \\?\(stale\\?\)/);
    bar.render(input([view({ state: "waiting" })], { usage: high }), 0);
    expect(lastSet("backgroundColor")).toMatchObject({ id: "statusBarItem.warningBackground" });
  });

  it("colours the bar by the 5-hour usage alone and leaves the week to the hover", () => {
    const meters = (session: number, week: number) => usage({ meters: [{ key: "session", label: "5h", percent: session }, { key: "weekly_all", label: "Week", percent: week }] });
    bar.render(input([], { usage: meters(55, 90) }), 0);
    expect(lastSet("text")).toBe(`${L} ▰▰▰▰▰▰▱▱▱▱ 55%`);
    expect(lastSet("color")).toMatchObject({ id: "charts.yellow" });
    expect(lastSet("backgroundColor")).toBeUndefined();
    expect((lastSet("tooltip") as { value: string }).value).toContain("Week: 90%");
    bar.render(input([], { usage: meters(80, 10) }), 0);
    expect(lastSet("color")).toMatchObject({ id: "charts.red" });
    expect(lastSet("text")).toBe(`${L} ▰▰▰▰▰▰▰▰▱▱ 80%`);
    // No 5-hour meter at all: the first one stands in.
    bar.render(input([], { usage: usage({ meters: [{ key: "weekly_all", label: "Week", percent: 4 }] }) }), 0);
    expect(lastSet("text")).toBe(`${L} ▱▱▱▱▱▱▱▱▱▱ 4%`);
    expect(lastSet("accessibilityInformation")).toEqual({ label: "Lookout: 0 working, 0 waiting for you, 0 finished, 0 idle. Usage Week 4%" });
  });

  it("counts down to the 5-hour reset after the bar, and keeps the countdown current", () => {
    vi.setSystemTime(3 * 60_000);
    bar.render(input([], { usage: usage(), showReset: true }), 3 * 60_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h57m`);
    vi.advanceTimersByTime(60_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h56m`);
  });

  it("turns the countdown over with its minute, not with the minute ticker", () => {
    // 1h56m30s left: the text turns to 1h56m thirty seconds from now, as the board's does.
    vi.setSystemTime(3 * 60_000 + 30_000);
    bar.render(input([], { usage: usage(), showReset: true }), 3 * 60_000 + 30_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h57m`);
    vi.advanceTimersByTime(29_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h57m`);
    vi.advanceTimersByTime(1_100);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h56m`);
    vi.advanceTimersByTime(60_000);
    expect(lastSet("text")).toBe(`${L} ▰▰▱▱▱▱▱▱▱▱ 18% · 1h55m`);
    // Without the setting only the minute ticker is left.
    bar.render(input([], { usage: usage(), showReset: false }), Date.now());
    expect(vi.getTimerCount()).toBe(1);
  });

  it("turns the bar red when the pace runs out before the reset, grey when the numbers are stale", () => {
    const fullAt = 90 * 60_000;
    bar.render(input([], { usage: usage({ pace: { session: { perHour: 30, fullAt, runsOut: true } } }) }), 0);
    expect(lastSet("color")).toMatchObject({ id: "charts.red" });
    expect((lastSet("tooltip") as { value: string }).value).toContain("at this pace 100% at");
    bar.render(input([], { usage: usage({ stale: true }) }), 0);
    expect(lastSet("color")).toMatchObject({ id: "disabledForeground" });
  });

  it("says when there are no numbers, and why they are not kept fresh", () => {
    bar.render(input([view()], { usage: undefined }), 0);
    expect((lastSet("tooltip") as { value: string }).value).toContain("No usage reported; run Lookout: Refresh Usage");
    bar.render(input([view()], { usage: undefined, usageNote: "refresh disabled by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", canRefreshUsage: false }), 0);
    const tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).toContain("No usage reported");
    expect(tip).toContain("Usage refresh disabled by CLAUDE\\_CODE\\_DISABLE\\_NONESSENTIAL\\_TRAFFIC");
  });

  it("animates the spinner by rewriting only the text, once per frame, while a session works", () => {
    bar.render(input([view({ state: "working" })]));
    stub.ops.length = 0;
    vi.advanceTimersByTime(300);
    expect(itemOps()).toEqual([
      [ITEM, "set:text", `${L} ⠙ 1`],
      [ITEM, "set:text", `${L} ⠹ 1`],
      [ITEM, "set:text", `${L} ⠸ 1`],
    ]);
  });

  it("stops the spinner when nothing works, when hidden, and when disposed", () => {
    bar.render(input([view({ state: "working" })]));
    bar.render(input([view({ state: "waiting" })]));
    stub.ops.length = 0;
    vi.advanceTimersByTime(500);
    expect(itemOps()).toEqual([]);

    bar.render(input([view({ state: "working" })]));
    bar.render(input([view({ state: "working" })], { enabled: false }));
    stub.ops.length = 0;
    vi.advanceTimersByTime(500);
    expect(itemOps()).toEqual([]);

    bar.render(input([view({ state: "working" })]));
    bar.dispose();
    stub.ops.length = 0;
    vi.advanceTimersByTime(500);
    expect(itemOps().filter(([, action]) => action === "set:text")).toEqual([]);
  });

  it("writes nothing when the same input is rendered again, and only what changed otherwise", () => {
    bar.render(input([view()], { usage: usage() }), 0);
    stub.ops.length = 0;
    bar.render(input([view()], { usage: usage() }), 0);
    expect(itemOps()).toEqual([]);
    bar.render(input([view({ title: "Renamed" })], { usage: usage() }), 0);
    expect(itemOps().map(([, action]) => action)).toEqual(["set:tooltip"]);
    stub.ops.length = 0;
    bar.render(input([view({ state: "waiting", title: "Renamed" })], { usage: usage() }), 0);
    expect(itemOps().map(([, action]) => action)).toEqual(["set:text", "set:accessibilityInformation", "set:tooltip", "set:backgroundColor"]);
  });

  it("refreshes the elapsed times in the hover once a minute while shown", () => {
    vi.setSystemTime(0);
    bar.render(input([view({ state: "idle", since: 0 })]));
    stub.ops.length = 0;
    vi.advanceTimersByTime(59_000);
    expect(itemOps()).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(itemOps().map(([, action]) => action)).toEqual(["set:tooltip"]);
    expect((lastSet("tooltip") as { value: string }).value).toContain("Idle for 1m");
    bar.render(input([]));
    stub.ops.length = 0;
    vi.advanceTimersByTime(120_000);
    expect(itemOps()).toEqual([]);
  });

  it("escapes markdown in titles and shows where each session runs and for how long", () => {
    const now = 12 * 60_000;
    bar.render(input([view({ state: "waiting", title: "fix *the* #build", reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt" }, worktree: "hotfix" }), view({ id: "b", state: "done" })]), now);
    const tip = lastSet("tooltip") as { value: string; supportThemeIcons: boolean };
    expect(tip.supportThemeIcons).toBe(true);
    expect(tip.value).toContain("$(bell-dot) **fix \\*the\\* \\#build**");
    expect(tip.value).toContain("app · hotfix · Needs you for 12m: Permission · Bash: npm test");
    expect(tip.value).toContain("$(check) **Wire the cache**  \n");
    expect(tip.value).toContain("app · Finished 12m ago");
  });

  it("hides once when disabled or when everything ends, and shows again later", () => {
    bar.render(input([view()]));
    stub.ops.length = 0;
    bar.render(input([view()], { enabled: false }));
    bar.render(input([view()], { enabled: false }));
    expect(itemOps()).toEqual([[ITEM, "hide"]]);
    stub.ops.length = 0;
    bar.render(input([view()]));
    expect(itemOps()).toEqual([[ITEM, "show"]]);
    stub.ops.length = 0;
    bar.render(input([]));
    expect(itemOps()).toEqual([[ITEM, "hide"]]);
  });
});
