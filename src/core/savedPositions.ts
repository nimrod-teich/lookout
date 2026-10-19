// Where each conversation's messages and paths sit in its file, kept for the
// next window: positions only, never what the conversation says. A window
// that finds a conversation's entry reads those lines and what came after
// them, instead of the whole file.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HistoryIndex, SavedEntry, Scan } from "./history";

/** A conversation that changed is saved this long after, with whatever else changed meanwhile. */
const SAVE_AFTER_MS = 5_000;
/** A save left half done by a window that went away, older than this, is cleared. */
const STALE_TEMP_MS = 3_600_000;

/** The positions of a conversation, as saved in `entryFile`; none when the entry is missing, unreadable, or not for this file, reader and build. */
export function readSaved(entryFile: string, job: Pick<Scan, "file" | "reader">, build: string): SavedEntry | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(fs.readFileSync(entryFile, "utf8"));
  } catch {
    return undefined;
  }
  const e = entry as Partial<SavedEntry> | null;
  if (!e || e.v !== 1 || e.build !== build || e.file !== job.file || e.reader !== job.reader || typeof e.identity !== "string" || typeof e.tail !== "string" || !Number.isSafeInteger(e.end) || e.end! < 0) return undefined;
  const end = e.end!;
  const places = (list: unknown): list is number[] =>
    Array.isArray(list) && list.length % 2 === 0 && list.every((n, i) => Number.isSafeInteger(n) && (n as number) >= (i % 2 ? 1 : 0)) && list.every((n, i) => i % 2 === 1 || (n as number) + (list[i + 1] as number) <= end);
  if (!places(e.messages) || !places(e.paths) || !places(e.pathLines)) return undefined;
  return e as SavedEntry;
}

/**
 * The saved positions of the conversations, one file each under `dir`
 * (shared by every window), named after the conversation file's path.
 */
export class SavedPositions {
  private readonly dirty = new Set<HistoryIndex>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Saves made by this window, for temporary names no other save of it shares. */
  private saves = 0;

  constructor(
    private readonly dir: string,
    /** The build of the reading code: entries saved by another are read whole, then cleared. */
    readonly build: string,
  ) {}

  /** Where a conversation file's entry is kept. */
  entryFile(file: string): string {
    return path.join(this.dir, `${crypto.createHash("sha1").update(file).digest("hex")}.json`);
  }

  /** The index took in more of its file: its entry is saved shortly. */
  later(index: HistoryIndex): void {
    this.dirty.add(index);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, SAVE_AFTER_MS);
  }

  /** Saves what changed, without holding up the caller. */
  async flush(): Promise<void> {
    const indexes = [...this.dirty];
    this.dirty.clear();
    for (const index of indexes) {
      const entry = this.entryOf(index);
      if (!entry) continue;
      const target = this.entryFile(entry.file);
      const temp = this.tempFor(target);
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.writeFile(temp, JSON.stringify(entry));
        // Moved into place whole: a window reading it meanwhile sees the old entry or the new one.
        await fs.promises.rename(temp, target);
      } catch {
        await fs.promises.rm(temp, { force: true }).catch(() => undefined);
      }
    }
  }

  /** Saves what changed before the window goes away. */
  flushNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const indexes = [...this.dirty];
    this.dirty.clear();
    for (const index of indexes) {
      const entry = this.entryOf(index);
      if (!entry) continue;
      const target = this.entryFile(entry.file);
      const temp = this.tempFor(target);
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(temp, JSON.stringify(entry));
        fs.renameSync(temp, target);
      } catch {
        fs.rmSync(temp, { force: true });
      }
    }
  }

  private entryOf(index: HistoryIndex): SavedEntry | undefined {
    const places = index.places();
    return places && { ...places, build: this.build };
  }

  /** A name no other save shares, this window's or another's: two saves of one entry never write into one file. */
  private tempFor(target: string): string {
    return `${target}.${process.pid}.${++this.saves}.tmp`;
  }

  /** Deletes the entries of conversation files that are gone, those of another build, and saves left half done long ago. */
  async prune(now: number = Date.now()): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(this.dir, name);
      try {
        if (name.endsWith(".tmp")) {
          if (now - (await fs.promises.stat(full)).mtimeMs > STALE_TEMP_MS) await fs.promises.rm(full, { force: true });
          continue;
        }
        if (!name.endsWith(".json")) continue;
        const entry = JSON.parse(await fs.promises.readFile(full, "utf8")) as { file?: unknown; build?: unknown };
        const file = typeof entry?.file === "string" ? entry.file : undefined;
        if (!file || entry.build !== this.build || !(await exists(file))) await fs.promises.rm(full, { force: true });
      } catch {
        // An entry that does not parse is of no use either.
        await fs.promises.rm(full, { force: true }).catch(() => undefined);
      }
    }
  }

  dispose(): void {
    this.flushNow();
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}
