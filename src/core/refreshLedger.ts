import * as fs from "node:fs";
import * as path from "node:path";

/** No refresh starts within this long of the last one on the host. */
export const MIN_REFRESH_GAP_MS = 180_000;
/** A refresh that keeps failing is tried at most this rarely. */
export const MAX_BACKOFF_MS = 30 * 60_000;
/** The file every attempt touches, for the gap. */
const LAST = "last";

export interface Attempts {
  /** Attempts made at these numbers; each one that left them in place failed. */
  count: number;
  /** Epoch ms the last of them started. */
  lastAt?: number;
}

/**
 * The usage refreshes of every window on the host, as files in a folder they
 * all see. The numbers being refreshed are named by a key (where they come
 * from, and when they were fetched); each attempt at them is a file,
 * `fetch-<key>-<n>`, created exclusively, so exactly one window makes it. A
 * successful refresh brings numbers with another fetch time, which have no
 * attempts yet; the attempts still on file for the numbers shown are the
 * failures, and each one doubles the wait for the next.
 */
export class RefreshLedger {
  constructor(private readonly dir: string) {}

  private mtime(name: string): number | undefined {
    try {
      return fs.statSync(path.join(this.dir, name)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  private static file(key: string, n: number): string {
    return `fetch-${key.replace(/[^\w.-]/g, "_")}-${n}`;
  }

  /** The attempts at the numbers named `key`. */
  attempts(key: string): Attempts {
    const attempts: Attempts = { count: 0 };
    for (;;) {
      const at = this.mtime(RefreshLedger.file(key, attempts.count));
      if (at === undefined) return attempts;
      attempts.lastAt = at;
      attempts.count++;
    }
  }

  /**
   * When the next refresh may start: 180 s after the last one on the host,
   * and after failed attempts at these numbers 360 s, 720 s, … up to 30
   * minutes after the last of them. A refresh the user asks for waits only
   * for the 180 s.
   */
  nextAt(key: string, manual: boolean): number {
    return this.due(this.attempts(key), manual);
  }

  private due({ count, lastAt }: Attempts, manual: boolean): number {
    const gap = (this.mtime(LAST) ?? -Infinity) + MIN_REFRESH_GAP_MS;
    if (manual || count === 0 || lastAt === undefined) return gap;
    return Math.max(gap, lastAt + Math.min(MAX_BACKOFF_MS, MIN_REFRESH_GAP_MS * 2 ** count));
  }

  /**
   * Claims the next attempt at these numbers when it is due: true for the one
   * window on the host that gets to make it. The attempt it counted is the
   * file it creates, so a window that saw an older count loses the race.
   */
  claim(key: string, now: number, manual: boolean = false): boolean {
    const attempts = this.attempts(key);
    if (now < this.due(attempts, manual)) return false;
    const file = path.join(this.dir, RefreshLedger.file(key, attempts.count));
    const seconds = now / 1000;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.closeSync(fs.openSync(file, "wx"));
      fs.utimesSync(file, seconds, seconds);
    } catch {
      return false;
    }
    try {
      const last = path.join(this.dir, LAST);
      fs.closeSync(fs.openSync(last, "a"));
      fs.utimesSync(last, seconds, seconds);
    } catch {
      // The attempt is on file; only the gap is lost.
    }
    return true;
  }

  /** Forgets attempts at numbers long gone. */
  prune(now: number, keepMs: number = 24 * 3_600_000): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith("fetch-")) continue;
      try {
        if (now - fs.statSync(path.join(this.dir, name)).mtimeMs > keepMs) fs.rmSync(path.join(this.dir, name), { force: true });
      } catch {
        // Another window removed it first.
      }
    }
  }
}
