import * as fs from "node:fs";
import * as path from "node:path";
import type { ProcessTable } from "./proc";

/** How long a listing is reused before the directory is read again. */
const CACHE_MS = 5000;

interface WindowRecord {
  pid: number;
  label: string;
  /** Shell pids of the window's integrated terminals. */
  terminals?: number[];
  /** The window's folders. */
  folders?: string[];
}

/** Another VS Code window on this host that runs Lookout. */
export interface OtherWindow {
  label: string;
  /** Shell pids of its integrated terminals: the sessions it hosts in them descend from these. */
  terminals: readonly number[];
  /** Its folders: a session VS Code runs in its Chat view is its when it works in one of them. A window running an older Lookout gives none. */
  folders?: readonly string[];
}

/**
 * The VS Code windows on this host that run Lookout, by extension host pid.
 * Each window writes one file into a directory all windows share, with its
 * name and its terminals' shell pids, so a session hosted by another window,
 * in its panel or in one of its terminals, can be named and jumped to. A
 * file whose process is gone is removed by whoever reads it next.
 */
export class WindowRegistry {
  private cache = new Map<number, OtherWindow>();
  private readAt = -Infinity;

  constructor(
    private readonly dir: string,
    private readonly proc: ProcessTable,
  ) {}

  /** Records this window, and again whenever its terminals or folders change. */
  register(pid: number, label: string, terminals: Iterable<number> = [], folders: readonly string[] = []): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const record: WindowRecord = { pid, label, terminals: [...terminals].sort((a, b) => a - b), ...(folders.length ? { folders: [...folders] } : {}) };
      // Written whole under another name, then renamed: a reader never sees half a record.
      const temp = path.join(this.dir, `.${pid}.json.tmp`);
      fs.writeFileSync(temp, JSON.stringify(record));
      try {
        fs.renameSync(temp, this.file(pid));
      } catch {
        // Windows can refuse to replace a file another process holds: write it in place instead.
        fs.rmSync(temp, { force: true });
        fs.writeFileSync(this.file(pid), JSON.stringify(record));
      }
    } catch {
      // Without the registry, other windows show this one's sessions as "another window".
    }
  }

  /** Reads the directory again on the next `read`: a window's record changed. */
  invalidate(): void {
    this.readAt = -Infinity;
  }

  unregister(pid: number): void {
    fs.rmSync(this.file(pid), { force: true });
  }

  /** The other windows, excluding `selfPid`. */
  read(selfPid: number, now: number = Date.now()): ReadonlyMap<number, OtherWindow> {
    if (now - this.readAt < CACHE_MS) return this.cache;
    this.readAt = now;
    const windows = new Map<number, OtherWindow>();
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
      windows.set(record.pid, { label: record.label, terminals: record.terminals ?? [], ...(record.folders?.length ? { folders: record.folders } : {}) });
    }
    this.cache = windows;
    return windows;
  }

  private parse(name: string): WindowRecord | null {
    if (!/^\d+\.json$/.test(name)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as Partial<WindowRecord>;
      if (typeof raw.pid !== "number" || typeof raw.label !== "string" || `${raw.pid}.json` !== name) return null;
      const terminals = Array.isArray(raw.terminals) ? raw.terminals.filter((pid): pid is number => Number.isInteger(pid) && pid > 0) : [];
      const folders = Array.isArray(raw.folders) ? raw.folders.filter((folder): folder is string => typeof folder === "string") : [];
      return { pid: raw.pid, label: raw.label, terminals, folders };
    } catch {
      return null;
    }
  }

  private file(pid: number): string {
    return path.join(this.dir, `${pid}.json`);
  }
}
