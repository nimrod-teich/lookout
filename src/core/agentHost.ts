// The sessions VS Code runs itself, in its Chat view, through its agent host:
// Copilot (the "Copilot" session type), and Claude and Codex where VS Code
// runs them. The agent keeps the session where it always does (Copilot in
// `~/.copilot/session-state/<id>`), under its own id; VS Code gives the
// session another id, and keeps, for each, a folder
// `<VS Code data>/agentSessionData/<VS Code id>/` whose `session.db` names the
// agent's id: table `session_metadata`, key `defaultChatProviderData`, a JSON
// value with `sdkSessionId`. VS Code addresses the session as
// `agent-host-<provider>:/<VS Code id>`.
import * as fs from "node:fs";
import * as path from "node:path";
import { loadSqlite, type Sqlite } from "./sqlite";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A session's folder is made when the session is: this much before the agent's own record of it, at most. */
const SLACK_MS = 60_000;
/** Databases read at most per look, newest first; the rest wait for the next look. */
const READS_PER_LOOK = 25;

/** VS Code's sessions in its agent host, by the id their agent gives them. */
export class AgentHostSessions {
  private readonly sqlite: Sqlite | undefined;
  /** The agent's id each folder names, by folder name; null when it names none. */
  private readonly read = new Map<string, string | null>();

  /** `dir`: `<VS Code data>/agentSessionData`; `sqlite`: null where there is none. */
  constructor(
    private readonly dir: string | undefined,
    sqlite: Sqlite | null = loadSqlite() ?? null,
  ) {
    this.sqlite = sqlite ?? undefined;
  }

  /** Lookout can read VS Code's sessions here. */
  get available(): boolean {
    return this.dir !== undefined && this.sqlite !== undefined;
  }

  /**
   * VS Code's id for the session its agent knows as `agentId`, made at
   * `createdAt` (epoch ms) when known: the folders made since then are read
   * first, newest first.
   */
  idOf(agentId: string, createdAt?: number): string | undefined {
    for (const [folder, id] of this.read) if (id === agentId) return folder;
    if (!this.available) return undefined;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir!).filter((name) => UUID.test(name) && !this.read.has(name));
    } catch {
      return undefined;
    }
    const folders = names
      .map((name) => ({ name, mtimeMs: mtimeOf(path.join(this.dir!, name)) }))
      .filter((folder) => createdAt === undefined || folder.mtimeMs >= createdAt - SLACK_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, READS_PER_LOOK);
    for (const { name } of folders) {
      const id = this.agentIdIn(path.join(this.dir!, name, "session.db"));
      this.read.set(name, id ?? null);
      if (id === agentId) return name;
    }
    return undefined;
  }

  private agentIdIn(file: string): string | undefined {
    if (!fs.existsSync(file)) return undefined;
    try {
      const db = new this.sqlite!.DatabaseSync(file, { readOnly: true });
      try {
        const rows = db.prepare("SELECT value FROM session_metadata WHERE key = ?").all("defaultChatProviderData") as { value: unknown }[];
        const value = rows[0]?.value;
        if (typeof value !== "string") return undefined;
        const id = (JSON.parse(value) as { sdkSessionId?: unknown }).sdkSessionId;
        return typeof id === "string" ? id : undefined;
      } finally {
        db.close();
      }
    } catch {
      return undefined;
    }
  }
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
