import { describe, expect, it } from "vitest";
import { DEFAULT_SORT, dragInto, isSortKey, orderViews, readSort, SORTS } from "../../src/core/sorting";
import { view } from "../vscode/helpers";

const ids = (views: { id: string }[]) => views.map((v) => v.id);

describe("orderViews", () => {
  const views = [
    view({ id: "a", title: "zeta", project: "web", since: 3 }),
    view({ id: "b", title: "Alpha", project: "api", worktree: "w2", since: 1 }),
    view({ id: "c", title: "beta", project: "api", worktree: "w1", since: 2 }),
    view({ id: "d", title: "item 10", project: "web", since: undefined }),
    view({ id: "e", title: "item 9", project: "web", since: 5 }),
  ];

  it("keeps the extension's order for the default, longest in its state first", () => {
    expect(ids(orderViews(views, DEFAULT_SORT))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("orders by latest change, name (numbers as numbers, any case) and project", () => {
    expect(ids(orderViews(views, { by: "recent", order: [] }))).toEqual(["e", "a", "c", "b", "d"]);
    expect(ids(orderViews(views, { by: "name", order: [] }))).toEqual(["b", "c", "e", "d", "a"]);
    expect(ids(orderViews(views, { by: "project", order: [] }))).toEqual(["c", "b", "e", "d", "a"]);
  });

  it("follows the user's order, with sessions it does not place first, as they came", () => {
    expect(ids(orderViews(views, { by: "custom", order: ["e", "c", "a"] }))).toEqual(["b", "d", "e", "c", "a"]);
    expect(ids(orderViews(views, { by: "custom", order: [] }))).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("dragInto", () => {
  it("moves the dragged session before another, or to the end, and puts the group first", () => {
    expect(dragInto(["x", "a", "b", "c"], ["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b", "x"]);
    expect(dragInto(["a", "b", "c"], ["a", "b", "c"], "a", undefined)).toEqual(["b", "c", "a"]);
    expect(dragInto(["a", "b", "c"], ["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    // Dropped where it was: nothing moves.
    expect(dragInto(["a", "b"], ["a", "b"], "a", "b")).toEqual(["a", "b"]);
    // A group not in the order yet takes its place in it.
    expect(dragInto([], ["a", "b"], "b", "a")).toEqual(["b", "a"]);
    // A session to go before that the group does not hold: the end.
    expect(dragInto([], ["a", "b"], "a", "gone")).toEqual(["b", "a"]);
  });
});

describe("readSort", () => {
  it("reads back only a known order and ids", () => {
    expect(readSort({ by: "name", order: ["a", 3, "b"] })).toEqual({ by: "name", order: ["a", "b"] });
    expect(readSort({ by: "size" })).toEqual(DEFAULT_SORT);
    expect(readSort(undefined)).toEqual(DEFAULT_SORT);
    expect(SORTS.map((s) => s.key).every(isSortKey)).toBe(true);
    expect(isSortKey("size")).toBe(false);
  });
});
