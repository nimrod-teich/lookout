import * as fs from "node:fs";
import * as path from "node:path";
import type { UsageMeter } from "./usage";
import { AMBER_FROM, RED_FROM } from "./usageGroups";

/**
 * The thresholds announced per kind of meter, in percent, where the bars
 * change colour: a model's own weekly limit (`weekly_scoped:Fable`) as the
 * all-models one.
 */
export const ALERT_THRESHOLDS: Readonly<Record<string, readonly number[]>> = {
  session: [AMBER_FROM, RED_FROM],
  weekly_all: [RED_FROM],
  weekly_scoped: [RED_FROM],
};

export interface UsageAlert {
  /** Names the meter, the threshold and the window, so each is announced once. */
  id: string;
  meter: UsageMeter;
  threshold: number;
}

/**
 * The window a reset time belongs to, by its minute: each fetch reports the
 * same reset with a different fraction of a second.
 */
function windowOf(resetsAt: number | undefined): string {
  return resetsAt === undefined ? "none" : String(Math.round(resetsAt / 60_000));
}

/**
 * The thresholds the meters have reached, one per meter (the highest), each
 * named for its window and for where the numbers come from (`scope`, one per
 * account's cache): a window announces each threshold once.
 */
export function reachedThresholds(meters: readonly UsageMeter[], scope: string = ""): UsageAlert[] {
  const alerts: UsageAlert[] = [];
  for (const meter of meters) {
    const kind = meter.key.split(":")[0]!;
    const reached = (ALERT_THRESHOLDS[kind] ?? []).filter((threshold) => meter.percent >= threshold);
    const threshold = reached.at(-1);
    if (threshold === undefined) continue;
    alerts.push({ id: `${scope ? `${scope}-` : ""}${meter.key}-${threshold}-${windowOf(meter.resetsAt)}`, meter, threshold });
  }
  return alerts;
}

/** A short name for where usage numbers come from, fit for a file name: the same for the same cache file. */
export function scopeOf(cacheFile: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < cacheFile.length; i++) {
    hash ^= cacheFile.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Which alerts were announced already, shared by every window on the host:
 * one file per alert in a directory they all see, created exclusively, so
 * exactly one window announces each.
 */
export class AlertLedger {
  constructor(private readonly dir: string) {}

  /** True for the one caller that gets to announce this alert. */
  claim(id: string): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.closeSync(fs.openSync(path.join(this.dir, id.replace(/[^\w.-]/g, "_")), "wx"));
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets the alerts of windows that have reset, so the directory stays small. */
  prune(now: number, keepMs: number = 8 * 24 * 3_600_000): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        if (now - fs.statSync(path.join(this.dir, name)).mtimeMs > keepMs) fs.rmSync(path.join(this.dir, name), { force: true });
      } catch {
        // Another window removed it first.
      }
    }
  }
}
