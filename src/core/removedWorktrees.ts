import * as fs from "node:fs";
import * as path from "node:path";
import type { RemovedRecord } from "./worktrees";

const DAY_MS = 24 * 60 * 60_000;
/** A removed worktree can be put back for this long: git may drop a deleted branch's commits after two weeks, the most it keeps them by default. */
export const RESTORE_DAYS = 14;
const MAX = 1000;

/**
 * The worktrees removed from the worktrees page, newest first, kept for the
 * machine so each can be put back: one JSON file, written whole and moved
 * into place, read again on each look since other windows write it too.
 */
export class RemovedWorktrees {
  private saves = 0;

  constructor(private readonly file: string) {}

  /** The removals still in reach, newest first. */
  list(now = Date.now()): RemovedRecord[] {
    return this.read().filter((record) => now - record.removedAt < RESTORE_DAYS * DAY_MS);
  }

  add(records: readonly RemovedRecord[], now = Date.now()): boolean {
    if (!records.length) return true;
    const added = new Set(records.map((record) => record.path));
    return this.write([...records, ...this.list(now).filter((record) => !added.has(record.path))].slice(0, MAX));
  }

  /** Lets go of a removal: it was put back. */
  drop(folder: string, now = Date.now()): boolean {
    return this.write(this.list(now).filter((record) => record.path !== folder));
  }

  private read(): RemovedRecord[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (record): record is RemovedRecord =>
        typeof record === "object" && record !== null && typeof record.repo === "string" && typeof record.path === "string" && typeof record.removedAt === "number",
    );
  }

  private write(records: readonly RemovedRecord[]): boolean {
    const temp = `${this.file}.${process.pid}.${++this.saves}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(records));
      // Moved into place whole: a window reading it meanwhile sees the old list or the new one.
      fs.renameSync(temp, this.file);
      return true;
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Nothing to take back.
      }
      return false;
    }
  }
}
