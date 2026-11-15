// Writes a backup: the chosen files, in the inventory's order, through a
// backup file's writer, then the manifest with the light state, notes and
// tabs. The history database goes in as a snapshot taken for the purpose, so
// windows writing to it meanwhile change nothing in the backup. A file gone
// since the inventory is left out and reported; anything else that fails, or
// a cancel, drops the file being written.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import { createBundle } from "./bundle";
import { select, type Inventory, type InventoryItem, type Selection } from "./inventory";
import { SECTIONS, type BundleSink, type ManifestBody, type NewFile, type SourceMachine, type WriteOptions } from "./types";

/** Starts writing a backup file. */
export type SinkFactory = (file: string, options: WriteOptions) => Promise<BundleSink>;

export interface BackUpOptions extends WriteOptions {
  lookoutVersion: string;
  source: SourceMachine;
  /** The folder the history's snapshot is made in, in a `lookout-backup-*` folder of its own; `deps.tempDir`, else the system's temporary directory, when absent. */
  tempDir?: string;
}

/** A file the backup left out. */
export interface SkippedFile {
  item: InventoryItem;
  /** Why, in a few words: "is gone", "could not be read", "could not be copied: …". */
  why: string;
}

export interface BackUpResult {
  /** The backup file's size. */
  bytes: number;
  /** Files written into it. */
  files: number;
  skipped: SkippedFile[];
}

/** What a backup is written with, besides the file writer's defaults. */
export interface BackUpDeps {
  /** Starts the backup file's writer; `createBundle` by default. */
  createSink?: SinkFactory;
  /** Copies the history database into `to` as it stands, consistently; `snapshotStore` by default. */
  snapshot?: (from: string, to: string, signal?: AbortSignal) => Promise<void>;
  /** Where the snapshot is made when the options name no folder; the system's temporary directory by default. */
  tempDir?: string;
}

/** The bytes read from a file at once. */
const CHUNK = 1024 * 1024;
/** The name each backup's folder for the history's snapshot starts with. */
const TEMP_PREFIX = "lookout-backup-";
/** A snapshot folder older than this was left by a backup that never ended, as when the extension host stopped during it. */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

/**
 * Writes the selection of the inventory into `file`. `progress` hears the
 * bytes read so far and the bytes to read in all; the total follows the
 * files as they are when opened. A cancel through `signal` stops at once:
 * the file being written is dropped, and the promise rejects with the
 * signal's reason. First it removes the snapshot folders more than a day
 * old that backups left in the temporary folder.
 */
export async function backUp(
  file: string,
  inventory: Inventory,
  selection: Selection,
  options: BackUpOptions,
  progress?: (doneBytes: number, totalBytes: number) => void,
  signal?: AbortSignal,
  deps: BackUpDeps = {},
): Promise<BackUpResult> {
  signal?.throwIfAborted();
  const tempRoot = options.tempDir ?? deps.tempDir ?? os.tmpdir();
  await removeStaleTemp(tempRoot, Date.now());
  const items = select(inventory, selection);
  let total = items.reduce((sum, item) => sum + item.size, 0);
  let done = 0;
  progress?.(done, total);
  const { passphrase, codec, level, host, createdAt } = options;
  const sink = await (deps.createSink ?? createBundle)(file, { ...(passphrase !== undefined ? { passphrase } : {}), codec, level, host, createdAt });
  const skipped: SkippedFile[] = [];
  let files = 0;
  let tempDir: string | undefined;
  const skip = (item: InventoryItem, why: string) => {
    skipped.push({ item, why });
    total -= item.size;
    progress?.(done, total);
  };
  try {
    for (const item of items) {
      signal?.throwIfAborted();
      let from = item.abs;
      if (item.kind === "history") {
        try {
          tempDir ??= await fs.promises.mkdtemp(path.join(tempRoot, TEMP_PREFIX));
        } catch (error) {
          skip(item, `could not be copied: ${messageOf(error)}`);
          continue;
        }
        from = path.join(tempDir, item.rel);
        const why = await takeSnapshot(item.abs, from, deps.snapshot ?? snapshotStore, signal);
        if (why !== undefined) {
          skip(item, why);
          continue;
        }
      }
      try {
        const opened = await openFile(from);
        if ("why" in opened) {
          skip(item, opened.why);
          continue;
        }
        const { handle, size, mtime } = opened;
        total += size - item.size;
        const entry: NewFile = { kind: item.kind, rel: item.rel, mtime, ...(item.dir !== undefined ? { dir: item.dir } : {}), ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}), ...(item.cwd !== undefined ? { cwd: item.cwd } : {}) };
        const source = Readable.from(
          readChunks(handle, size, signal, (bytes) => {
            done += bytes;
            progress?.(done, total);
          }),
          { objectMode: false },
        );
        const adding = sink.addFile(entry, source);
        try {
          await untilAborted(adding, signal);
        } finally {
          source.destroy();
          await settled(adding, SETTLE_MS);
          await handle.close();
        }
        files++;
      } finally {
        // The snapshot's room is given back as soon as it is in.
        if (from !== item.abs) await removeQuietly(from);
      }
    }
    signal?.throwIfAborted();
    const sections = SECTIONS.filter((section) => selection.sections.includes(section));
    const manifest: ManifestBody = {
      format: 1,
      createdAt,
      lookoutVersion: options.lookoutVersion,
      source: options.source,
      sections,
      state: sections.includes("state") ? inventory.state : {},
      notes: sections.includes("notes") ? inventory.notes : [],
      tabs: sections.includes("tabs") ? inventory.tabs : [],
      claudeDirs: inventory.claudeDirs.map((dir) => ({ label: dir.label, resolved: dir.resolved, isDefault: dir.isDefault })),
    };
    // Not cancelled from here on: the manifest is small, and a file half moved into place is worse than a finished one.
    const { bytes } = await sink.finish(manifest);
    return { bytes, files, skipped };
  } catch (error) {
    try {
      await sink.abort();
    } catch {
      // Dropped as far as it could be; the error that stopped the backup says more.
    }
    throw error;
  } finally {
    if (tempDir !== undefined) await removeQuietly(tempDir);
  }
}

/** How long a writer whose source was cut off is given to stop before it is told to drop the file. */
const SETTLE_MS = 250;

/** Waits for the work to settle, however it ends, but no longer than `ms`. */
async function settled(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work.then(nothing, nothing), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

function nothing(): void {}

/** Removes a file or folder; one that cannot be removed now stays, and is no reason to fail. */
async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Left in the temporary folder, for a later backup to remove once it is a day old.
  }
}

/** Removes the snapshot folders in `dir` last changed more than a day before `now`. Links and files of the same name stay, and so does what cannot be removed. */
async function removeStaleTemp(dir: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const folder = path.join(dir, name);
    try {
      const st = await fs.promises.lstat(folder);
      if (st.isDirectory() && now - st.mtimeMs > STALE_TEMP_MS) await removeQuietly(folder);
    } catch {
      // Gone meanwhile.
    }
  }
}

/** Snapshots the history database; why not, when it could not be. A cancel rejects. */
async function takeSnapshot(from: string, to: string, snapshot: NonNullable<BackUpDeps["snapshot"]>, signal: AbortSignal | undefined): Promise<string | undefined> {
  try {
    await fs.promises.access(from);
  } catch {
    return "is gone";
  }
  try {
    await snapshot(from, to, signal);
    return undefined;
  } catch (error) {
    signal?.throwIfAborted();
    return `could not be copied: ${messageOf(error)}`;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A file opened for reading, with its size and time as it is now; or why it cannot be read: gone since the inventory, or barred. */
async function openFile(file: string): Promise<{ handle: fs.promises.FileHandle; size: number; mtime: number } | { why: string }> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { why: "is gone" };
    if (code === "EACCES" || code === "EPERM" || code === "EISDIR") return { why: "could not be read" };
    throw error;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      await handle.close();
      return { why: "is not a file" };
    }
    return { handle, size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The file's first `size` bytes, a chunk at a time: what was there when it was opened, though it grows meanwhile. */
async function* readChunks(handle: fs.promises.FileHandle, size: number, signal: AbortSignal | undefined, read: (bytes: number) => void): AsyncGenerator<Buffer> {
  for (let position = 0; position < size; ) {
    signal?.throwIfAborted();
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    // Cut short since it was opened: what is there is what goes in.
    if (bytesRead === 0) return;
    position += bytesRead;
    read(bytesRead);
    yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  }
}

/** The work's outcome, or the signal's reason as soon as it is cancelled, whether or not the work has stopped yet. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Run in a thread of its own: the copy can take seconds on a large database, and the extension host goes on meanwhile. */
const SNAPSHOT_THREAD = `
const { workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.from, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("VACUUM INTO ?").run(workerData.to);
} finally {
  db.close();
}
`;

/**
 * Copies a SQLite database into `to` with `VACUUM INTO`: one read
 * transaction, so the copy is the database as it stood at one moment while
 * other windows go on writing to it, and a file of its own with no journal.
 * Reads the database without writing to it. A cancel stops the copy; what it
 * left behind is the caller's to remove.
 */
export function snapshotStore(from: string, to: string, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const worker = new Worker(SNAPSHOT_THREAD, { eval: true, workerData: { from, to } });
    let failure: unknown;
    const cancel = () => void worker.terminate();
    signal?.addEventListener("abort", cancel, { once: true });
    worker.on("error", (error) => (failure = error));
    worker.on("exit", (code) => {
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) reject(signal.reason);
      else if (failure !== undefined) reject(failure);
      else if (code !== 0) reject(new Error(`The snapshot thread stopped (exit code ${code})`));
      else resolve();
    });
  });
}
