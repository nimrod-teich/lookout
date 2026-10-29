import * as fs from "node:fs";
import * as path from "node:path";

/** No refresh of one source's numbers starts within this long of the last one on the host; without a source, of any. */
export const MIN_REFRESH_GAP_MS = 180_000;
/** No automatic refresh starts within this long of the last one on the host, whatever its source: two accounts never fetch at once. */
export const HOST_SPACING_MS = 10_000;
/** A refresh that keeps failing is tried at most this rarely. */
export const MAX_BACKOFF_MS = 30 * 60_000;
/** The file every attempt touches, for the spacing. */
const LAST = "last";
/** The prefix of the file each attempt at one source's numbers touches too, for that source's gap. */
const LAST_OF = "last-";
/** The prefix of the files that hold off one source's refreshes, each holding the epoch ms it lasts until. */
const HOLD = "hold-";

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
 * failures, and each one doubles the wait for the next. Each attempt also
 * touches `last-<scope>`, for that source's gap, and `last`, for the
 * spacing between any two. When the usage endpoint asks for a wait,
 * `hold-<scope>` holds off every refresh of that source's numbers until then.
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

  private static holdFile(scope: string): string {
    return `${HOLD}${scope.replace(/[^\w.-]/g, "_")}`;
  }

  private static lastFile(scope: string): string {
    return `${LAST_OF}${scope.replace(/[^\w.-]/g, "_")}`;
  }

  /**
   * Holds off every refresh of the numbers from `scope`, the ones the user
   * asks for too, until `until`: the usage endpoint asked for the wait. A
   * later hold replaces it.
   */
  hold(scope: string, until: number): void {
    const file = path.join(this.dir, RefreshLedger.holdFile(scope));
    const written = `${file}.${process.pid}`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Renamed into place, so no window reads half of it.
      fs.writeFileSync(written, String(until));
      fs.renameSync(written, file);
    } catch {
      // Not on file: the backoff still spaces out the next attempts.
    }
  }

  /** Epoch ms until which refreshes of the numbers from `scope` are held off; -Infinity when they are not. */
  heldUntil(scope: string): number {
    try {
      const until = Number(fs.readFileSync(path.join(this.dir, RefreshLedger.holdFile(scope)), "utf8"));
      return Number.isFinite(until) ? until : -Infinity;
    } catch {
      return -Infinity;
    }
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
   * When the next refresh may start: 180 s after the last one of the same
   * source's numbers on the host, and 10 s after the last one of any; after
   * failed attempts at these numbers 360 s, 720 s, … up to 30 minutes after
   * the last of them. A refresh the user asks for waits only for the 180 s.
   * Without a source, 180 s after the last refresh of any.
   */
  nextAt(key: string, manual: boolean, scope?: string): number {
    return this.due(this.attempts(key), manual, scope);
  }

  private due({ count, lastAt }: Attempts, manual: boolean, scope: string | undefined): number {
    const last = this.mtime(LAST) ?? -Infinity;
    const gap = scope === undefined ? last + MIN_REFRESH_GAP_MS : Math.max((this.mtime(RefreshLedger.lastFile(scope)) ?? -Infinity) + MIN_REFRESH_GAP_MS, manual ? -Infinity : last + HOST_SPACING_MS);
    if (manual || count === 0 || lastAt === undefined) return gap;
    return Math.max(gap, lastAt + Math.min(MAX_BACKOFF_MS, MIN_REFRESH_GAP_MS * 2 ** count));
  }

  /**
   * Claims the next attempt at these numbers when it is due: true for the one
   * window on the host that gets to make it. The attempt it counted is the
   * file it creates, so a window that saw an older count loses the race.
   */
  claim(key: string, now: number, manual: boolean = false, scope?: string): boolean {
    const attempts = this.attempts(key);
    if (now < this.due(attempts, manual, scope)) return false;
    const file = path.join(this.dir, RefreshLedger.file(key, attempts.count));
    const seconds = now / 1000;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.closeSync(fs.openSync(file, "wx"));
      fs.utimesSync(file, seconds, seconds);
    } catch {
      return false;
    }
    for (const name of [LAST, ...(scope === undefined ? [] : [RefreshLedger.lastFile(scope)])]) {
      try {
        const last = path.join(this.dir, name);
        fs.closeSync(fs.openSync(last, "a"));
        fs.utimesSync(last, seconds, seconds);
      } catch {
        // The attempt is on file; only the gap is lost.
      }
    }
    return true;
  }

  /** Forgets attempts at numbers long gone, and holds that are over. */
  prune(now: number, keepMs: number = 24 * 3_600_000): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const over = name.startsWith(HOLD) ? this.heldUntil(name.slice(HOLD.length)) <= now : (name.startsWith("fetch-") || name.startsWith(LAST_OF)) && now - (this.mtime(name) ?? now) > keepMs;
      if (!over) continue;
      try {
        fs.rmSync(path.join(this.dir, name), { force: true });
      } catch {
        // Another window removed it first.
      }
    }
  }
}
