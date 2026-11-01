import { describe, expect, it } from "vitest";
import { agoOf, clock, filterWords, matchesFilter, nextTicks, plural, SECTIONS, sortRows } from "../../src/webview/worktreesModel";
import type { WorktreeRow } from "../../src/webview/worktreesProtocol";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function row(name: string, tier: WorktreeRow["tier"], extra: Partial<WorktreeRow> = {}): WorktreeRow {
  return { path: `/w/${name}`, repo: "/r", name, branch: `feat/${name}`, tier, reason: "already on origin/main", ownBytes: 1, sharedBytes: 0, ...extra };
}

describe("agoOf", () => {
  it("says how long ago in the shortest unit that fits, never less than a minute", () => {
    const now = 100 * DAY;
    expect(agoOf(now, now)).toBe("1m");
    expect(agoOf(now - 5 * MINUTE, now)).toBe("5m");
    expect(agoOf(now - 3 * HOUR, now)).toBe("3h");
    expect(agoOf(now - 47 * HOUR, now)).toBe("47h");
    expect(agoOf(now - 26 * DAY, now)).toBe("26d");
    expect(agoOf(now - 4 * 30 * DAY, now)).toBe("4mo");
    expect(agoOf(now - 2 * 365 * DAY, now)).toBe("2y");
    expect(agoOf(now + DAY, now)).toBe("1m");
  });

  it("pads the clock", () => {
    const at = new Date(2026, 0, 1, 9, 5).getTime();
    expect(clock(at)).toBe("09:05");
    expect(plural(1, "worktree")).toBe("1 worktree");
    expect(plural(2, "repository", "repositories")).toBe("2 repositories");
  });
});

describe("nextTicks", () => {
  it("starts the safe rows and the records ticked, and nothing else", () => {
    const rows = [row("s", "safe"), row("r", "review"), row("k", "keep"), row("g", "gone")];
    expect([...nextTicks([], rows, new Set())].sort()).toEqual(["/w/g", "/w/s"]);
    expect(SECTIONS.filter((section) => section.ticked).map((section) => section.tier)).toEqual(["safe", "gone"]);
  });

  it("keeps the ticks of rows the check left in their tiers, and starts the others afresh", () => {
    const before = [row("a", "safe"), row("b", "safe"), row("c", "review"), row("d", "review")];
    // a was unticked by hand, c was ticked by hand.
    const ticked = new Set(["/w/b", "/w/c"]);
    const after = [
      row("a", "safe"), // the same tier: stays unticked
      row("b", "review"), // moved to review: its tick goes
      row("c", "review"), // the same tier: stays ticked
      row("d", "safe"), // moved to safe: ticked, as safe starts
      row("e", "safe"), // new: ticked
    ];
    expect([...nextTicks(before, after, ticked)].sort()).toEqual(["/w/c", "/w/d", "/w/e"]);
  });
});

describe("the filter", () => {
  it("splits words and lower-cases them", () => {
    expect(filterWords("  Ops  env ")).toEqual(["ops", "env"]);
    expect(filterWords("")).toEqual([]);
  });

  it("keeps a row when every word is in its name, branch, reason, folder, ignored files or repository", () => {
    const r = row("ops-4741", "review", { reason: "1 ignored file no tool builds again", ignored: ["ops/fleet.kubeconfig"], where: "~/src/_worktrees" });
    expect(matchesFilter(r, [], "infra")).toBe(true);
    expect(matchesFilter(r, ["4741"], "infra")).toBe(true);
    expect(matchesFilter(r, ["feat/ops"], "infra")).toBe(true);
    expect(matchesFilter(r, ["ignored", "tool"], "infra")).toBe(true);
    expect(matchesFilter(r, ["_worktrees"], "infra")).toBe(true);
    expect(matchesFilter(r, ["kubeconfig"], "infra")).toBe(true);
    expect(matchesFilter(r, ["infra"], "infra")).toBe(true);
    expect(matchesFilter(r, ["INFRA"], "infra")).toBe(false);
    expect(matchesFilter(r, ["4741", "web"], "infra")).toBe(false);
    expect(matchesFilter(r, ["infra"])).toBe(false);
  });
});

describe("sortRows", () => {
  it("puts the biggest first, or the oldest commit first with no commit last, the folder breaking ties", () => {
    const rows = [row("b", "safe", { ownBytes: 5, headAt: 300 }), row("a", "safe", { ownBytes: 5, headAt: 100 }), row("c", "safe", { ownBytes: 9 }), row("d", "safe", { ownBytes: 1, headAt: 200 })];
    expect(sortRows(rows, "size").map((r) => r.name)).toEqual(["c", "a", "b", "d"]);
    expect(sortRows(rows, "age").map((r) => r.name)).toEqual(["a", "d", "b", "c"]);
    expect(rows.map((r) => r.name)).toEqual(["b", "a", "c", "d"]);
  });
});
