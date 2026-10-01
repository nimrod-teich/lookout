import * as fs from "node:fs";
import * as path from "node:path";
import type { ProcessTable } from "./proc";

/** How long a listing is reused before the directory is read again. */
const CACHE_MS = 5000;

interface WindowRecord {
  pid: number;
  label: string;
}

/**
 * The VS Code windows on this host that run Lookout, by extension host pid.
 * Each window writes one file into a directory all windows share, so a
 * session hosted by another window can be named. A file whose process is
 * gone is removed by whoever reads it next.
 */
export class WindowRegistry {
  private cache = new Map<number, string>();
  private readAt = -Infinity;

  constructor(
    private readonly dir: string,
    private readonly proc: ProcessTable,
  ) {}

  /** Records this window. */
  register(pid: number, label: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const record: WindowRecord = { pid, label };
      fs.writeFileSync(this.file(pid), JSON.stringify(record));
    } catch {
      // Without the registry, other windows show this one's sessions as "another window".
    }
  }

  unregister(pid: number): void {
    fs.rmSync(this.file(pid), { force: true });
  }

  /** The other windows, excluding `selfPid`. */
  read(selfPid: number, now: number = Date.now()): ReadonlyMap<number, string> {
    if (now - this.readAt < CACHE_MS) return this.cache;
    this.readAt = now;
    const windows = new Map<number, string>();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      // No registry yet.
    }
    for (const name of names) {
      const record = this.parse(name);
      if (!record || record.pid === selfPid) continue;
      if (this.proc.get(record.pid) === null) {
        fs.rmSync(path.join(this.dir, name), { force: true });
        continue;
      }
      windows.set(record.pid, record.label);
    }
    this.cache = windows;
    return windows;
  }

  private parse(name: string): WindowRecord | null {
    if (!/^\d+\.json$/.test(name)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as Partial<WindowRecord>;
      if (typeof raw.pid !== "number" || typeof raw.label !== "string" || `${raw.pid}.json` !== name) return null;
      return { pid: raw.pid, label: raw.label };
    } catch {
      return null;
    }
  }

  private file(pid: number): string {
    return path.join(this.dir, `${pid}.json`);
  }
}
