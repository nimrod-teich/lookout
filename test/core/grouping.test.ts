import { describe, expect, it } from "vitest";
import { GROUPINGS, groupValue, isGroupBy, readGroupBy, sectionsBy } from "../../src/core/grouping";
import { view } from "../vscode/helpers";

const ids = (sections: { views: { id: string }[] }[]) => sections.map((s) => s.views.map((v) => v.id));

describe("groupValue", () => {
  it("names the project, branch, model, agent and window a session has, and nothing for what it lacks", () => {
    const v = view({ project: "api", branch: "main", model: "claude-opus-5-5", agent: "codex", host: "window", windowLabel: "web" });
    expect(groupValue(v, "project")).toBe("api");
    expect(groupValue(v, "branch")).toBe("main");
    expect(groupValue(v, "model")).toBe("Opus 5.5");
    expect(groupValue(v, "agent")).toBe("Codex");
    expect(groupValue(view({ account: "personal" }), "account")).toBe("personal");
    expect(groupValue(v, "account")).toBeUndefined();
    expect(groupValue(v, "window")).toBe("Window: web");
    expect(groupValue(view({ project: "", branch: undefined, model: undefined }), "project")).toBeUndefined();
    expect(groupValue(view({ branch: undefined }), "branch")).toBeUndefined();
    expect(groupValue(view({ model: undefined }), "model")).toBeUndefined();
    expect(groupValue(view({ host: "panel" }), "window")).toBe("This window");
    expect(groupValue(view({ host: "terminal" }), "window")).toBe("This window");
    expect(groupValue(view({ host: "window" }), "window")).toBe("Another window");
    expect(groupValue(view({ host: "editor" }), "window")).toBe("Window without Lookout");
    expect(groupValue(view({ host: "elsewhere" }), "window")).toBe("Outside VS Code");
  });
});

describe("sectionsBy", () => {
  const views = [
    view({ id: "w", state: "waiting", project: "web" }),
    view({ id: "a1", state: "working", project: "api" }),
    view({ id: "p", state: "idle", project: "api", parked: true }),
    view({ id: "z", state: "done", project: "zeta" }),
    view({ id: "a2", state: "idle", project: "api" }),
    view({ id: "n", state: "idle", project: "" }),
  ];

  it("pins the sessions that need you first, then one section per value A to Z, the valueless last, then Parked", () => {
    const sections = sectionsBy(views, "project");
    expect(sections.map((s) => [s.id, s.label])).toEqual([
      ["waiting", "Needs you"],
      ["project:api", "api"],
      ["project:zeta", "zeta"],
      ["project:", "No project"],
      ["parked", "Parked"],
    ]);
    expect(ids(sections)).toEqual([["w"], ["a1", "a2"], ["z"], ["n"], ["p"]]);
  });

  it("counts the states each section holds, and keeps the order the views come in", () => {
    const sections = sectionsBy(views, "project");
    expect(sections[1]?.summary).toEqual({ working: 1, idle: 1 });
    expect(sections[2]?.summary).toEqual({ done: 1 });
    expect(sections[0]?.summary).toBeUndefined();
    expect(sections[4]?.summary).toBeUndefined();
    expect(sectionsBy([], "model")).toEqual([]);
  });

  it("sorts values as text, numbers as numbers", () => {
    const sections = sectionsBy([view({ id: "b", branch: "feat/10" }), view({ id: "a", branch: "feat/9" }), view({ id: "c", branch: "Main" })], "branch");
    expect(sections.map((s) => s.label)).toEqual(["feat/9", "feat/10", "Main"]);
  });
});

describe("readGroupBy", () => {
  it("reads back only a grouping on offer, state otherwise", () => {
    expect(GROUPINGS.map((g) => g.key).every(isGroupBy)).toBe(true);
    expect(readGroupBy("project")).toBe("project");
    expect(readGroupBy("size")).toBe("state");
    expect(readGroupBy(undefined)).toBe("state");
    expect(GROUPINGS.every((g) => g.short.length <= 8)).toBe(true);
  });
});

describe("sectionsBy account", () => {
  it("makes a section per account, the sessions of agents without one last", () => {
    const sections = sectionsBy(
      [view({ id: "c", agent: "codex" }), view({ id: "p", account: "personal" }), view({ id: "d", account: "default" }), view({ id: "w", state: "waiting", account: "personal" })],
      "account",
    );
    expect(sections.map((s) => [s.id, s.label])).toEqual([
      ["waiting", "Needs you"],
      ["account:default", "default"],
      ["account:personal", "personal"],
      ["account:", "No account"],
    ]);
    expect(ids(sections)).toEqual([["w"], ["d"], ["p"], ["c"]]);
    expect(GROUPINGS.map((g) => g.key)).toContain("account");
    expect(readGroupBy("account")).toBe("account");
  });
});
