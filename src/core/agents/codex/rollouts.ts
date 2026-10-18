import * as fs from "node:fs";
import * as path from "node:path";
import { readLineAt } from "../../jsonlTail";
import type { RolloutInfo } from "./match";
import { rolloutId } from "./paths";

/** The first line, `session_meta`, carries Codex's instructions: tens of kilobytes. */
const META_MAX_BYTES = 4 * 1024 * 1024;
/** Live sessions are looked for in the date folders of this many days back. */
const RECENT_DAYS = 7;
/** A lookup by id walks the whole tree at most this often. */
const WALK_MS = 60_000;

interface Meta {
  id: string;
  cwd?: string;
  createdAt?: number;
  originator?: string;
}

/** `session_meta`'s facts, from a rollout's first line. */
export function metaOf(line: string | undefined, file: string): Meta | undefined {
  const fallback = rolloutId(file);
  if (line === undefined) return fallback ? { id: fallback } : undefined;
  try {
    const record = JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> };
    const payload = record.type === "session_meta" ? record.payload : undefined;
    const id = typeof payload?.id === "string" ? payload.id : fallback;
    if (!id) return undefined;
    const created = Date.parse(typeof payload?.timestamp === "string" ? payload.timestamp : "");
    return {
      id,
      cwd: typeof payload?.cwd === "string" ? payload.cwd : undefined,
      createdAt: Number.isFinite(created) ? created : undefined,
      originator: typeof payload?.originator === "string" ? payload.originator : undefined,
    };
  } catch {
    return fallback ? { id: fallback } : undefined;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY/MM/DD` of a day, local and UTC: Codex files rollouts by the local date. */
function dayDirs(at: number): string[] {
  const d = new Date(at);
  const local = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const utc = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  return local === utc ? [local] : [local, utc];
}

/**
 * Codex's rollouts, as live sessions need them: the ones written lately, from
 * the date folders of the last days, and any one by its thread id. The first
 * line of each is read once.
 */
export class RolloutCatalog {
  private readonly metas = new Map<string, Meta | undefined>();
  private byIdFiles = new Map<string, string>();
  private walkedAt = -Infinity;

  constructor(private readonly dir: string) {}

  /** The rollouts written at or after `since` (epoch ms), in the date folders from that day to today. */
  recent(since: number, now: number): RolloutInfo[] {
    const from = Math.max(since, now - RECENT_DAYS * 86_400_000);
    const dirs = new Set<string>();
    for (let day = now; day >= from - 86_400_000; day -= 86_400_000) for (const dir of dayDirs(day)) dirs.add(dir);
    const out: RolloutInfo[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(this.dir, dir));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        const info = this.info(path.join(this.dir, dir, name));
        if (info && info.mtimeMs >= since) out.push(info);
      }
    }
    return out;
  }

  /** The rollout of a thread, wherever it is filed. */
  find(id: string, now: number): RolloutInfo | undefined {
    let file = this.byIdFiles.get(id);
    if (!file && now - this.walkedAt >= WALK_MS) {
      this.walkedAt = now;
      this.byIdFiles = this.walk();
      file = this.byIdFiles.get(id);
    }
    return file ? this.info(file) : undefined;
  }

  private info(file: string): RolloutInfo | undefined {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      this.metas.delete(file);
      return undefined;
    }
    if (!this.metas.has(file)) this.metas.set(file, metaOf(readLineAt(file, 0, META_MAX_BYTES), file));
    const meta = this.metas.get(file);
    return meta ? { file, ...meta, mtimeMs } : undefined;
  }

  /** Every rollout's file by thread id, from the names alone. */
  private walk(): Map<string, string> {
    const found = new Map<string, string>();
    const visit = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) visit(full, depth + 1);
        else if (entry.isFile()) {
          const id = rolloutId(entry.name);
          if (id) found.set(id, full);
        }
      }
    };
    visit(this.dir, 0);
    return found;
  }
}
