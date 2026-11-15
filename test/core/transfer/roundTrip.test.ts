import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSqlite } from "../../../src/core/sqlite";
import { backUp, type BackUpOptions } from "../../../src/core/transfer/backup";
import { createBundle, openBundle, zstdAvailable } from "../../../src/core/transfer/bundle";
import { takeInventory, type Inventory } from "../../../src/core/transfer/inventory";
import { applyRestore, planRestore, readBackupHistory, type RestoreTargets, type StateStore } from "../../../src/core/transfer/restore";
import { encodeProjectDir } from "../../../src/core/agents/claude/paths";
import { SessionRecords } from "../../../src/core/sessionRecords";
import { BundleError, PENDING_TABS_KEY, SECTIONS, type BundleFile } from "../../../src/core/transfer/types";
import { tempConfigDir } from "../helpers";
import { buildMachine, NOW, S, type Machine } from "./machine";

// Key derivation, compression and SQLite at real sizes: slower runners need more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const sqlite = loadSqlite();
const PASSPHRASE = "a long passphrase for the test";
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

let machine: Machine | undefined;

afterEach(() => {
  machine?.store?.close();
  machine = undefined;
});

function options(passphrase?: string, home = "/home/old"): BackUpOptions {
  return {
    codec: zstdAvailable() ? "zstd" : "gzip",
    level: zstdAvailable() ? 3 : 6,
    host: "old-machine",
    createdAt: NOW,
    lookoutVersion: "0.0.0-test",
    // The machine the test runs on is the source: its paths are this platform's.
    source: { host: "old-machine", platform: process.platform, home, wsl: false },
    ...(passphrase !== undefined ? { passphrase } : {}),
  };
}

/** Writes a real backup of a synthetic machine, with every section in. */
async function backedUp(passphrase?: string): Promise<{ file: string; m: Machine; inventory: Inventory; files: number }> {
  machine = buildMachine();
  const inventory = await takeInventory(machine.sources);
  const dir = tempConfigDir();
  const file = path.join(dir, "machine.lookout");
  const result = await backUp(file, inventory, { sections: [...SECTIONS] }, options(passphrase, machine.root), undefined, undefined, {
    // The real writer, with a cheap key derivation and small segments, so segment boundaries fall inside files.
    createSink: (to, given) => createBundle(to, given, { scryptN: 1 << 10, segmentBytes: 4096 }),
    tempDir: dir,
  });
  return { file, m: machine, inventory, files: result.files };
}

describe.skipIf(!sqlite)("a backup written and read back", () => {
  it("gives back every file byte for byte, with the light state, notes and tabs in its manifest", async () => {
    const { file, m, inventory, files } = await backedUp(PASSPHRASE);
    const source = await openBundle(file, PASSPHRASE);
    try {
      expect(source.header.cipher).toBe("aes-256-gcm-stream");
      expect(source.manifest.files).toHaveLength(files);
      expect(source.manifest.sections).toEqual([...SECTIONS]);
      expect(source.manifest.source.home).toBe(m.root);
      expect(source.manifest.notes).toEqual(inventory.notes);
      expect(source.manifest.state).toEqual(inventory.state);
      expect(source.manifest.tabs).toEqual(inventory.tabs);
      // Paths where sessions worked travel, for the restore to map; where each file sat on this machine does not.
      for (const entry of source.manifest.files) {
        expect(entry).not.toHaveProperty("abs");
        expect(path.isAbsolute(entry.rel)).toBe(false);
      }

      const seen: BundleFile[] = [];
      await source.forEachFile(async (entry, data) => {
        const chunks: Buffer[] = [];
        for await (const chunk of data) chunks.push(chunk as Buffer);
        const bytes = Buffer.concat(chunks);
        expect(sha256(bytes)).toBe(entry.sha256);
        if (entry.kind === "transcript" && entry.dir) {
          const dir = m.dirs.find((one) => one.label === entry.dir);
          expect(dir).toBeDefined();
          expect(bytes.equals(fs.readFileSync(path.join(dir!.resolved, "projects", ...entry.rel.split("/"))))).toBe(true);
        }
        seen.push(entry);
      });
      expect(seen.map((entry) => entry.rel)).toEqual(source.manifest.files.map((entry) => entry.rel));
      expect(seen.some((entry) => entry.kind === "history")).toBe(true);
      expect(seen.some((entry) => entry.rel.includes("/memory/") || entry.rel.startsWith("memory/"))).toBe(false);
    } finally {
      await source.close();
    }
  });

  it("refuses a wrong passphrase as a wrong passphrase", async () => {
    const { file } = await backedUp(PASSPHRASE);
    await expect(openBundle(file, "not the passphrase")).rejects.toMatchObject({ code: "wrong-passphrase" });
    await expect(openBundle(file, "not the passphrase")).rejects.toBeInstanceOf(BundleError);
  });

  it("reads back a backup made without a passphrase", async () => {
    const { file, files } = await backedUp();
    const source = await openBundle(file);
    try {
      expect(source.header.cipher).toBe("none");
      let read = 0;
      await source.forEachFile(async (_entry, data) => {
        for await (const _chunk of data) void _chunk;
        read++;
      });
      expect(read).toBe(files);
    } finally {
      await source.close();
    }
  });
});

class MapState implements StateStore {
  readonly values = new Map<string, unknown>();
  get(key: string): unknown {
    return this.values.get(key);
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

/** An empty machine whose home is somewhere else, with Claude config directories under the same labels. */
function newMachine(): { home: string; targets: RestoreTargets; state: MapState } {
  const home = fs.realpathSync.native(tempConfigDir());
  const storage = path.join(home, "storage");
  const state = new MapState();
  const targets: RestoreTargets = {
    home,
    claudeDirs: [
      { label: "default", resolved: path.join(home, "home", ".claude"), isDefault: true },
      { label: "work", resolved: path.join(home, "claude-work"), isDefault: false },
    ],
    recordsDir: path.join(storage, "sessions"),
    storeFile: path.join(storage, "history.sqlite"),
    vaultDir: path.join(storage, "vault"),
    usageDir: path.join(storage, "usage"),
    removedWorktreesFile: path.join(storage, "worktrees", "removed.json"),
    backupsDir: path.join(storage, "restore-backups"),
    state,
    tempDir: home,
    now: () => NOW,
  };
  return { home, targets, state };
}

/** Restores a backup file the way the command does: the history read out first, then the whole file. */
async function restore(file: string, passphrase: string, targets: RestoreTargets, from: string) {
  const first = await openBundle(file, passphrase);
  let plan;
  try {
    const history = await readBackupHistory(first, targets.tempDir);
    plan = await planRestore(first.manifest, targets, [{ from, to: targets.home }], history);
  } finally {
    await first.close();
  }
  const source = await openBundle(file, passphrase);
  try {
    return { plan, result: await applyRestore(source, plan, targets) };
  } finally {
    await source.close();
  }
}

describe.skipIf(!sqlite)("a backup restored on another machine", () => {
  it("puts every transcript under its folder for the new home, with the notes, state and tabs, and changes nothing the second time", async () => {
    const { file, m } = await backedUp(PASSPHRASE);
    const { home, targets, state } = newMachine();
    const { result } = await restore(file, PASSPHRASE, targets, m.root);
    expect(result.cancelled).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.refused).toEqual([]);

    // The session that worked in <old home>/repos/app now has its transcript under the folder Claude Code names after <new home>/repos/app.
    const appFolder = path.join(home, "home", ".claude", "projects", encodeProjectDir(path.join(home, "repos", "app")));
    expect(fs.readFileSync(path.join(appFolder, `${S.app}.jsonl`)).equals(fs.readFileSync(m.transcript(S.app)))).toBe(true);
    expect(fs.existsSync(path.join(appFolder, S.app, "subagents", "agent-a1.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(appFolder, S.app, "tool-results", "deep", "toolu_2.txt"))).toBe(true);
    expect(fs.statSync(path.join(appFolder, `${S.app}.jsonl`)).mtimeMs).toBe(fs.statSync(m.transcript(S.app)).mtimeMs);
    // Claude's memory never travels.
    expect(fs.existsSync(path.join(appFolder, "memory"))).toBe(false);
    // The other config directory's session goes to the directory with its label.
    expect(fs.existsSync(path.join(home, "claude-work", "projects", "-gone-place", `${S.lost}.jsonl`))).toBe(true);

    const notes = new SessionRecords(targets.recordsDir).get(S.app);
    expect(notes?.notes?.map((note) => note.text)).toEqual(["Remember the flaky test"]);
    expect(notes?.cwd).toBe(path.join(home, "repos", "app"));
    expect(state.values.get("lookout.favourites")).toEqual([S.app]);
    expect(state.values.get(PENDING_TABS_KEY)).toEqual([expect.objectContaining({ sessionId: S.app, cwd: path.join(home, "repos", "app"), from: "old-machine" })]);

    const tree = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => `${path.join(entry.parentPath, entry.name)} ${fs.statSync(path.join(entry.parentPath, entry.name)).size}`).sort();
    const before = tree(path.join(home, "home"));
    const again = await restore(file, PASSPHRASE, targets, m.root);
    expect(again.result.transcripts.written.count + again.result.transcripts.replaced.count).toBe(0);
    expect(tree(path.join(home, "home"))).toEqual(before);
  });
});
