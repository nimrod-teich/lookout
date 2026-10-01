import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "../../src/vscode/statusBar";
import { view } from "./helpers";
import { stub, type Op } from "./stub-vscode";

const ITEM = "statusBar:lookout.sessions";

function itemOps(): Op[] {
  return stub.ops.filter(([target]) => target === ITEM);
}

function lastSet(prop: string): unknown {
  return itemOps().filter(([, action]) => action === `set:${prop}`).at(-1)?.[2];
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

  it("stays hidden and silent when there are no sessions", () => {
    bar.render([], true);
    bar.render([], true);
    vi.advanceTimersByTime(1000);
    expect(itemOps()).toEqual([]);
  });

  it("shows working, waiting and finished counts with a warning background", () => {
    bar.render(
      [view({ state: "waiting", needs: "permission prompt" }), view({ id: "b", state: "working" }), view({ id: "c", state: "working" }), view({ id: "d", state: "done" })],
      true,
    );
    expect(lastSet("text")).toBe("$(telescope) ⠋ 2  $(bell-dot) 1  $(check) 1");
    expect(lastSet("backgroundColor")).toMatchObject({ id: "statusBarItem.warningBackground" });
    expect(lastSet("accessibilityInformation")).toEqual({ label: "Lookout: 2 working, 1 waiting for you, 1 finished, 0 idle" });
    expect(itemOps().at(-1)).toEqual([ITEM, "show"]);
  });

  it("shows the idle count when nothing is active", () => {
    bar.render([view(), view({ id: "b" }), view({ id: "c", state: "unknown" })], true);
    expect(lastSet("text")).toBe("$(telescope) $(question) 1  2 idle");
    expect(itemOps().some(([, action]) => action === "set:backgroundColor")).toBe(false);
  });

  it("animates the spinner by rewriting only the text, once per frame, while a session works", () => {
    bar.render([view({ state: "working" })], true);
    stub.ops.length = 0;
    vi.advanceTimersByTime(300);
    expect(itemOps()).toEqual([
      [ITEM, "set:text", "$(telescope) ⠙ 1"],
      [ITEM, "set:text", "$(telescope) ⠹ 1"],
      [ITEM, "set:text", "$(telescope) ⠸ 1"],
    ]);
  });

  it("stops the spinner when nothing works, when hidden, and when disposed", () => {
    bar.render([view({ state: "working" })], true);
    bar.render([view({ state: "waiting" })], true);
    stub.ops.length = 0;
    vi.advanceTimersByTime(500);
    expect(itemOps()).toEqual([]);

    bar.render([view({ state: "working" })], true);
    bar.render([view({ state: "working" })], false);
    stub.ops.length = 0;
    vi.advanceTimersByTime(500);
    expect(itemOps()).toEqual([]);

    bar.render([view({ state: "working" })], true);
    bar.dispose();
    stub.ops.length = 0;
    vi.advanceTimersByTime(500);
    expect(itemOps().filter(([, action]) => action === "set:text")).toEqual([]);
  });

  it("writes nothing when the same idle sessions are rendered again", () => {
    const views = [view()];
    bar.render(views, true);
    stub.ops.length = 0;
    bar.render(views, true);
    bar.render([view()], true);
    expect(itemOps()).toEqual([]);
  });

  it("writes only the properties that changed", () => {
    bar.render([view()], true);
    stub.ops.length = 0;
    bar.render([view({ title: "Renamed" })], true);
    expect(itemOps().map(([, action]) => action)).toEqual(["set:tooltip"]);

    stub.ops.length = 0;
    bar.render([view({ state: "waiting", title: "Renamed" })], true);
    expect(itemOps().map(([, action]) => action)).toEqual(["set:text", "set:accessibilityInformation", "set:tooltip", "set:backgroundColor"]);

    stub.ops.length = 0;
    bar.render([view({ title: "Renamed" })], true);
    expect(lastSet("backgroundColor")).toBeUndefined();
    expect(itemOps().filter(([, action]) => action === "set:backgroundColor")).toHaveLength(1);
  });

  it("escapes markdown in titles and shows where each session runs", () => {
    bar.render([view({ state: "waiting", title: "fix *the* #build", needs: "permission prompt", worktree: "hotfix" }), view({ id: "b", state: "done" })], true);
    const tip = lastSet("tooltip") as { value: string; supportThemeIcons: boolean };
    expect(tip.supportThemeIcons).toBe(true);
    expect(tip.value).toContain("$(bell-dot) **fix \\*the\\* \\#build**");
    expect(tip.value).toContain("app · hotfix · Needs you: permission prompt");
    expect(tip.value).toContain("$(check) **Wire the cache**");
  });

  it("hides once when disabled or when the last session ends, and shows again later", () => {
    bar.render([view()], true);
    stub.ops.length = 0;
    bar.render([view()], false);
    bar.render([view()], false);
    expect(itemOps()).toEqual([[ITEM, "hide"]]);

    stub.ops.length = 0;
    bar.render([view()], true);
    expect(itemOps()).toEqual([[ITEM, "show"]]);

    stub.ops.length = 0;
    bar.render([], true);
    expect(itemOps()).toEqual([[ITEM, "hide"]]);
  });
});
