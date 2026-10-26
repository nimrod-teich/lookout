import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanNote, NOTE_MAX, SessionRecords } from "../../src/core/sessionRecords";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-records-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SEEN = { agent: "claude-code", title: "Wire the cache", cwd: "/work/app", branch: "main", modifiedAt: 1000 };

describe("cleanNote", () => {
  it("trims a note, joins its lines, and keeps at most one line's worth; nothing for nothing", () => {
    // Lines stay lines: only a line's trailing blanks, the blank lines at either end and the line-end kind change.
    expect(cleanNote("  has the  \r\n retag  recipe \n\n")).toBe("has the\n retag  recipe");
    expect(cleanNote("one\n\n\ntwo")).toBe("one\n\n\ntwo");
    expect(cleanNote("x".repeat(NOTE_MAX + 5))).toHaveLength(NOTE_MAX);
    expect(cleanNote("")).toBeUndefined();
    expect(cleanNote("  \n ")).toBeUndefined();
    expect(cleanNote(undefined)).toBeUndefined();
  });
});

describe("SessionRecords", () => {
  it("keeps a note with what the session was called and where it worked, for another window to read", () => {
    const records = new SessionRecords(dir);
    expect(records.setNote("s1", "has the retag recipe", SEEN, 5000)).toBe(true);
    expect(records.get("s1")).toEqual({ v: 1, id: "s1", ...SEEN, note: "has the retag recipe", noteAt: 5000 });
    expect(fs.readdirSync(dir)).toEqual([path.basename(records.fileOf("s1"))]);
    const other = new SessionRecords(dir);
    expect(other.noteOf("s1")).toBe("has the retag recipe");
    expect(other.noted().map((record) => record.id)).toEqual(["s1"]);
    // The same note again, with blanks around it: nothing changes, and the note keeps its time.
    expect(other.setNote("s1", "  has the retag recipe \n\n", SEEN, 9000)).toBe(true);
    expect(other.get("s1")?.noteAt).toBe(5000);
  });

  it("changes a note, takes it away with an empty one, and keeps nothing of a session without one", () => {
    const records = new SessionRecords(dir);
    records.setNote("s1", "first", SEEN, 1);
    expect(records.setNote("s1", "second", SEEN, 2)).toBe(true);
    expect(records.get("s1")).toMatchObject({ note: "second", noteAt: 2 });
    expect(records.setNote("s1", "   ", SEEN, 3)).toBe(true);
    expect(records.get("s1")).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
    // Nothing to take away: nothing happens, and that is fine.
    expect(records.setNote("s1", undefined, SEEN, 4)).toBe(true);
    // A note on a session nothing is known about, with no record either: nothing to write it on.
    expect(records.setNote("s2", "lost", undefined, 5)).toBe(false);
  });

  it("follows a session's title and branch while it has a record, and leaves sessions without one alone", () => {
    const records = new SessionRecords(dir);
    records.observe("s9", SEEN);
    expect(records.get("s9")).toBeUndefined();
    records.setNote("s1", "keep", SEEN, 1);
    records.observe("s1", { ...SEEN, title: "Wire the cache, again", branch: "fix-cache", modifiedAt: 2000 });
    expect(new SessionRecords(dir).get("s1")).toEqual({ v: 1, id: "s1", agent: "claude-code", title: "Wire the cache, again", cwd: "/work/app", branch: "fix-cache", modifiedAt: 2000, note: "keep", noteAt: 1 });
    // The same again, or the same without a time, as a running session is seen: nothing written, the time on record kept.
    const before = fs.statSync(records.fileOf("s1")).mtimeMs;
    records.observe("s1", { ...SEEN, title: "Wire the cache, again", branch: "fix-cache", modifiedAt: 2000 });
    records.observe("s1", { agent: SEEN.agent, title: "Wire the cache, again", cwd: SEEN.cwd, branch: "fix-cache" });
    expect(fs.statSync(records.fileOf("s1")).mtimeMs).toBe(before);
    expect(records.get("s1")?.modifiedAt).toBe(2000);
    // A note changed with nothing else known keeps the session's place.
    records.setNote("s1", "keep for the recipe", undefined, 3);
    expect(records.get("s1")).toMatchObject({ title: "Wire the cache, again", cwd: "/work/app", note: "keep for the recipe", noteAt: 3 });
  });

  it("lists the noted sessions newest note first", () => {
    const records = new SessionRecords(dir);
    records.setNote("old", "a", SEEN, 1);
    records.setNote("new", "b", SEEN, 3);
    records.setNote("mid", "c", SEEN, 2);
    expect(records.noted().map((record) => record.id)).toEqual(["new", "mid", "old"]);
  });

  it("passes over files that are not records, and takes only what a record may hold", () => {
    fs.writeFileSync(path.join(dir, "junk.json"), "{not json");
    fs.writeFileSync(path.join(dir, "other.json"), JSON.stringify({ v: 2, id: "x", agent: "claude-code", note: "from a later build" }));
    fs.writeFileSync(path.join(dir, "noid.json"), JSON.stringify({ v: 1, agent: "claude-code", note: "no id" }));
    fs.writeFileSync(path.join(dir, "readme.txt"), "not a record");
    fs.writeFileSync(path.join(dir, "odd.json"), JSON.stringify({ v: 1, id: "odd", agent: "codex", title: 7, cwd: "/w", note: "  spaced \n out ", noteAt: "soon", extra: true }));
    const records = new SessionRecords(dir);
    expect([...records.all().keys()]).toEqual(["odd"]);
    expect(records.get("odd")).toEqual({ v: 1, id: "odd", agent: "codex", cwd: "/w", note: "spaced\n out" });
  });

  it("reads the directory again when another window writes to it", async () => {
    const records = new SessionRecords(dir);
    const listener = vi.fn();
    const watch = records.watch(listener);
    expect(records.noteOf("s1")).toBeUndefined();
    try {
      new SessionRecords(dir).setNote("s1", "from another window", SEEN, 1);
      await vi.waitFor(() => expect(listener).toHaveBeenCalled(), { timeout: 5000 });
      expect(records.noteOf("s1")).toBe("from another window");
    } finally {
      watch.dispose();
    }
  });

  it("does not bring back a record another window removed, when it follows the session", () => {
    const a = new SessionRecords(dir);
    const b = new SessionRecords(dir);
    a.setNote("s1", "keep", SEEN, 1);
    expect(b.noteOf("s1")).toBe("keep");
    a.setNote("s1", undefined, SEEN, 2);
    // b still holds it in memory: the session's new title must not write it back.
    b.observe("s1", { ...SEEN, title: "renamed" });
    expect(fs.existsSync(a.fileOf("s1"))).toBe(false);
    expect(b.get("s1")).toBeUndefined();
  });

  it("is false when a note cannot be written, and true when there was nothing to do", () => {
    const blocked = path.join(dir, "a-file");
    fs.writeFileSync(blocked, "not a directory");
    const records = new SessionRecords(path.join(blocked, "records"));
    expect(records.setNote("s1", "keep", SEEN, 1)).toBe(false);
    expect(records.noteOf("s1")).toBeUndefined();
    expect(records.setNote("s1", undefined, SEEN, 2)).toBe(true);
  });

  it("sees another window's writes without a watch, by the files' names, sizes and times, once a second at most", () => {
    let clock = 10_000;
    const a = new SessionRecords(dir, () => clock);
    const b = new SessionRecords(dir, () => clock);
    expect(a.all().size).toBe(0);
    b.setNote("s1", "from b", SEEN, 1);
    // Within the second: not looked at again.
    expect(a.noteOf("s1")).toBeUndefined();
    clock += 1500;
    expect(a.noteOf("s1")).toBe("from b");
    b.setNote("s1", undefined, SEEN, 2);
    clock += 1500;
    expect(a.noteOf("s1")).toBeUndefined();
    // A record rewritten under the same name, with the same size: its time tells.
    b.setNote("s2", "first", SEEN, 3);
    clock += 1500;
    expect(a.noteOf("s2")).toBe("first");
    b.setNote("s2", "later", SEEN, 4);
    clock += 1500;
    expect(a.noteOf("s2")).toBe("later");
  });

  it("lives without its directory until the first note, which creates it", () => {
    const records = new SessionRecords(path.join(dir, "missing", "records"));
    expect(records.all().size).toBe(0);
    expect(records.noteOf("s1")).toBeUndefined();
    expect(records.setNote("s1", "first", SEEN, 1)).toBe(true);
    expect(fs.existsSync(records.fileOf("s1"))).toBe(true);
  });
});
