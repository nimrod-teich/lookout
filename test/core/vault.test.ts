import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptVault } from "../../src/core/vault";

let dir: string;
let projects: string;
let vault: TranscriptVault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-vault-"));
  projects = path.join(dir, "projects", "-work-app");
  fs.mkdirSync(projects, { recursive: true });
  vault = new TranscriptVault(path.join(dir, "vault"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function transcript(id: string, text = "first line\n"): string {
  const file = path.join(projects, `${id}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}

const posix = process.platform !== "win32";

describe("TranscriptVault", () => {
  it("keeps a transcript as a link that follows the file, and lists what it keeps", () => {
    const file = transcript("s1");
    expect(vault.has("s1")).toBe(false);
    expect(vault.kept()).toEqual([]);
    const kept = vault.keep("s1", "claude-code", file, 1000)!;
    expect(kept).toEqual({ id: "s1", agent: "claude-code", file, keptAt: 1000, size: 11, linked: true });
    expect(vault.has("s1")).toBe(true);
    expect(fs.statSync(vault.fileOf("s1")).ino).toBe(fs.statSync(file).ino);
    // The agent appends: the copy has it, with no second write.
    fs.appendFileSync(file, "second line\n");
    expect(fs.readFileSync(vault.fileOf("s1"), "utf8")).toBe("first line\nsecond line\n");
    // Kept again: nothing but the size changes, and the time stays.
    expect(vault.keep("s1", "claude-code", file, 2000)).toEqual({ ...kept, size: 23 });
    expect(vault.kept().map((record) => record.id)).toEqual(["s1"]);
    expect(vault.size()).toEqual({ files: 1, bytes: 23 });
    // The agent deletes the file: the copy stays, and is listed.
    fs.unlinkSync(file);
    expect(vault.has("s1")).toBe(true);
    expect(fs.readFileSync(vault.fileOf("s1"), "utf8")).toBe("first line\nsecond line\n");
  });

  it("keeps the new file when the agent replaced the transcript, and nothing for a file that is gone", () => {
    const file = transcript("s1");
    vault.keep("s1", "claude-code", file, 1000);
    fs.renameSync(file, `${file}.superseded-1`);
    fs.writeFileSync(file, "a new conversation\n");
    const again = vault.keep("s1", "claude-code", file, 2000)!;
    expect(again).toMatchObject({ keptAt: 1000, size: 19 });
    expect(fs.readFileSync(vault.fileOf("s1"), "utf8")).toBe("a new conversation\n");
    expect(vault.refresh("s1")).toMatchObject({ size: 19 });
    expect(vault.keep("s9", "claude-code", path.join(projects, "missing.jsonl"))).toBeUndefined();
    fs.unlinkSync(file);
    // A refresh of a kept transcript whose file is gone leaves the copy as it is.
    expect(vault.refresh("s1")).toMatchObject({ id: "s1", size: 19 });
    expect(fs.readFileSync(vault.fileOf("s1"), "utf8")).toBe("a new conversation\n");
  });

  it("restores a kept transcript to the place it was kept from, as a link, and never over a file that is there", () => {
    const file = transcript("s1", "the words\n");
    vault.keep("s1", "claude-code", file, 1000);
    expect(vault.restore("s1")).toEqual({ ok: false, file, why: "is there already" });
    fs.unlinkSync(file);
    fs.rmSync(projects, { recursive: true, force: true });
    expect(vault.restore("s1")).toEqual({ ok: true, file });
    expect(fs.readFileSync(file, "utf8")).toBe("the words\n");
    if (posix) expect(fs.statSync(file).ino).toBe(fs.statSync(vault.fileOf("s1")).ino);
    // The agent appends to the restored file: the copy follows.
    fs.appendFileSync(file, "more\n");
    expect(fs.readFileSync(vault.fileOf("s1"), "utf8")).toBe("the words\nmore\n");
    expect(vault.restore("s2")).toEqual({ ok: false, file: "", why: "is not kept" });
  });

  it("stops keeping a transcript, and passes over records that are not records", () => {
    const file = transcript("s1");
    vault.keep("s1", "claude-code", file, 1000);
    vault.release("s1");
    expect(vault.has("s1")).toBe(false);
    expect(vault.kept()).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
    vault.release("s1");
    fs.writeFileSync(path.join(dir, "vault", "junk.json"), "{ not json");
    fs.writeFileSync(path.join(dir, "vault", "old.json"), JSON.stringify({ v: 2, id: "x", agent: "a", file: "/f", keptAt: 1 }));
    expect(vault.kept()).toEqual([]);
  });

  it("keeps a copy where a link cannot be made, and brings the copy up to the file", () => {
    // A link across file systems cannot be tried here; a copy's upkeep can: a record that says copied, with a copy older than the file.
    const file = transcript("s1", "one\n");
    const kept = vault.keep("s1", "claude-code", file, 1000)!;
    fs.rmSync(vault.fileOf("s1"));
    fs.copyFileSync(file, vault.fileOf("s1"));
    fs.writeFileSync(path.join(dir, "vault", `${path.basename(vault.fileOf("s1"), ".jsonl")}.json`), JSON.stringify({ v: 1, ...kept, linked: false }));
    fs.appendFileSync(file, "two\n");
    expect(vault.keep("s1", "claude-code", file, 2000)).toEqual({ ...kept, size: 8, linked: false });
    expect(fs.readFileSync(vault.fileOf("s1"), "utf8")).toBe("one\ntwo\n");
  });
});
