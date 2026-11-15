import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE } from "../../../src/core/agents/claude/provider";
import { loadSqlite } from "../../../src/core/sqlite";
import { backUp, snapshotStore, type BackUpDeps, type BackUpOptions } from "../../../src/core/transfer/backup";
import { select, takeInventory, type Inventory, type Selection } from "../../../src/core/transfer/inventory";
import { SECTIONS, type BundleFile, type BundleSink, type ManifestBody, type NewFile } from "../../../src/core/transfer/types";
import { tempConfigDir } from "../helpers";
import { buildMachine, NOW, S, type Machine } from "./machine";

// Key derivation, compression and SQLite at real sizes: slower runners need more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const sqlite = loadSqlite();
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

/** A backup file's writer that keeps what it is given. */
class FakeSink implements BundleSink {
  readonly files: { entry: BundleFile; bytes: Buffer }[] = [];
  manifest: ManifestBody | undefined;
  aborted = 0;
  private offset = 0;

  constructor(private readonly onAdd?: (entry: NewFile, source: Readable, sink: FakeSink) => Promise<void> | void) {}

  async addFile(entry: NewFile, source: string | Readable): Promise<BundleFile> {
    if (typeof source === "string") throw new Error("a stream is expected");
    await this.onAdd?.(entry, source, this);
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const file: BundleFile = { ...entry, size: bytes.length, sha256: sha256(bytes), offset: this.offset };
    this.offset += bytes.length;
    this.files.push({ entry: file, bytes });
    return file;
  }

  async finish(manifest: ManifestBody): Promise<{ bytes: number }> {
    this.manifest = manifest;
    return { bytes: this.offset + 1 };
  }

  async abort(): Promise<void> {
    this.aborted++;
  }
}

const OPTIONS: BackUpOptions = {
  codec: "zstd",
  level: 3,
  host: "test-host",
  createdAt: NOW,
  lookoutVersion: "9.9.9",
  source: { host: "test-host", platform: "linux", home: "/home/test", wsl: false },
};

const EVERYTHING: Selection = { sections: [...SECTIONS] };

let machine: Machine | undefined;

afterEach(() => {
  machine?.store?.close();
  machine = undefined;
});

async function setUp(): Promise<{ m: Machine; inventory: Inventory; tempDir: string }> {
  machine = buildMachine();
  return { m: machine, inventory: await takeInventory(machine.sources), tempDir: tempConfigDir() };
}

function deps(sink: BundleSink, tempDir: string, more: Partial<BackUpDeps> = {}): BackUpDeps & { opened: { file: string; options: unknown }[] } {
  const opened: { file: string; options: unknown }[] = [];
  return {
    opened,
    createSink: async (file, options) => {
      opened.push({ file, options });
      return sink;
    },
    tempDir,
    ...more,
  };
}

/** What a temporary directory holds besides the fixture's own folders. */
function leftIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name !== "sessions" && name !== "projects");
}

describe.skipIf(!sqlite)("backUp", () => {
  it("writes the chosen files in the inventory's order, each byte for byte with its entry, then the manifest", async () => {
    const { m, inventory, tempDir } = await setUp();
    const sink = new FakeSink();
    const d = deps(sink, tempDir);
    const result = await backUp("/out/backup.lookout", inventory, EVERYTHING, { ...OPTIONS, passphrase: "secret" }, undefined, undefined, d);
    expect(d.opened).toEqual([{ file: "/out/backup.lookout", options: { passphrase: "secret", codec: "zstd", level: 3, host: "test-host", createdAt: NOW } }]);
    expect(sink.files.map((file) => file.entry.rel)).toEqual(inventory.items.map((item) => item.rel));
    expect(result).toEqual({ bytes: sink.files.reduce((sum, file) => sum + file.bytes.length, 0) + 1, files: inventory.items.length, skipped: [] });
    for (const { entry, bytes } of sink.files) {
      const item = inventory.items.find((it) => it.rel === entry.rel)!;
      if (entry.kind !== "history") expect(bytes.equals(fs.readFileSync(item.abs))).toBe(true);
      expect(entry.mtime).toBeGreaterThan(0);
    }
    const app = sink.files.find((file) => file.entry.kind === "transcript" && file.entry.sessionId === S.app)!.entry;
    expect(app).toMatchObject({ kind: "transcript", dir: "default", sessionId: S.app, cwd: m.repo, mtime: fs.statSync(m.transcript(S.app)).mtimeMs });
    // A session whose folder is not named after its place goes without one, to keep its folder on restore.
    expect(sink.files.find((file) => file.entry.sessionId === S.moved)!.entry).not.toHaveProperty("cwd");
    expect(sink.files.find((file) => file.entry.kind === "usage")!.entry).toEqual({ kind: "usage", rel: "alerts/five-hour-90", mtime: expect.any(Number), size: 0, sha256: sha256(Buffer.alloc(0)), offset: expect.any(Number) });
    expect(sink.manifest).toEqual({
      format: 1,
      createdAt: NOW,
      lookoutVersion: "9.9.9",
      source: OPTIONS.source,
      sections: [...SECTIONS],
      state: { "lookout.favourites": [S.app], "lookout.sort": "recent" },
      notes: inventory.notes,
      tabs: m.sources.tabs,
      claudeDirs: [
        { label: "default", resolved: m.dirs[0]!.resolved, isDefault: true },
        { label: "work", resolved: m.dirs[1]!.resolved, isDefault: false },
      ],
      repos: [],
    });
    expect(sink.aborted).toBe(0);
    expect(leftIn(tempDir)).toEqual([]);
  });

  it("records the repositories the sessions worked in, by their remotes' paths and never their URLs", async () => {
    const { m, inventory, tempDir } = await setUp();
    fs.writeFileSync(path.join(m.repo, ".git", "config"), '[remote "origin"]\n\turl = https://bot:ghs_secret@github.com/Owner/App.git\n');
    const sink = new FakeSink();
    await backUp("/out/backup.lookout", inventory, EVERYTHING, OPTIONS, undefined, undefined, deps(sink, tempDir));
    const repos = sink.manifest!.repos!;
    // A linked worktree, with its main checkout's remotes: a restore maps the main checkout, which carries it.
    expect(repos).toEqual([
      { root: m.repo, linked: false, remotes: ["owner/app"] },
      { root: m.worktree, linked: true, remotes: ["owner/app"] },
    ]);
    expect(JSON.stringify(sink.manifest)).not.toContain("ghs_secret");
  });

  it("puts in the history database as it stands while another window writes to it, and removes the copy", async () => {
    const { m, inventory, tempDir } = await setUp();
    // Written after the inventory, and not yet checkpointed into the database's own file.
    m.store!.rememberSession({ id: "later", agent: CLAUDE_CODE, file: "/later.jsonl", title: "later", cwd: "/later" });
    const sink = new FakeSink();
    await backUp("/out/b.lookout", inventory, { sections: ["history"] }, OPTIONS, undefined, undefined, deps(sink, tempDir));
    expect(sink.files).toHaveLength(1);
    const { entry, bytes } = sink.files[0]!;
    expect(entry).toMatchObject({ kind: "history", rel: "history.sqlite" });
    const copy = path.join(tempConfigDir(), "copy.sqlite");
    fs.writeFileSync(copy, bytes);
    const db = new sqlite!.DatabaseSync(copy, { readOnly: true });
    try {
      const ids = (db.prepare("SELECT id FROM sessions ORDER BY id").all() as { id: string }[]).map((row) => row.id);
      expect(ids).toEqual([S.placeless, S.worktree, S.resumed, S.moved, "later"].sort());
    } finally {
      db.close();
    }
    expect(leftIn(tempDir)).toEqual([]);
    expect(sink.manifest?.sections).toEqual(["history"]);
    expect(sink.manifest?.notes).toEqual([]);
    expect(sink.manifest?.state).toEqual({});
    expect(sink.manifest?.tabs).toEqual([]);
  });

  it("leaves out the files gone since the inventory, and says which", async () => {
    const { m, inventory, tempDir } = await setUp();
    fs.rmSync(m.transcript(S.placeless));
    fs.rmSync(m.sources.removedWorktreesFile);
    fs.rmSync(path.join(path.dirname(m.transcript(S.app)), S.app, "tool-results"), { recursive: true });
    const sink = new FakeSink();
    const seen: [number, number][] = [];
    const result = await backUp("/out/b.lookout", inventory, EVERYTHING, OPTIONS, (done, total) => seen.push([done, total]), undefined, deps(sink, tempDir));
    expect(result.skipped.map(({ item, why }) => [item.rel.split("/").pop(), why])).toEqual([
      [`${S.placeless}.jsonl`, "is gone"],
      ["toolu_2.txt", "is gone"],
      ["toolu_1.txt", "is gone"],
      ["removed.json", "is gone"],
    ]);
    expect(result.files).toBe(inventory.items.length - 4);
    expect(sink.files.map((file) => file.entry.rel)).toEqual(inventory.items.filter((item) => !result.skipped.some((s) => s.item === item)).map((item) => item.rel));
    // Progress never runs backwards and ends with every byte read.
    for (let i = 1; i < seen.length; i++) expect(seen[i]![0]).toBeGreaterThanOrEqual(seen[i - 1]![0]);
    const [done, total] = seen.at(-1)!;
    expect(done).toBe(total);
    expect(done).toBe(sink.files.reduce((sum, file) => sum + file.bytes.length, 0));
  });

  it("follows the selection: sections, age and repositories", async () => {
    const { inventory, tempDir } = await setUp();
    const selection: Selection = { sections: ["transcripts", "subagents", "notes"], activeWithinDays: 30, repos: ["app"] };
    const sink = new FakeSink();
    await backUp("/out/b.lookout", inventory, selection, OPTIONS, undefined, undefined, deps(sink, tempDir));
    expect(sink.files.map((file) => file.entry.rel)).toEqual(select(inventory, selection).map((item) => item.rel));
    expect(sink.files.map((file) => [file.entry.sessionId, file.entry.kind])).toEqual([
      [S.app, "transcript"],
      [S.app, "subagent"],
      [S.worktree, "transcript"],
    ]);
    expect(sink.manifest?.sections).toEqual(["notes", "transcripts", "subagents"]);
    expect(sink.manifest?.notes).toEqual(inventory.notes);
  });

  it("goes on without the history when it cannot be copied, and says why", async () => {
    const { inventory, tempDir } = await setUp();
    const sink = new FakeSink();
    const result = await backUp("/out/b.lookout", inventory, { sections: ["history", "worktreesLog"] }, OPTIONS, undefined, undefined, deps(sink, tempDir, { snapshot: () => Promise.reject(new Error("database is locked")) }));
    expect(result.skipped.map(({ item, why }) => [item.kind, why])).toEqual([["history", "could not be copied: database is locked"]]);
    expect(sink.files.map((file) => file.entry.kind)).toEqual(["removed-worktrees"]);
    expect(leftIn(tempDir)).toEqual([]);
  });

  it("drops the file when the writer fails, and passes the failure on", async () => {
    const { inventory, tempDir } = await setUp();
    const sink = new FakeSink((_entry, _source, self) => {
      if (self.files.length === 2) throw new Error("disk full");
    });
    await expect(backUp("/out/b.lookout", inventory, EVERYTHING, OPTIONS, undefined, undefined, deps(sink, tempDir))).rejects.toThrow("disk full");
    expect(sink.aborted).toBe(1);
    expect(sink.manifest).toBeUndefined();
    expect(leftIn(tempDir)).toEqual([]);
  });

  it("stops at once on a cancel, even with the writer stuck in a file, and drops the file", async () => {
    const { inventory, tempDir } = await setUp();
    const controller = new AbortController();
    // The third file never finishes: the cancel comes while it is being written.
    const sink = new FakeSink((_entry, _source, self) => {
      if (self.files.length < 2) return;
      setTimeout(() => controller.abort(), 10);
      return new Promise<void>(() => {});
    });
    const started = Date.now();
    const backup = backUp("/out/b.lookout", inventory, EVERYTHING, OPTIONS, undefined, controller.signal, deps(sink, tempDir));
    await expect(backup).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(sink.files).toHaveLength(2);
    expect(sink.aborted).toBe(1);
    expect(sink.manifest).toBeUndefined();
    expect(leftIn(tempDir)).toEqual([]);
  });

  it("stops a cancel during the history's copy, and leaves no copy behind", async () => {
    const { inventory, tempDir } = await setUp();
    const controller = new AbortController();
    const snapshot: BackUpDeps["snapshot"] = (_from, to, signal) =>
      new Promise((_resolve, reject) => {
        fs.writeFileSync(to, "half a copy");
        signal!.addEventListener("abort", () => reject(signal!.reason));
        controller.abort();
      });
    const sink = new FakeSink();
    await expect(backUp("/out/b.lookout", inventory, EVERYTHING, OPTIONS, undefined, controller.signal, deps(sink, tempDir, { snapshot }))).rejects.toMatchObject({ name: "AbortError" });
    expect(sink.files).toEqual([]);
    expect(sink.aborted).toBe(1);
    expect(leftIn(tempDir)).toEqual([]);
  });

  it("makes the history's copy in the folder its options name, removing first the copies more than a day old that stopped backups left there", async () => {
    const { inventory, tempDir } = await setUp();
    const root = path.join(tempDir, "storage-tmp");
    fs.mkdirSync(root);
    const folder = (name: string, daysOld: number, file?: string) => {
      const at = path.join(root, name);
      fs.mkdirSync(at);
      if (file) fs.writeFileSync(path.join(at, file), "a copy of the history");
      const time = (Date.now() - daysOld * 24 * 60 * 60_000) / 1000;
      fs.utimesSync(at, time, time);
      return at;
    };
    folder("lookout-backup-left", 2, "history.sqlite");
    folder("lookout-backup-running", 0.5, "history.sqlite");
    folder("lookout-restore-left", 2);
    folder("unrelated", 3);
    fs.writeFileSync(path.join(root, "lookout-backup-file"), "not a folder");
    fs.utimesSync(path.join(root, "lookout-backup-file"), 0, 0);
    // A link of that name to a folder elsewhere: neither it nor what it points to goes.
    const elsewhere = path.join(tempDir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "keep.txt"), "keep");
    if (process.platform !== "win32") {
      fs.symlinkSync(elsewhere, path.join(root, "lookout-backup-link"));
      fs.lutimesSync(path.join(root, "lookout-backup-link"), 0, 0);
    }
    const copies: string[] = [];
    const snapshot: BackUpDeps["snapshot"] = async (from, to, signal) => {
      copies.push(to);
      expect(fs.readdirSync(root)).not.toContain("lookout-backup-left");
      await snapshotStore(from, to, signal);
    };
    const sink = new FakeSink();
    await backUp("/out/b.lookout", inventory, { sections: ["history"] }, { ...OPTIONS, tempDir: root }, undefined, undefined, deps(sink, tempDir, { snapshot }));
    expect(sink.files.map((file) => file.entry.kind)).toEqual(["history"]);
    // The options' folder over the one the deps name, and a folder of its own in it, gone once the backup ends.
    expect(path.dirname(path.dirname(copies[0]!))).toBe(root);
    expect(path.basename(path.dirname(copies[0]!))).toMatch(/^lookout-backup-/);
    expect(leftIn(tempDir)).toEqual(["elsewhere", "storage-tmp"]);
    expect(fs.readdirSync(root).sort()).toEqual(["lookout-backup-file", ...(process.platform !== "win32" ? ["lookout-backup-link"] : []), "lookout-backup-running", "lookout-restore-left", "unrelated"]);
    expect(fs.readFileSync(path.join(elsewhere, "keep.txt"), "utf8")).toBe("keep");
  });

  it("starts nothing when cancelled before it begins", async () => {
    const { inventory, tempDir } = await setUp();
    const controller = new AbortController();
    controller.abort();
    const d = deps(new FakeSink(), tempDir);
    await expect(backUp("/out/b.lookout", inventory, EVERYTHING, OPTIONS, undefined, controller.signal, d)).rejects.toMatchObject({ name: "AbortError" });
    expect(d.opened).toEqual([]);
  });
});

describe.skipIf(!sqlite)("snapshotStore", () => {
  it("copies a database in use as it stands, into a file of its own, without writing to the original", async () => {
    const dir = tempConfigDir();
    const from = path.join(dir, "live.sqlite");
    const writer = new sqlite!.DatabaseSync(from);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t(a TEXT)");
      for (let i = 0; i < 50; i++) writer.prepare("INSERT INTO t VALUES (?)").run(`row ${i}`);
      const before = fs.statSync(from);
      const to = path.join(dir, "copy.sqlite");
      await snapshotStore(from, to);
      expect(fs.statSync(from).mtimeMs).toBe(before.mtimeMs);
      expect(fs.statSync(from).size).toBe(before.size);
      // A rollback-journal file: no WAL to go with it.
      expect([...fs.readFileSync(to).subarray(18, 20)]).toEqual([1, 1]);
      const copy = new sqlite!.DatabaseSync(to, { readOnly: true });
      try {
        expect(copy.prepare("SELECT COUNT(*) AS n FROM t").get()).toMatchObject({ n: 50 });
      } finally {
        copy.close();
      }
    } finally {
      writer.close();
    }
  });

  it("rejects for a file that is not a database, and on a cancel", async () => {
    const dir = tempConfigDir();
    const junk = path.join(dir, "junk.sqlite");
    fs.writeFileSync(junk, "not a database at all, not even close".repeat(100));
    await expect(snapshotStore(junk, path.join(dir, "out.sqlite"))).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(snapshotStore(junk, path.join(dir, "out2.sqlite"), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
