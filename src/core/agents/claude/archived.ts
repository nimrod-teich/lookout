import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** The key under which VS Code stores the Claude Code extension's state; compared without case. */
const STATE_KEY = "anthropic.claude-code";

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Where VS Code may keep the extension state that holds the archived
 * sessions. Extension state lives with the VS Code client, not with a remote
 * extension host, so under WSL the Windows side is looked at too. Only files
 * that exist are returned, nearest first.
 */
export function stateDbCandidates(globalStorageDir: string, platform: string = process.platform, mounts = "/mnt"): string[] {
  const out = [path.join(globalStorageDir, "state.vscdb")];
  if (platform === "linux") {
    for (const drive of safeReaddir(mounts)) {
      const users = path.join(mounts, drive, "Users");
      for (const user of safeReaddir(users)) {
        const roaming = path.join(users, user, "AppData", "Roaming");
        for (const code of safeReaddir(roaming)) {
          if (code === "Code" || code.startsWith("Code - ")) out.push(path.join(roaming, code, "User", "globalStorage", "state.vscdb"));
        }
      }
    }
  }
  return out.filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

interface Statement {
  all(...params: unknown[]): unknown[];
}

interface Database {
  prepare(sql: string): Statement;
  close(): void;
}

interface Sqlite {
  DatabaseSync: new (file: string, options: { readOnly: boolean }) => Database;
}

/** Node's own sqlite, in Node 22.5 and later; nothing on older runtimes. */
function loadSqlite(): Sqlite | undefined {
  try {
    return createRequire(path.join(process.cwd(), "lookout.js"))("node:sqlite") as Sqlite;
  } catch {
    return undefined;
  }
}

/** The sessions the Claude Code extension's user archived, read from VS Code's state database. */
export class ArchivedSessions {
  private readonly sqlite = loadSqlite();
  private cached: { file: string; mtimeMs: number; ids: Set<string> } | undefined;

  constructor(private readonly candidates: readonly string[]) {}

  /** The list can be read at all: a database was found and this runtime can open it. */
  get available(): boolean {
    return this.sqlite !== undefined && this.candidates.length > 0;
  }

  /** The archived session ids; empty when they cannot be read. Read again only when the database changed. */
  read(): ReadonlySet<string> {
    if (!this.sqlite) return new Set();
    for (const file of this.candidates) {
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (this.cached?.file === file && this.cached.mtimeMs === mtimeMs) return this.cached.ids;
      const ids = this.readFrom(file);
      if (!ids) continue;
      this.cached = { file, mtimeMs, ids };
      return ids;
    }
    return this.cached?.ids ?? new Set();
  }

  /** The ids in this database, or undefined when it holds no state for the extension or cannot be read. */
  private readFrom(file: string): Set<string> | undefined {
    try {
      const db = new this.sqlite!.DatabaseSync(file, { readOnly: true });
      try {
        const rows = db.prepare("SELECT value FROM ItemTable WHERE lower(key) = ?").all(STATE_KEY) as { value: unknown }[];
        const value = rows[0]?.value;
        if (typeof value !== "string") return undefined;
        const state = JSON.parse(value) as { hiddenSessionIds?: unknown };
        const ids = Array.isArray(state.hiddenSessionIds) ? state.hiddenSessionIds.filter((id): id is string => typeof id === "string") : [];
        return new Set(ids);
      } finally {
        db.close();
      }
    } catch {
      return undefined;
    }
  }
}
