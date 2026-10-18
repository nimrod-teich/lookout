import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CODEX = "codex";

/**
 * Codex's home: the setting, else `CODEX_HOME`, else `~/.codex`. Codex has no
 * setting that moves its sessions elsewhere, so its `config.toml` is never read.
 */
export function codexHome(setting: string | undefined, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const chosen = setting?.trim() || env.CODEX_HOME?.trim();
  if (!chosen) return path.join(home, ".codex");
  return chosen.startsWith("~") ? path.join(home, chosen.slice(1)) : path.resolve(chosen);
}

export function sessionsDir(home: string): string {
  return path.join(home, "sessions");
}

/** Codex's names for its threads: `{ id, thread_name, updated_at }` per line, the last line for an id winning. */
export function sessionIndexFile(home: string): string {
  return path.join(home, "session_index.jsonl");
}

/** `rollout-2026-10-18T15-03-41-01a14ee5-6f70-7b02-a9cb-7ad01294b026.jsonl` → its thread id. */
export function rolloutId(file: string): string | undefined {
  return /rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-([0-9a-f-]{36})\.jsonl$/i.exec(file)?.[1];
}

/**
 * The thread a file locks, when it is one of Codex's thread locks,
 * `<home>/thread-writer-locks/<id>.lock`: a process that loads a thread holds
 * its lock open until it lets the thread go.
 */
export function lockedThread(file: string): string | undefined {
  return /[\\/]thread-writer-locks[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i.exec(file)?.[1]?.toLowerCase();
}

/**
 * Codex's thread names, read again when the index changes. It names a thread
 * after its first exchange ("Answer 2+2"); until then a session goes by its
 * first prompt.
 */
export class ThreadNames {
  private signature = "";
  private names = new Map<string, string>();

  constructor(private readonly file: string) {}

  get(id: string): string | undefined {
    let signature: string;
    try {
      const st = fs.statSync(this.file);
      signature = `${st.mtimeMs}:${st.size}`;
    } catch {
      this.names.clear();
      this.signature = "";
      return undefined;
    }
    if (signature !== this.signature) {
      this.signature = signature;
      const names = new Map<string, string>();
      try {
        for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
            if (typeof entry.id === "string" && typeof entry.thread_name === "string" && entry.thread_name.trim()) names.set(entry.id, entry.thread_name.trim());
          } catch {
            // A line being written: the next change reads it whole.
          }
        }
      } catch {
        // Unreadable: no names.
      }
      this.names = names;
    }
    return this.names.get(id);
  }
}
