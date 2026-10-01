import * as fs from "node:fs";
import * as path from "node:path";
import type { ProcessTable } from "../../proc";
import { parseSessionFile, type SessionFile } from "./sessionFile";

const SESSION_FILE = /^(\d+)\.json$/;
/** Kinds that are Claude Code's own plumbing, not sessions a user talks to. */
const HIDDEN_KINDS: readonly string[] = ["daemon", "daemon-worker"];
/** A session records its start a moment after its process starts, never this long before. */
const START_SLACK_MS = 10_000;

interface CachedFile {
  mtimeMs: number;
  size: number;
  parsed: SessionFile;
  /** The process that wrote this version of the file is gone; only a rewrite revives it. */
  dead: boolean;
}

/**
 * Lists the live Claude Code sessions on this host from `<config>/sessions`.
 * Files outlive their process, so every record is checked against the process table.
 */
export class SessionRegistry {
  private readonly files = new Map<string, CachedFile>();

  constructor(
    private readonly dir: string,
    private readonly proc: ProcessTable,
  ) {}

  scan(): SessionFile[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      this.files.clear();
      return [];
    }
    const seen = new Set<string>();
    const byId = new Map<string, SessionFile>();
    for (const name of names) {
      const match = SESSION_FILE.exec(name);
      if (!match) continue;
      seen.add(name);
      const cached = this.read(name);
      if (!cached || cached.dead || cached.parsed.pid !== Number(match[1])) continue;
      if (!this.isLive(cached)) continue;
      // A resumed session leaves its id in older files; the newest live one wins.
      const file = cached.parsed;
      const other = byId.get(file.sessionId);
      if (!other || freshness(file) > freshness(other)) byId.set(file.sessionId, file);
    }
    for (const name of this.files.keys()) if (!seen.has(name)) this.files.delete(name);
    return [...byId.values()];
  }

  private read(name: string): CachedFile | null {
    const file = path.join(this.dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const cached = this.files.get(name);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
    let parsed: SessionFile | null = null;
    try {
      parsed = parseSessionFile(fs.readFileSync(file, "utf8"));
    } catch {
      // Unreadable right now; fall through to the last good record.
    }
    // A torn read keeps the last good record and is retried on the next scan.
    if (!parsed) return cached ?? null;
    const fresh = { mtimeMs: st.mtimeMs, size: st.size, parsed, dead: false };
    this.files.set(name, fresh);
    return fresh;
  }

  private isLive(cached: CachedFile): boolean {
    const file = cached.parsed;
    if (file.spare || (file.kind !== undefined && HIDDEN_KINDS.includes(file.kind))) return false;
    // A pid from another pid namespace means nothing in ours.
    const domain = this.proc.pidDomain();
    if (file.pidDomain && domain && file.pidDomain !== domain) return false;
    const info = this.proc.get(file.pid);
    // The pid is gone, or it now belongs to another process: one with a different
    // start time, or one that started after the session did.
    const reused =
      info !== null &&
      ((file.procStart !== undefined && info.startTicks !== undefined && file.procStart !== info.startTicks) ||
        (file.startedAt !== undefined && info.startedMs !== undefined && info.startedMs > file.startedAt + START_SLACK_MS));
    if (info === null || reused) {
      cached.dead = true;
      return false;
    }
    return true;
  }
}

function freshness(file: SessionFile): number {
  return file.statusUpdatedAt ?? file.startedAt ?? 0;
}
