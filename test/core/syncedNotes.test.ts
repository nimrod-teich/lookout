import { describe, expect, it } from "vitest";
import type { NoteEntry } from "../../src/core/sessionRecords";
import { NOTE_MAX } from "../../src/core/sessionRecords";
import { lastChange, mergeNotes, readSessionNotes, readSyncedNotes, syncedNotes, TOMBSTONE_MS, type SessionNotes } from "../../src/core/syncedNotes";

const DAY = 24 * 3_600_000;
const NOW = 1_000 * DAY;

const note = (id: string, text: string, at: number, editedAt?: number): NoteEntry => (editedAt === undefined ? { id, text, at } : { id, text, at, editedAt });
const value = (notes: NoteEntry[], removed: { id: string; at: number }[] = [], title?: string): SessionNotes => (title === undefined ? { agent: "claude-code", notes, removed } : { agent: "claude-code", title, notes, removed });
const local = (notes: NoteEntry[], title = "Wire the cache") => ({ agent: "claude-code", title, notes });
const texts = (merged: SessionNotes | undefined) => merged?.notes.map((n) => n.text);

describe("readSessionNotes", () => {
  it("reads a session's notes, cleaning each note's text and leaving out what does not read", () => {
    const read = readSessionNotes({
      agent: "claude-code",
      title: "Wire the cache",
      notes: [note("b", "second  \r\n", 20), { id: "", text: "no id", at: 1 }, { id: "c", text: "  ", at: 1 }, { id: "d", text: "no time" }, null, "junk", note("a", "first", 10, 15)],
      removed: [{ id: "x", at: 5 }, { id: "y" }, { at: 3 }, null],
    });
    expect(read).toEqual(value([note("a", "first", 10, 15), note("b", "second", 20)], [{ id: "x", at: 5 }], "Wire the cache"));
  });

  it("keeps the later change of two notes with one id, and cuts a note to the longest", () => {
    const read = readSessionNotes({ agent: "codex", notes: [note("a", "old", 1, 2), note("a", "new", 1, 9), note("b", "x".repeat(NOTE_MAX + 10), 3)], removed: [] });
    expect(read?.notes.map((n) => [n.id, n.text.length])).toEqual([
      ["a", 3],
      ["b", NOTE_MAX],
    ]);
    expect(read?.notes[0]?.text).toBe("new");
  });

  it("reads nothing from a value that is not a session's notes", () => {
    for (const bad of [undefined, null, "notes", 42, [], {}, { agent: "", notes: [] }, { agent: "claude-code" }, { agent: "claude-code", notes: {} }]) {
      expect(readSessionNotes(bad)).toBeUndefined();
    }
  });
});

describe("readSyncedNotes", () => {
  it("reads every session's notes, leaving out a session whose id or notes do not read", () => {
    const one = value([note("a", "first", 10)], [], "Wire the cache");
    const read = readSyncedNotes({ v: 1, sessions: { s1: one, s2: { agent: "" }, ["x".repeat(300)]: one, "": one, s3: value([], [{ id: "g", at: 5 }]) } });
    expect([...(read ?? [])]).toEqual([
      ["s1", one],
      ["s3", value([], [{ id: "g", at: 5 }])],
    ]);
  });

  it("reads nothing from a value that is not every session's notes", () => {
    for (const bad of [undefined, null, "notes", [], {}, { v: 2, sessions: {} }, { v: 1 }, { v: 1, sessions: [] }, { v: "1", sessions: {} }]) {
      expect(readSyncedNotes(bad)).toBeUndefined();
    }
  });

  it("writes the sessions in the order of their ids, so machines with the same notes write the same JSON", () => {
    const a = value([note("a", "x", 1)]);
    const b = value([note("b", "y", 2)]);
    const one = syncedNotes(new Map([["s2", b], ["s1", a]]));
    const two = syncedNotes(new Map([["s1", a], ["s2", b]]));
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(Object.keys(one.sessions)).toEqual(["s1", "s2"]);
    expect(readSyncedNotes(JSON.parse(JSON.stringify(one)))).toEqual(new Map([["s1", a], ["s2", b]]));
  });
});

describe("mergeNotes", () => {
  it("puts this machine's notes in the synced copy the first time", () => {
    const merged = mergeNotes(undefined, local([note("a", "first", 10)]), undefined, NOW);
    expect(merged).toEqual(value([note("a", "first", 10)], [], "Wire the cache"));
  });

  it("keeps both notes when each machine added one before they synced", () => {
    const fromA = mergeNotes(undefined, local([note("a", "from A", 10)]), undefined, NOW)!;
    const fromB = mergeNotes(undefined, local([note("b", "from B", 20)]), undefined, NOW)!;
    // Settings Sync keeps one machine's copy of the key: B's reaches A, and A's copy is gone.
    const onA = mergeNotes(fromA, local([note("a", "from A", 10)]), fromB, NOW + 1)!;
    expect(texts(onA)).toEqual(["from A", "from B"]);
    // A's merge reaches B.
    const onB = mergeNotes(fromB, local([note("b", "from B", 20)]), onA, NOW + 2)!;
    expect(onB).toEqual(onA);
  });

  it("makes a tombstone of a note taken away here since the last merge, and takes away a note another machine removed", () => {
    const base = value([note("a", "keep", 10), note("b", "drop", 20)]);
    const here = mergeNotes(base, local([note("a", "keep", 10)]), base, NOW)!;
    expect(here.notes.map((n) => n.id)).toEqual(["a"]);
    expect(here.removed).toEqual([{ id: "b", at: NOW }]);
    // The other machine still has "b" on record: the tombstone takes it away there.
    const there = mergeNotes(base, local([note("a", "keep", 10), note("b", "drop", 20)]), here, NOW + 5)!;
    expect(there).toEqual(here);
  });

  it("takes nothing away for a synced copy that is missing or lacks a note: only a tombstone removes one", () => {
    const base = value([note("a", "one", 10), note("b", "two", 20)]);
    expect(texts(mergeNotes(base, local(base.notes), undefined, NOW))).toEqual(["one", "two"]);
    expect(texts(mergeNotes(base, local(base.notes), value([note("a", "one", 10)]), NOW))).toEqual(["one", "two"]);
  });

  it("keeps the later edit of a note edited on two machines, the same one on both", () => {
    const base = value([note("a", "draft", 10)]);
    const onA = local([note("a", "edited on A", 10, 30)]);
    const onB = local([note("a", "edited on B", 10, 40)]);
    const a = mergeNotes(base, onA, mergeNotes(base, onB, base, NOW), NOW)!;
    const b = mergeNotes(base, onB, mergeNotes(base, onA, base, NOW), NOW)!;
    expect(texts(a)).toEqual(["edited on B"]);
    expect(b).toEqual(a);
    // Edits at the same moment: both machines pick the same one.
    const same1 = local([note("a", "apple", 10, 50)]);
    const same2 = local([note("a", "banana", 10, 50)]);
    expect(mergeNotes(base, same1, mergeNotes(base, same2, base, NOW), NOW)).toEqual(mergeNotes(base, same2, mergeNotes(base, same1, base, NOW), NOW));
  });

  it("lets the later of an edit and a removal win: a note edited after its removal comes back, one edited before stays removed", () => {
    const base = value([note("a", "draft", 10)]);
    // A removes the note at NOW.
    const removedOnA = mergeNotes(base, local([]), base, NOW)!;
    expect(removedOnA.removed).toEqual([{ id: "a", at: NOW }]);
    expect(removedOnA.notes).toEqual([]);

    // B edited it before that: the removal wins, on B and then on A.
    const editedBefore = local([note("a", "edited before", 10, NOW - 1000)]);
    const onB = mergeNotes(base, editedBefore, removedOnA, NOW + 10)!;
    expect(onB.notes).toEqual([]);
    expect(onB.removed).toEqual([{ id: "a", at: NOW }]);

    // B edited it after that: the edit wins, and the tombstone goes, on B and then on A.
    const editedAfter = local([note("a", "edited after", 10, NOW + 1000)]);
    const onB2 = mergeNotes(base, editedAfter, removedOnA, NOW + 2000)!;
    expect(texts(onB2)).toEqual(["edited after"]);
    expect(onB2.removed).toEqual([]);
    const onA2 = mergeNotes(removedOnA, local([]), onB2, NOW + 3000)!;
    expect(onA2).toEqual(onB2);

    // The other way round: B removes, A's synced copy carries an edit made after.
    const removedOnB = mergeNotes(base, local([]), base, NOW + 5000)!;
    const editOnA = mergeNotes(base, local([note("a", "edited on A", 10, NOW + 6000)]), removedOnB, NOW + 7000)!;
    expect(texts(editOnA)).toEqual(["edited on A"]);
    expect(mergeNotes(removedOnB, local([]), editOnA, NOW + 8000)).toEqual(editOnA);
  });

  it("keeps a tombstone 90 days, then lets it go; a machine that still has the note after that brings it back", () => {
    const tombstoned = value([note("a", "kept", 10)], [{ id: "gone", at: NOW }]);
    const later = (days: number) => mergeNotes(tombstoned, local([note("a", "kept", 10)]), tombstoned, NOW + days * DAY)!;
    expect(later(89).removed).toEqual([{ id: "gone", at: NOW }]);
    expect(later(90).removed).toEqual([]);
    // Within 90 days, a stale copy of the note stays removed.
    const stale = value([note("a", "kept", 10), note("gone", "old note", 5)]);
    expect(texts(mergeNotes(tombstoned, local([note("a", "kept", 10)]), stale, NOW + 89 * DAY))).toEqual(["kept"]);
    // After them, it comes back, at once and for good.
    const back = mergeNotes(tombstoned, local([note("a", "kept", 10)]), stale, NOW + 91 * DAY)!;
    expect(texts(back)).toEqual(["old note", "kept"]);
    expect(mergeNotes(back, local(back.notes), back, NOW + 92 * DAY)).toEqual(back);
    // A session whose notes are all gone, its tombstones expired, has nothing left to sync.
    expect(mergeNotes(value([], [{ id: "x", at: NOW }]), local([]), undefined, NOW + TOMBSTONE_MS)).toBeUndefined();
  });

  it("gives a note taken away here a fresh tombstone even when an expired one names it", () => {
    const base = value([note("a", "note", 10)]);
    const remote = value([note("a", "note", 10)], [{ id: "a", at: NOW - TOMBSTONE_MS - 1 }]);
    expect(mergeNotes(base, local([]), remote, NOW)?.removed).toEqual([{ id: "a", at: NOW }]);
  });

  it("ignores a synced copy that does not read, and never loses this machine's notes to it", () => {
    const mine = local([note("a", "mine", 10)]);
    const base = value([note("a", "mine", 10)]);
    for (const garbage of ["oops", null, { agent: "claude-code" }, { notes: "x" }, [1, 2, 3]]) {
      expect(mergeNotes(base, mine, readSessionNotes(garbage), NOW)).toEqual(value([note("a", "mine", 10)], [], "Wire the cache"));
    }
  });

  it("gives the same value merged again, and the same value on every machine whatever the order", () => {
    const base = value([note("a", "one", 10), note("b", "two", 20)], [{ id: "z", at: NOW - DAY }]);
    const here = local([note("a", "one", 10, 25), note("c", "three", 30)]);
    const remote = value([note("a", "one", 10), note("b", "two", 20), note("d", "four", 40)], [{ id: "y", at: NOW - 2 * DAY }]);
    const once = mergeNotes(base, here, remote, NOW)!;
    expect(mergeNotes(once, local(once.notes), once, NOW)).toEqual(once);
    expect(texts(once)).toEqual(["one", "three", "four"]);
    expect(once.removed).toEqual([
      { id: "b", at: NOW },
      { id: "y", at: NOW - 2 * DAY },
      { id: "z", at: NOW - DAY },
    ]);
    expect(JSON.stringify(mergeNotes(once, local(once.notes), JSON.parse(JSON.stringify(once)), NOW))).toBe(JSON.stringify(once));
  });

  it("settles every machine on the synced copy's agent and title, and fills in the title when it has none", () => {
    const remote = value([note("a", "x", 1)], [], "Named on B");
    expect(mergeNotes(undefined, local([note("a", "x", 1)], "Named on A"), remote, NOW)?.title).toBe("Named on B");
    expect(mergeNotes(remote, local([note("a", "x", 1)], "Named on A"), undefined, NOW)?.title).toBe("Named on B");
    expect(mergeNotes(undefined, local([note("a", "x", 1)], "Named on A"), value([note("a", "x", 1)]), NOW)?.title).toBe("Named on A");
  });

  it("brings a session this machine has no record of, with what it is called", () => {
    const remote = value([note("a", "from elsewhere", 10)], [], "Wire the cache");
    expect(mergeNotes(undefined, { notes: [] }, remote, NOW)).toEqual(remote);
  });
});

describe("lastChange", () => {
  it("is when a note was last written, edited or taken away", () => {
    expect(lastChange(value([note("a", "a", 100)]))).toBe(100);
    expect(lastChange(value([note("b", "b", 50, 300)]))).toBe(300);
    expect(lastChange(value([note("c", "c", 10)], [{ id: "x", at: 200 }]))).toBe(200);
    expect(lastChange(value([]))).toBe(0);
  });
});
