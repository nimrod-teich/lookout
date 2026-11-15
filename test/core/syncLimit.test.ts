import { describe, expect, it } from "vitest";
import type { NoteEntry } from "../../src/core/sessionRecords";
import type { SessionNotes } from "../../src/core/syncedNotes";
import type { Stamped, SyncedList, SyncedState } from "../../src/core/syncedState";
import { fitSync, SYNC_LIMIT, syncBytes } from "../../src/core/syncLimit";

const NOW = 1_000 * 24 * 3_600_000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const list = (ids: Stamped[] = [], removed: Stamped[] = []): SyncedList => ({ ids, removed });
const state = (over: Partial<SyncedState> = {}): SyncedState => ({ v: 1, favourites: list(), archive: list(), parked: list(), kept: list(), claudeOrgs: {}, ...over });
const note = (n: string, text: string, at: number): NoteEntry => ({ id: n, text, at });
const session = (notes: NoteEntry[]): SessionNotes => ({ agent: "claude-code", title: "Wire the cache", notes, removed: [] });

/** `count` sessions archived one a second, the newest first, as the board keeps them. */
function archive(count: number, from = 0): Stamped[] {
  return Array.from({ length: count }, (_, i) => [id(from + count - 1 - i), NOW + (count - 1 - i) * 1000] as Stamped);
}

/** `count` sessions with one long note each, the first noted first. */
function noted(count: number, size: number): Map<string, SessionNotes> {
  return new Map(Array.from({ length: count }, (_, i) => [`s${i}`, session([note(`n${i}`, `${i} `.padEnd(size, "x"), NOW + i * 1000)])]));
}

describe("fitSync", () => {
  it("leaves both values whole while they fit, and counts their bytes as the JSON of both keys", () => {
    const whole = state({ favourites: list([[id(1), 5]]), sort: { by: "name", order: [] }, claudeOrgs: { o1: "k" } });
    const fit = fitSync(whole, noted(3, 100));
    expect(fit.state).toEqual(whole);
    expect(Object.keys(fit.notes.sessions)).toEqual(["s0", "s1", "s2"]);
    expect([fit.archiveLeft, fit.sessionsLeft, fit.notesLeft, fit.restLeft]).toEqual([0, 0, 0, 0]);
    expect(fit.bytes).toBe(syncBytes(fit.state, fit.notes));
    expect(fit.bytes).toBe(Buffer.byteLength(JSON.stringify({ "lookout.sync.state": fit.state, "lookout.sync.notes": fit.notes })));
  });

  it("leaves the archive's oldest sessions out first, keeping the notes and the rest whole", () => {
    const whole = state({ archive: list(archive(3000)), favourites: list([[id(9999), 5]]) });
    const fit = fitSync(whole, noted(3, 100));
    expect(fit.bytes).toBeLessThanOrEqual(SYNC_LIMIT);
    expect(fit.archiveLeft).toBeGreaterThan(0);
    expect(fit.state.archive.ids.length + fit.archiveLeft).toBe(3000);
    // The newest stay, in the list's order.
    expect(fit.state.archive.ids).toEqual(whole.archive.ids.slice(0, fit.state.archive.ids.length));
    expect(fit.state.favourites).toEqual(whole.favourites);
    expect(Object.keys(fit.notes.sessions)).toHaveLength(3);
    // As many as fit: one more would not.
    const more = { ...fit.state, archive: list(whole.archive.ids.slice(0, fit.state.archive.ids.length + 1)) };
    expect(syncBytes(more, fit.notes)).toBeGreaterThan(SYNC_LIMIT);
  });

  it("orders the archive by when each session went in, and by its place for those that went in at once", () => {
    const ids: Stamped[] = [
      ["a", 0],
      ["b", 300],
      ["c", 0],
      ["d", 200],
    ];
    const whole = state({ archive: list(ids) });
    const three = state({ archive: list([ids[0]!, ids[1]!, ids[3]!]) });
    const fit = fitSync(whole, new Map(), syncBytes(three, { v: 1, sessions: {} }));
    expect(fit.state).toEqual(three);
    expect(fit.archiveLeft).toBe(1);
  });

  it("then leaves out the notes of the sessions that changed longest ago, and every older one", () => {
    const sessions = noted(12, 8000);
    sessions.set("tiny", session([note("t", "t", NOW - 5)]));
    const fit = fitSync(state({ archive: list(archive(50)) }), sessions);
    expect(fit.bytes).toBeLessThanOrEqual(SYNC_LIMIT);
    expect(fit.archiveLeft).toBe(50);
    const kept = Object.keys(fit.notes.sessions);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(12);
    // The newest stay; the small old one goes with the rest.
    expect(new Set(kept)).toEqual(new Set(Array.from({ length: kept.length }, (_, i) => `s${11 - i}`)));
    expect(fit.sessionsLeft).toBe(13 - kept.length);
    expect(fit.notesLeft).toBe(13 - kept.length);
    expect(fit.restLeft).toBe(0);
  });

  it("past that, leaves out the oldest tombstones and then the oldest kept, parked and starred sessions, never the order, grouping or account names", () => {
    const many = (count: number, from: number) => Array.from({ length: count }, (_, i) => [id(from + i), NOW - i * 1000] as Stamped);
    const whole = state({ favourites: list(many(400, 0), many(400, 10_000)), parked: list(many(400, 20_000)), kept: list(many(800, 30_000)), sort: { by: "name", order: [id(1)] }, group: "project", claudeOrgs: { o1: "k" } });
    const fit = fitSync(whole, new Map());
    expect(fit.bytes).toBeLessThanOrEqual(SYNC_LIMIT);
    expect(fit.restLeft).toBeGreaterThan(400);
    expect(fit.state.favourites.removed).toEqual([]);
    expect(fit.state.kept.ids.length).toBeLessThan(800);
    expect(fit.state.kept.ids).toEqual(whole.kept.ids.slice(0, fit.state.kept.ids.length));
    expect(fit.state.parked).toEqual(whole.parked);
    expect(fit.state.favourites.ids).toEqual(whole.favourites.ids);
    expect([fit.state.sort, fit.state.group, fit.state.claudeOrgs]).toEqual([whole.sort, whole.group, whole.claudeOrgs]);
  });

  it("chooses the same on every machine with the same state and notes", () => {
    const whole = state({ archive: list(archive(2000)) });
    const one = fitSync(whole, noted(5, 6000));
    const two = fitSync(JSON.parse(JSON.stringify(whole)) as SyncedState, new Map([...noted(5, 6000)].reverse()));
    expect(JSON.stringify(two.state)).toBe(JSON.stringify(one.state));
    expect(JSON.stringify(two.notes)).toBe(JSON.stringify(one.notes));
  });
});
