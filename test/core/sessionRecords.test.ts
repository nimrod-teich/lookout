import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanNote, latestNote, NOTE_MAX, SessionRecords } from "../../src/core/sessionRecords";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-records-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SEEN = { agent: "claude-code", title: "Wire the cache", cwd: "/work/app", branch: "main", modifiedAt: 1000 };
const texts = (records: SessionRecords, id: string) => records.notesOf(id).map((note) => note.text);

describe("cleanNote", () => {
  it("keeps a note's lines, trims its ends and its lines' trailing blanks, and cuts it to the longest; nothing for nothing", () => {
    expect(cleanNote("  has the  \r\n retag  recipe \n\n")).toBe("has the\n retag  recipe");
    expect(cleanNote("one\n\n\ntwo")).toBe("one\n\n\ntwo");
    expect(cleanNote("x".repeat(NOTE_MAX + 5))).toHaveLength(NOTE_MAX);
    expect(cleanNote("")).toBeUndefined();
    expect(cleanNote("  \n ")).toBeUndefined();
    expect(cleanNote(undefined)).toBeUndefined();
  });
});

describe("SessionRecords", () => {
  it("keeps a thread of notes, each with its own id and time, with what the session was called and where it worked, for another window to read", () => {
    const records = new SessionRecords(dir);
    const first = records.addNote("s1", "has the retag recipe", SEEN, 5000)!;
    const second = records.addNote("s1", "  and the rollback steps\n", SEEN, 7000)!;
    expect(first).toMatchObject({ text: "has the retag recipe", at: 5000 });
    expect(second).toMatchObject({ text: "and the rollback steps", at: 7000 });
    expect(first.id).not.toBe(second.id);
    expect(records.get("s1")).toEqual({ v: 1, id: "s1", ...SEEN, notes: [first, second] });
    expect(fs.readdirSync(dir)).toEqual([path.basename(records.fileOf("s1"))]);
    const other = new SessionRecords(dir);
    expect(texts(other, "s1")).toEqual(["has the retag recipe", "and the rollback steps"]);
    expect(latestNote(other.get("s1"))?.text).toBe("and the rollback steps");
    expect(other.noted().map((record) => record.id)).toEqual(["s1"]);
  });

  it("adds nothing for a blank note, nor for a session nothing is known about", () => {
    const records = new SessionRecords(dir);
    expect(records.addNote("s1", "  \n ", SEEN, 1)).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(records.addNote("s2", "lost", undefined, 2)).toBeUndefined();
    // Known by its record, a session takes a note without being seen.
    records.addNote("s3", "first", SEEN, 3);
    expect(records.addNote("s3", "second", undefined, 4)).toMatchObject({ text: "second" });
    expect(records.get("s3")).toMatchObject({ title: "Wire the cache", cwd: "/work/app" });
  });

  it("changes one note, marking when, and takes it away for a blank text; the record goes with the last note", () => {
    const records = new SessionRecords(dir);
    const a = records.addNote("s1", "first", SEEN, 1)!;
    const b = records.addNote("s1", "second", SEEN, 2)!;
    expect(records.editNote("s1", a.id, "first, changed", 10)).toBe(true);
    expect(records.notesOf("s1")).toEqual([{ ...a, text: "first, changed", editedAt: 10 }, b]);
    // The same text again changes nothing, not even the time.
    expect(records.editNote("s1", a.id, " first, changed ", 20)).toBe(true);
    expect(records.notesOf("s1")[0]?.editedAt).toBe(10);
    // A note or a session not on record: false.
    expect(records.editNote("s1", "nope", "x", 30)).toBe(false);
    expect(records.editNote("s9", a.id, "x", 30)).toBe(false);
    expect(records.removeNote("s1", "nope")).toBe(false);
    // A blank text is a removal.
    expect(records.editNote("s1", a.id, "  ", 40)).toBe(true);
    expect(texts(records, "s1")).toEqual(["second"]);
    expect(records.removeNote("s1", b.id)).toBe(true);
    expect(records.get("s1")).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("takes every note away at once, with nothing to do included", () => {
    const records = new SessionRecords(dir);
    records.addNote("s1", "one", SEEN, 1);
    records.addNote("s1", "two", SEEN, 2);
    expect(records.removeNotes("s1")).toBe(true);
    expect(records.get("s1")).toBeUndefined();
    expect(records.removeNotes("s1")).toBe(true);
  });

  it("follows a session's title and branch while it has a record, and leaves sessions without one alone", () => {
    const records = new SessionRecords(dir);
    records.observe("s9", SEEN);
    expect(records.get("s9")).toBeUndefined();
    const note = records.addNote("s1", "keep", SEEN, 1)!;
    records.observe("s1", { ...SEEN, title: "Wire the cache, again", branch: "fix-cache", modifiedAt: 2000 });
    expect(new SessionRecords(dir).get("s1")).toEqual({ v: 1, id: "s1", agent: "claude-code", title: "Wire the cache, again", cwd: "/work/app", branch: "fix-cache", modifiedAt: 2000, notes: [note] });
    // The same again, or the same without a time, as a running session is seen: nothing written, the time on record kept.
    const before = fs.statSync(records.fileOf("s1")).mtimeMs;
    records.observe("s1", { ...SEEN, title: "Wire the cache, again", branch: "fix-cache", modifiedAt: 2000 });
    records.observe("s1", { agent: SEEN.agent, title: "Wire the cache, again", cwd: SEEN.cwd, branch: "fix-cache" });
    expect(fs.statSync(records.fileOf("s1")).mtimeMs).toBe(before);
    expect(records.get("s1")?.modifiedAt).toBe(2000);
  });

  it("lists the noted sessions by their newest note, newest first", () => {
    const records = new SessionRecords(dir);
    records.addNote("old", "a", SEEN, 1);
    records.addNote("new", "b", SEEN, 3);
    records.addNote("mid", "c", SEEN, 2);
    expect(records.noted().map((record) => record.id)).toEqual(["new", "mid", "old"]);
    // A later note brings its session forward.
    records.addNote("old", "again", SEEN, 4);
    expect(records.noted().map((record) => record.id)).toEqual(["old", "new", "mid"]);
  });

  it("passes over files that are not records, and takes only what a record may hold", () => {
    fs.writeFileSync(path.join(dir, "junk.json"), "{not json");
    fs.writeFileSync(path.join(dir, "other.json"), JSON.stringify({ v: 2, id: "x", agent: "claude-code", notes: [{ id: "a", text: "from a later build", at: 1 }] }));
    fs.writeFileSync(path.join(dir, "noid.json"), JSON.stringify({ v: 1, agent: "claude-code", notes: [{ id: "a", text: "no id", at: 1 }] }));
    fs.writeFileSync(path.join(dir, "readme.txt"), "not a record");
    fs.writeFileSync(
      path.join(dir, "odd.json"),
      JSON.stringify({ v: 1, id: "odd", agent: "codex", title: 7, cwd: "/w", extra: true, notes: [{ id: "b", text: "later", at: 9, editedAt: "soon" }, { id: "a", text: "  spaced \n out ", at: 2 }, { id: "", text: "no id", at: 3 }, { id: "c", text: "  ", at: 4 }, { id: "d", text: "no time" }, "junk"] }),
    );
    const records = new SessionRecords(dir);
    expect([...records.all().keys()]).toEqual(["odd"]);
    // Sorted by time, the broken ones left out.
    expect(records.get("odd")).toEqual({ v: 1, id: "odd", agent: "codex", cwd: "/w", notes: [{ id: "a", text: "spaced\n out", at: 2 }, { id: "b", text: "later", at: 9 }] });
  });

  it("reads a record of the one-note kind as a thread of one", () => {
    const records = new SessionRecords(dir);
    fs.writeFileSync(records.fileOf("s1"), JSON.stringify({ v: 1, id: "s1", agent: "claude-code", title: "Wire the cache", cwd: "/work/app", note: "the old note", noteAt: 5000 }));
    expect(records.notesOf("s1")).toEqual([{ id: "first", text: "the old note", at: 5000 }]);
    // A note added to it keeps the old one first.
    records.addNote("s1", "a new one", undefined, 6000);
    expect(texts(new SessionRecords(dir), "s1")).toEqual(["the old note", "a new one"]);
    expect(JSON.parse(fs.readFileSync(records.fileOf("s1"), "utf8")).note).toBeUndefined();
  });

  it("reads the directory again when another window writes to it", async () => {
    const records = new SessionRecords(dir);
    const listener = vi.fn();
    const watch = records.watch(listener);
    expect(records.notesOf("s1")).toEqual([]);
    try {
      new SessionRecords(dir).addNote("s1", "from another window", SEEN, 1);
      await vi.waitFor(() => expect(listener).toHaveBeenCalled(), { timeout: 10_000 });
      expect(texts(records, "s1")).toEqual(["from another window"]);
    } finally {
      watch.dispose();
    }
  }, 15_000);

  it("adds to the thread as the file has it, not as this window last read it", () => {
    const a = new SessionRecords(dir);
    const b = new SessionRecords(dir);
    a.addNote("s1", "from a", SEEN, 1);
    expect(texts(b, "s1")).toEqual(["from a"]);
    a.addNote("s1", "a again", SEEN, 2);
    // b still holds one note in memory: its note goes after both of a's.
    b.addNote("s1", "from b", SEEN, 3);
    expect(texts(new SessionRecords(dir), "s1")).toEqual(["from a", "a again", "from b"]);
  });

  it("does not bring back a record another window removed, when it follows the session", () => {
    const a = new SessionRecords(dir);
    const b = new SessionRecords(dir);
    const note = a.addNote("s1", "keep", SEEN, 1)!;
    expect(texts(b, "s1")).toEqual(["keep"]);
    a.removeNote("s1", note.id);
    // b still holds it in memory: the session's new title must not write it back.
    b.observe("s1", { ...SEEN, title: "renamed" });
    expect(fs.existsSync(a.fileOf("s1"))).toBe(false);
    expect(b.get("s1")).toBeUndefined();
  });

  it("adds nothing when the record cannot be written", () => {
    const blocked = path.join(dir, "a-file");
    fs.writeFileSync(blocked, "not a directory");
    const records = new SessionRecords(path.join(blocked, "records"));
    expect(records.addNote("s1", "keep", SEEN, 1)).toBeUndefined();
    expect(records.notesOf("s1")).toEqual([]);
  });

  it("sees another window's writes without a watch, by the files' names, sizes and times, once a second at most", () => {
    let clock = 10_000;
    const a = new SessionRecords(dir, () => clock);
    const b = new SessionRecords(dir, () => clock);
    expect(a.all().size).toBe(0);
    const note = b.addNote("s1", "from b", SEEN, 1)!;
    // Within the second: not looked at again.
    expect(texts(a, "s1")).toEqual([]);
    clock += 1500;
    expect(texts(a, "s1")).toEqual(["from b"]);
    b.removeNote("s1", note.id);
    clock += 1500;
    expect(texts(a, "s1")).toEqual([]);
    // A record rewritten under the same name, with the same size: its time tells.
    const first = b.addNote("s2", "first", SEEN, 3)!;
    clock += 1500;
    expect(texts(a, "s2")).toEqual(["first"]);
    b.editNote("s2", first.id, "later", 4);
    clock += 1500;
    expect(texts(a, "s2")).toEqual(["later"]);
  });

  it("lives without its directory until the first note, which creates it", () => {
    const records = new SessionRecords(path.join(dir, "missing", "records"));
    expect(records.all().size).toBe(0);
    expect(records.notesOf("s1")).toEqual([]);
    expect(records.addNote("s1", "first", SEEN, 1)).toBeDefined();
    expect(fs.existsSync(records.fileOf("s1"))).toBe(true);
  });
});
