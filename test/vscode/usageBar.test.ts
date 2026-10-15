import { beforeEach, describe, expect, it } from "vitest";
import type { Usage } from "../../src/vscode/controller";
import { UsageBar } from "../../src/vscode/usageBar";
import { stub, type Op } from "./stub-vscode";

const ITEM = "statusBar:lookout.usage";

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
      { key: "session", label: "5h", percent: 18, resetsAt: 2 * 3_600_000, windowMs: 5 * 3_600_000 },
      { key: "weekly_all", label: "Week", percent: 31 },
      { key: "weekly_scoped:Fable", label: "Week · Fable", percent: 84 },
    ],
    ...overrides,
  };
}

describe("UsageBar", () => {
  let bar: UsageBar;

  beforeEach(() => {
    stub.reset();
    bar = new UsageBar("lookout.refreshUsage");
    stub.ops.length = 0;
  });

  it("shows the five-hour and weekly numbers with every limit in the hover", () => {
    bar.render(usage(), true, true, 3 * 60_000);
    expect(lastSet("text")).toBe("$(dashboard) 5h 18% · wk 31%");
    const tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).toContain("5h: 18% · resets in 1h 57m");
    expect(tip).toContain("Week · Fable: 84%");
    expect(tip).toContain("As of 3m ago");
    expect(tip).toContain("Click to refresh");
    expect(itemOps().at(-1)).toEqual([ITEM, "show"]);
  });

  it("warns when a limit runs high, unless the numbers are stale", () => {
    bar.render(usage(), true, true, 0);
    expect(lastSet("backgroundColor")).toMatchObject({ id: "statusBarItem.warningBackground" });
    bar.render(usage({ meters: [{ key: "session", label: "5h", percent: 97 }] }), true, true, 0);
    expect(lastSet("backgroundColor")).toMatchObject({ id: "statusBarItem.errorBackground" });
    bar.render(usage({ stale: true }), true, true, 0);
    expect(lastSet("backgroundColor")).toBeUndefined();
    expect((lastSet("tooltip") as { value: string }).value).toMatch(/As of 0s ago \\?\(stale\\?\)/);
  });

  it("offers a fetch when there are no numbers, and hides when there is no way to get them", () => {
    bar.render(undefined, true, true, 0);
    expect(lastSet("text")).toBe("$(dashboard) usage");
    expect((lastSet("tooltip") as { value: string }).value).toContain("No numbers yet");
    stub.ops.length = 0;
    bar.render(undefined, true, false, 0);
    expect(itemOps()).toEqual([[ITEM, "hide"]]);
    bar.render(usage(), false, true, 0);
    expect(itemOps()).toEqual([[ITEM, "hide"]]);
  });

  it("writes only what changed", () => {
    bar.render(usage(), true, true, 0);
    stub.ops.length = 0;
    bar.render(usage(), true, true, 0);
    expect(itemOps()).toEqual([]);
    bar.render(usage(), true, true, 60_000);
    expect(itemOps().map(([, action]) => action)).toEqual(["set:tooltip"]);
  });
});
