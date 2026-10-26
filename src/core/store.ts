// Where the conversations outlive the agents' transcripts: a SQLite
// database of Lookout's own, with what the user and the agent said in every
// conversation read, the paths the tool calls worked on, how far each file
// was read, and the sessions the conversations belong to. The thread that
// reads the files writes it as it reads; the extension host searches it,
// through an FTS5 index, and reads a conversation from it once the agent has
// deleted the transcript. Nothing here needs VS Code, and nothing happens
// where the runtime has no `node:sqlite`.
import * as fs from "node:fs";
import * as path from "node:path";
import { snippetOf, type HistoryMessage, type Scan, type Scanned, type SearchHit, type SnippetSize } from "./history";
import { loadSqlite, type Database } from "./sqlite";
import { inRange, type TimeRange } from "./terms";

/** A session the store knows: whose conversation it holds, and whether the agent's transcript is gone. */
export interface StoredSession {
  id: string;
  agent: string;
  /** The conversation file the messages were read from. */
  file: string;
  title: string;
  cwd: string;
  branch?: string;
  /** Epoch ms the transcript was last written, as last seen. */
  modifiedAt?: number;
  /** Epoch ms the transcript was first found gone; none while it is there. */
  purgedAt?: number;
}

/** How far a conversation file was read into the store. */
export interface FileProgress {
  identity: string;
  end: number;
  tail?: string;
  /** How many messages the store holds of it. */
  messages: number;
  /** The build of the reading code that read it. */
  build: string;
}

/** What a sweep of the transcripts found. */
export interface Sweep {
  /** Sessions whose transcript is newly gone. */
  purged: string[];
  /** Sessions whose transcript is back. */
  returned: string[];
  /** Sessions forgotten: their transcript is gone, and nothing is kept of them, or keeping is off. */
  forgotten: string[];
}

/** What a sweep lets go of, when keeping is off: the sessions purged since `after`, once `graceMs` have passed, in case the transcript was only out of reach for a moment. */
export interface Letting {
  after: number;
  graceMs: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  file TEXT PRIMARY KEY,
  reader TEXT NOT NULL,
  identity TEXT NOT NULL,
  end INTEGER NOT NULL,
  tail TEXT,
  messages INTEGER NOT NULL DEFAULT 0,
  build TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  file TEXT NOT NULL,
  idx INTEGER NOT NULL,
  role TEXT NOT NULL,
  at INTEGER,
  text TEXT NOT NULL,
  PRIMARY KEY (file, idx)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, file UNINDEXED, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, file) VALUES (new.rowid, new.text, new.file);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, file) VALUES ('delete', old.rowid, old.text, old.file);
END;
CREATE TABLE IF NOT EXISTS paths (
  file TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (file, path)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  file TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  branch TEXT,
  modified_at INTEGER,
  purged_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_file ON sessions(file);
`;

/** A path as the store keeps it: lowercased, with forward slashes. */
function pathKey(p: string): string {
  return p.toLowerCase().replace(/\\/g, "/");
}

/**
 * An FTS5 query for the terms: each a phrase matched at a word's start
 * (`retag` finds "retag" and "retagging", `"retag recipe"` the two words in
 * a row), all of them required.
 */
export function ftsQuery(terms: readonly string[]): string {
  return terms
    .filter((term) => term !== "")
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(" ");
}

/** Tries `work` a few times, a moment apart, for the opening of a database another window opens or closes at the same time. */
function retrying<T>(work: () => T, tries = 5, waitMs = 100): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return work();
    } catch (error) {
      if (attempt >= tries) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

export class ConversationStore {
  /** The store in `file`, made on first use; nothing where the runtime has no `node:sqlite`, or the file cannot be opened. */
  static open(file: string): ConversationStore | undefined {
    const sqlite = loadSqlite();
    if (!sqlite) return undefined;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = new sqlite.DatabaseSync(file);
      // The busy handler first: the rest contends with another window opening or closing the same file.
      db.exec("PRAGMA busy_timeout = 5000");
      retrying(() => db.exec("PRAGMA journal_mode = WAL"));
      retrying(() => db.exec(SCHEMA));
      return new ConversationStore(db, file);
    } catch {
      return undefined;
    }
  }

  private constructor(
    private readonly db: Database,
    readonly file: string,
  ) {}

  /** How far a conversation file was read, when it was. */
  progress(file: string): FileProgress | undefined {
    const row = this.db.prepare("SELECT identity, end, tail, messages, build FROM files WHERE file = ?").get(file) as { identity: string; end: number; tail: string | null; messages: number; build: string } | undefined;
    return row ? { identity: row.identity, end: row.end, tail: row.tail ?? undefined, messages: row.messages, build: row.build } : undefined;
  }

  /**
   * Takes in what a scan of a file found. A whole read (`reset`) goes in
   * place of whatever was held. An increment goes in only from where the
   * store stopped (`job.from`), of the file it read, by the build that read
   * it; one the store is already past adds nothing, and one that would
   * leave a hole is refused. One transaction: a reader meanwhile sees the
   * file before or after. True when the store holds the file to the scan's
   * end.
   */
  record(job: Pick<Scan, "file" | "reader" | "from">, scanned: Scanned, build: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const before = this.progress(job.file);
      let count: number;
      if (scanned.reset) {
        this.db.prepare("DELETE FROM messages WHERE file = ?").run(job.file);
        this.db.prepare("DELETE FROM paths WHERE file = ?").run(job.file);
        count = 0;
      } else {
        if (!before || before.build !== build || before.identity !== scanned.identity) {
          this.db.exec("ROLLBACK");
          return false;
        }
        if (before.end !== job.from) {
          // Another window wrote these lines already, or more; or the store is behind them, and a hole would form.
          this.db.exec("ROLLBACK");
          return before.end >= scanned.end;
        }
        count = before.messages;
      }
      const message = this.db.prepare("INSERT OR IGNORE INTO messages(file, idx, role, at, text) VALUES (?, ?, ?, ?, ?)");
      const path = this.db.prepare("INSERT OR IGNORE INTO paths(file, path) VALUES (?, ?)");
      for (const line of scanned.lines) {
        if (line.facts.message) {
          const m = line.facts.message;
          message.run(job.file, count++, m.role, m.at ?? null, m.text);
        }
        for (const p of line.facts.paths ?? []) path.run(job.file, pathKey(p));
      }
      this.db
        .prepare("INSERT INTO files(file, reader, identity, end, tail, messages, build) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET reader = excluded.reader, identity = excluded.identity, end = excluded.end, tail = excluded.tail, messages = excluded.messages, build = excluded.build")
        .run(job.file, job.reader, scanned.identity, scanned.end, scanned.tail ?? null, count, build);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The store holds the file's conversation, as far as it was read. */
  has(file: string): boolean {
    return this.progress(file) !== undefined;
  }

  /** The messages of a conversation file, oldest first; none when the store never read it. */
  messages(file: string): HistoryMessage[] | undefined {
    if (!this.has(file)) return undefined;
    const rows = this.db.prepare("SELECT role, at, text FROM messages WHERE file = ? ORDER BY idx").all(file) as { role: "you" | "agent"; at: number | null; text: string }[];
    return rows.map((row) => (row.at === null ? { role: row.role, text: row.text } : { role: row.role, at: row.at, text: row.text }));
  }

  /**
   * The messages of these files holding every term, newest first per file;
   * `limit` of each file's cut into snippets, and all of them counted.
   * A term matches at a word's start.
   */
  search(files: readonly string[], terms: readonly string[], limit: number, range?: TimeRange, size?: SnippetSize): Map<string, { count: number; hits: SearchHit[] }> {
    const out = new Map<string, { count: number; hits: SearchHit[] }>();
    const query = ftsQuery(terms);
    if (query === "" || files.length === 0) return out;
    const rows = this.db
      .prepare("SELECT m.file AS file, m.idx AS idx, m.role AS role, m.at AS at, m.text AS text FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? AND m.file IN (SELECT value FROM json_each(?)) ORDER BY m.file, m.idx DESC")
      .all(query, JSON.stringify(files)) as { file: string; idx: number; role: "you" | "agent"; at: number | null; text: string }[];
    const lower = terms.map((term) => term.toLowerCase());
    for (const row of rows) {
      const at = row.at ?? undefined;
      if (!inRange(at, range)) continue;
      let result = out.get(row.file);
      if (!result) {
        result = { count: 0, hits: [] };
        out.set(row.file, result);
      }
      result.count++;
      if (result.hits.length < limit) result.hits.push({ index: row.idx, role: row.role, at, ...snippetOf(row.text, lower, size) });
    }
    return out;
  }

  /** Of these files, those whose tool calls worked on a path containing any of the parts (lowercased, forward slashes). */
  touched(files: readonly string[], parts: readonly string[]): Set<string> {
    const out = new Set<string>();
    if (files.length === 0 || parts.length === 0) return out;
    const rows = this.db.prepare("SELECT DISTINCT file, path FROM paths WHERE file IN (SELECT value FROM json_each(?))").all(JSON.stringify(files)) as { file: string; path: string }[];
    for (const row of rows) if (parts.some((part) => row.path.includes(part))) out.add(row.file);
    return out;
  }

  /** Of these files, those with a message written within the range. */
  withMessagesIn(files: readonly string[], range: TimeRange): Set<string> {
    const out = new Set<string>();
    if (files.length === 0) return out;
    const rows = this.db
      .prepare("SELECT DISTINCT file FROM messages WHERE file IN (SELECT value FROM json_each(?)) AND at IS NOT NULL AND (? IS NULL OR at >= ?) AND (? IS NULL OR at < ?)")
      .all(JSON.stringify(files), range.since ?? null, range.since ?? null, range.before ?? null, range.before ?? null) as { file: string }[];
    for (const row of rows) out.add(row.file);
    return out;
  }

  /** Writes down what a session is called and where its conversation is, when that changed; a time left out, as for a running session, keeps the one on record. A conversation left behind under another path goes, unless another session has it. */
  rememberSession(session: Omit<StoredSession, "purgedAt">): void {
    const row = this.db.prepare("SELECT agent, file, title, cwd, branch, modified_at, purged_at FROM sessions WHERE id = ?").get(session.id) as { agent: string; file: string; title: string; cwd: string; branch: string | null; modified_at: number | null; purged_at: number | null } | undefined;
    const same = row && row.agent === session.agent && row.file === session.file && row.title === session.title && row.cwd === session.cwd && (row.branch ?? undefined) === session.branch && (session.modifiedAt === undefined || (row.modified_at ?? undefined) === session.modifiedAt);
    if (same && row.purged_at === null) return;
    this.db
      .prepare(
        "INSERT INTO sessions(id, agent, file, title, cwd, branch, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, file = excluded.file, title = excluded.title, cwd = excluded.cwd, branch = excluded.branch, modified_at = COALESCE(excluded.modified_at, sessions.modified_at), purged_at = NULL",
      )
      .run(session.id, session.agent, session.file, session.title, session.cwd, session.branch ?? null, session.modifiedAt ?? null);
    if (row && row.file !== session.file) this.dropFileIfUnreferenced(row.file);
  }

  /** The session the store knows by this id. */
  session(id: string): StoredSession | undefined {
    const row = this.db.prepare("SELECT id, agent, file, title, cwd, branch, modified_at, purged_at FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? sessionOf(row) : undefined;
  }

  /** The sessions whose transcript is gone, the most recently written first. */
  purged(): StoredSession[] {
    const rows = this.db.prepare("SELECT id, agent, file, title, cwd, branch, modified_at, purged_at FROM sessions WHERE purged_at IS NOT NULL ORDER BY modified_at DESC, id").all() as SessionRow[];
    return rows.map(sessionOf);
  }

  /**
   * Looks for every session's transcript. One gone is marked purged, and
   * one back unmarked. A session the store holds nothing of, and whose
   * transcript is not kept elsewhere (`kept`), is forgotten at once: there
   * is nothing to keep. With keeping off (`letting`), a session purged
   * since keeping went off is forgotten once the grace has passed; what
   * was kept before stays until the user forgets it.
   */
  sweep(now: number, kept: ReadonlySet<string> = new Set(), letting?: Letting): Sweep {
    const out: Sweep = { purged: [], returned: [], forgotten: [] };
    const rows = this.db.prepare("SELECT s.id AS id, s.file AS file, s.purged_at AS purged_at, f.file IS NOT NULL AS held FROM sessions s LEFT JOIN files f ON f.file = s.file").all() as { id: string; file: string; purged_at: number | null; held: number }[];
    for (const row of rows) {
      if (fs.existsSync(row.file)) {
        if (row.purged_at !== null) {
          this.db.prepare("UPDATE sessions SET purged_at = NULL WHERE id = ?").run(row.id);
          out.returned.push(row.id);
        }
        continue;
      }
      if (!row.held && !kept.has(row.id)) {
        this.forget([row.id]);
        out.forgotten.push(row.id);
      } else if (row.purged_at === null) {
        this.db.prepare("UPDATE sessions SET purged_at = ? WHERE id = ?").run(now, row.id);
        out.purged.push(row.id);
      } else if (letting && row.purged_at >= letting.after && now - row.purged_at >= letting.graceMs) {
        this.forget([row.id]);
        out.forgotten.push(row.id);
      }
    }
    return out;
  }

  /** Forgets these sessions: their rows, and their conversations unless another session shares the file. */
  forget(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        const row = this.db.prepare("SELECT file FROM sessions WHERE id = ?").get(id) as { file: string } | undefined;
        this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
        if (row) this.dropFileIfUnreferenced(row.file);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The conversation of a file no session names any more goes. */
  private dropFileIfUnreferenced(file: string): void {
    if (this.db.prepare("SELECT 1 FROM sessions WHERE file = ? LIMIT 1").get(file)) return;
    this.db.prepare("DELETE FROM messages WHERE file = ?").run(file);
    this.db.prepare("DELETE FROM paths WHERE file = ?").run(file);
    this.db.prepare("DELETE FROM files WHERE file = ?").run(file);
  }

  /** Forgets every purged session; how many. */
  forgetPurged(): number {
    const ids = this.purged().map((session) => session.id);
    this.forget(ids);
    return ids.length;
  }

  /** How many messages the store holds, and of how many files. */
  size(): { files: number; messages: number } {
    const row = this.db.prepare("SELECT (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM messages) AS messages").get() as { files: number; messages: number };
    return { files: row.files, messages: row.messages };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Closed already.
    }
  }
}

interface SessionRow {
  id: string;
  agent: string;
  file: string;
  title: string;
  cwd: string;
  branch: string | null;
  modified_at: number | null;
  purged_at: number | null;
}

function sessionOf(row: SessionRow): StoredSession {
  const session: StoredSession = { id: row.id, agent: row.agent, file: row.file, title: row.title, cwd: row.cwd };
  if (row.branch !== null) session.branch = row.branch;
  if (row.modified_at !== null) session.modifiedAt = row.modified_at;
  if (row.purged_at !== null) session.purgedAt = row.purged_at;
  return session;
}
