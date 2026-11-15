import { describe, expect, it } from "vitest";
import { TOMBSTONE_MS } from "../../src/core/syncedNotes";
import { changedKeys, localValues, mergeList, mergeState, readLocalState, readSyncedState, type LocalState, type SyncedList, type SyncedState } from "../../src/core/syncedState";

const DAY = 24 * 3_600_000;
const NOW = 1_000 * DAY;

const list = (ids: [string, number][] = [], removed: [string, number][] = []): SyncedList => ({ ids, removed });
const members = (merged: SyncedList) => merged.ids.map(([id]) => id);
const local = (over: Partial<LocalState> = {}): LocalState => ({ favourites: [], archive: [], parking: { parked: [], kept: [] }, claudeOrgs: {}, ...over });
const state = (over: Partial<SyncedState> = {}): SyncedState => ({ v: 1, favourites: list(), archive: list(), parked: list(), kept: list(), claudeOrgs: {}, ...over });

describe("mergeList", () => {
  it("takes this machine's list as older than anything else on its first merge", () => {
    expect(mergeList(undefined, ["a", "b", "a"], undefined, NOW)).toEqual(list([["a", 0], ["b", 0]]));
    // Another machine took "b" out: it stays out here too.
    expect(members(mergeList(undefined, ["a", "b"], list([], [["b", NOW - DAY]]), NOW))).toEqual(["a"]);
  });

  it("counts an id put in since the last merge as put in now, and one taken out as taken out now", () => {
    const base = list([["a", 10], ["b", 20]]);
    expect(mergeList(base, ["c", "a"], undefined, NOW)).toEqual(list([["c", NOW], ["a", 10]], [["b", NOW]]));
  });

  it("keeps this machine's order and puts what the remote copy adds after it", () => {
    const base = list([["a", 10], ["b", 20]]);
    const merged = mergeList(base, ["b", "a"], list([["x", 30], ["a", 10], ["y", 40]]), NOW);
    expect(members(merged)).toEqual(["b", "a", "x", "y"]);
  });

  it("takes nothing out for a remote copy that is missing or lacks an id: only a tombstone takes one out", () => {
    const base = list([["a", 10], ["b", 20]]);
    expect(members(mergeList(base, ["a", "b"], undefined, NOW))).toEqual(["a", "b"]);
    expect(members(mergeList(base, ["a", "b"], list([["a", 10]]), NOW))).toEqual(["a", "b"]);
    expect(members(mergeList(base, ["a", "b"], list(), NOW))).toEqual(["a", "b"]);
  });

  it("takes out here an id another machine took out after it was put in, and keeps one put in again after", () => {
    const put = NOW - 10 * DAY;
    const base = list([["a", put], ["b", put]]);
    const removed = mergeList(base, ["a", "b"], list([["a", put]], [["b", NOW - 2 * DAY]]), NOW);
    expect(removed).toEqual(list([["a", put]], [["b", NOW - 2 * DAY]]));
    // Put in again on another machine after the removal: back, and the tombstone goes.
    const back = mergeList(removed, ["a"], list([["a", put], ["b", NOW - DAY]]), NOW);
    expect(back).toEqual(list([["a", put], ["b", NOW - DAY]]));
    // A stale copy from before the removal does not bring it back.
    expect(members(mergeList(removed, ["a"], list([["a", put], ["b", put]]), NOW))).toEqual(["a"]);
  });

  it("keeps an id taken out here out, whatever stale copy another machine still sends", () => {
    const base = list([["a", 10], ["b", 20]]);
    const here = mergeList(base, ["a"], list([["a", 10], ["b", 20]]), NOW);
    expect(here).toEqual(list([["a", 10]], [["b", NOW]]));
    expect(members(mergeList(here, ["a"], list([["a", 10], ["b", 20]]), NOW + DAY))).toEqual(["a"]);
  });

  it("keeps a tombstone 90 days, then lets it go", () => {
    const base = list([["a", 10]], [["gone", NOW]]);
    expect(mergeList(base, ["a"], undefined, NOW + TOMBSTONE_MS - 1).removed).toEqual([["gone", NOW]]);
    expect(mergeList(base, ["a"], undefined, NOW + TOMBSTONE_MS).removed).toEqual([]);
    // Within them a stale copy stays out; after them it comes back.
    expect(members(mergeList(base, ["a"], list([["gone", 5]]), NOW + 89 * DAY))).toEqual(["a"]);
    expect(members(mergeList(base, ["a"], list([["gone", 5]]), NOW + 91 * DAY))).toEqual(["a", "gone"]);
  });

  it("settles two machines on the same set, whatever the order they merge in, and gives the same value merged again", () => {
    const base = list([["a", 10]]);
    const onA = mergeList(base, ["x", "a"], list(), NOW);
    const onB = mergeList(base, ["y"], list(), NOW + 1);
    const a = mergeList(onA, members(onA), onB, NOW + 2);
    const b = mergeList(onB, members(onB), a, NOW + 3);
    expect(new Set(members(a))).toEqual(new Set(["x", "y"]));
    expect(new Set(members(b))).toEqual(new Set(["x", "y"]));
    expect(mergeList(b, members(b), b, NOW + 4)).toEqual(b);
  });
});

describe("mergeState", () => {
  it("takes this machine's order and grouping when they changed since the last merge, else the remote copy's", () => {
    const base = state({ sort: { by: "time", order: [] }, group: "state" });
    const remote = state({ sort: { by: "name", order: ["s1"] }, group: "project" });
    const unchanged = mergeState(base, local({ sort: { by: "time", order: [] }, group: "state" }), remote, NOW);
    expect([unchanged.sort, unchanged.group]).toEqual([{ by: "name", order: ["s1"] }, "project"]);
    const changed = mergeState(base, local({ sort: { by: "recent", order: [] }, group: "state" }), remote, NOW);
    expect([changed.sort, changed.group]).toEqual([{ by: "recent", order: [] }, "project"]);
    // No remote copy: this machine's.
    expect(mergeState(base, local({ group: "branch" }), undefined, NOW).group).toBe("branch");
    // The first merge takes the remote copy's.
    expect(mergeState(undefined, local({ group: "branch" }), remote, NOW).group).toBe("project");
    expect(mergeState(undefined, local({ group: "branch" }), state(), NOW).group).toBe("branch");
  });

  it("joins the account names, this machine's where they differ", () => {
    const merged = mergeState(state(), local({ claudeOrgs: { o1: "mine", o2: "two" } }), state({ claudeOrgs: { o1: "theirs", o3: "three" } }), NOW);
    expect(merged.claudeOrgs).toEqual({ o1: "mine", o2: "two", o3: "three" });
  });

  it("merges each list on its own, and keeps a session parked or kept, not both: the later wins, parked on a tie", () => {
    const base = state({ parked: list([["p", 10]]), kept: list([["k", 10]]) });
    const remote = state({ parked: list([["p", 10], ["k", 500]]), kept: list([["k", 10], ["p", 600]]) });
    const merged = mergeState(base, local({ parking: { parked: ["p"], kept: ["k"] } }), remote, NOW);
    // "k" was parked after it was kept, "p" kept after it was parked.
    expect(members(merged.parked)).toEqual(["k"]);
    expect(members(merged.kept)).toEqual(["p"]);
    expect(merged.parked.removed).toEqual([["p", 600]]);
    expect(merged.kept.removed).toEqual([["k", 500]]);
    const tie = mergeState(undefined, local({ parking: { parked: [], kept: ["t"] } }), state({ parked: list([["t", 0]]) }), NOW);
    expect([members(tie.parked), members(tie.kept)]).toEqual([["t"], []]);
  });

  it("gives the same value merged again, and the same JSON however the remote copy ordered its fields", () => {
    const base = state({ favourites: list([["a", 10]]), group: "project", claudeOrgs: { o2: "b", o1: "a" } });
    const once = mergeState(base, local({ favourites: ["b", "a"], group: "project", claudeOrgs: { o2: "b", o1: "a" } }), state({ archive: list([["z", 30]]) }), NOW);
    const values = localValues(once);
    const again = mergeState(once, readLocalState((key) => values[key]), JSON.parse(JSON.stringify(once)) as SyncedState, NOW + 1);
    expect(JSON.stringify(again)).toBe(JSON.stringify(once));
    expect(Object.keys(once.claudeOrgs)).toEqual(["o1", "o2"]);
  });
});

describe("readSyncedState", () => {
  it("reads the state, leaving out what does not read", () => {
    const read = readSyncedState({
      v: 1,
      favourites: { ids: [["a", 10], ["", 1], ["b"], "c", ["a", 20], ["x".repeat(300), 1]], removed: [["d", 5], ["d", 7], [3, 4]] },
      archive: "junk",
      kept: { ids: [["k", Number.NaN]] },
      sort: { by: "name", order: ["a", 4] },
      group: "nonsense",
      claudeOrgs: { o1: "key", o2: 5, "": "x" },
    });
    expect(read).toEqual(state({ favourites: list([["a", 20]], [["d", 7]]), sort: { by: "name", order: ["a"] }, claudeOrgs: { o1: "key" } }));
  });

  it("reads nothing from a value that is not the state", () => {
    for (const bad of [undefined, null, "state", [], {}, { v: 2 }, { v: "1" }]) expect(readSyncedState(bad)).toBeUndefined();
  });
});

describe("Lookout's keys", () => {
  it("read as the board keeps them, and say which a merged state changes", () => {
    const keys: Record<string, unknown> = { "lookout.favourites": ["a", 3, "b"], "lookout.parking": { parked: ["p"] }, "lookout.group": "project", "lookout.claudeOrgs": { o1: "k" } };
    const here = readLocalState((key) => keys[key]);
    expect(here).toEqual({ favourites: ["a", "b"], archive: [], parking: { parked: ["p"], kept: [] }, group: "project", claudeOrgs: { o1: "k" } });
    const same = mergeState(undefined, here, undefined, NOW);
    expect(changedKeys(here, same)).toEqual([]);
    const more = mergeState(same, here, state({ favourites: list([["c", 5]]), archive: list([["z", 5]]), sort: { by: "name", order: [] } }), NOW);
    expect(changedKeys(here, more)).toEqual(["lookout.favourites", "lookout.archive", "lookout.sort"]);
    expect(localValues(more)).toEqual({
      "lookout.favourites": ["a", "b", "c"],
      "lookout.archive": ["z"],
      "lookout.parking": { parked: ["p"], kept: [] },
      "lookout.sort": { by: "name", order: [] },
      "lookout.group": "project",
      "lookout.claudeOrgs": { o1: "k" },
    });
  });
});
