import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const COPILOT = "copilot";

/** Copilot's home: the setting, else `COPILOT_HOME`, else `~/.copilot`. */
export function copilotHome(setting: string | undefined, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const chosen = setting?.trim() || env.COPILOT_HOME?.trim();
  if (!chosen) return path.join(home, ".copilot");
  return chosen.startsWith("~") ? path.join(home, chosen.slice(1)) : path.resolve(chosen);
}

/** One folder per session: `events.jsonl`, `workspace.yaml`, and `inuse.<pid>.lock` while a process holds it. */
export function sessionStateDir(home: string): string {
  return path.join(home, "session-state");
}

/** Copilot's record of its open sessions: `{ <id>: { openedAt, refreshedAt, working } }`. */
export function openSessionsFile(home: string): string {
  return path.join(home, "open-sessions-state.json");
}

/** A session's `workspace.yaml`: flat `key: value` lines. */
export interface Workspace {
  id?: string;
  cwd?: string;
  /** Who runs it: `github/cli` for the terminal program. */
  clientName?: string;
  /** Copilot's title for it, or the user's. */
  name?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** Reads the flat `key: value` lines Copilot writes; values may be quoted. */
export function parseWorkspace(text: string): Workspace {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-z_]+):\s?(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"');
    fields.set(match[1]!, value);
  }
  const time = (key: string) => {
    const ms = Date.parse(fields.get(key) ?? "");
    return Number.isFinite(ms) ? ms : undefined;
  };
  return { id: fields.get("id"), cwd: fields.get("cwd"), clientName: fields.get("client_name"), name: fields.get("name") || undefined, createdAt: time("created_at"), updatedAt: time("updated_at") };
}

/** A session's events: one JSON line per event, the conversation among them. */
export function eventsFile(dir: string): string {
  return path.join(dir, "events.jsonl");
}

export function readWorkspace(dir: string): Workspace | undefined {
  try {
    return parseWorkspace(fs.readFileSync(path.join(dir, "workspace.yaml"), "utf8"));
  } catch {
    return undefined;
  }
}

/** The pids that hold a session open, from its `inuse.<pid>.lock` files. */
export function lockPids(dir: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((name) => /^inuse\.(\d+)\.lock$/.exec(name)?.[1]).filter((pid): pid is string => pid !== undefined).map(Number);
}

/** The `working` flag of each open session, with when Copilot last refreshed it. */
export function readOpenSessions(file: string): Map<string, { working: boolean; refreshedAt?: number }> {
  const out = new Map<string, { working: boolean; refreshedAt?: number }>();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { working?: unknown; refreshedAt?: unknown }>;
    for (const [id, entry] of Object.entries(parsed)) {
      if (typeof entry?.working !== "boolean") continue;
      const at = Date.parse(typeof entry.refreshedAt === "string" ? entry.refreshedAt : "");
      out.set(id, { working: entry.working, refreshedAt: Number.isFinite(at) ? at : undefined });
    }
  } catch {
    // Missing, or being rewritten: no flags this time.
  }
  return out;
}
