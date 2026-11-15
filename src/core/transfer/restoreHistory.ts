// The backup's history database merged into this machine's. Only sessions
// whose transcript is not on this machine go in: Lookout reads the others
// from their transcripts itself. The backup's database is a copy taken out
// of the file, and may come from anyone: it is checked before anything is
// read from it (whole, its tables plain tables, of a bounded size), first in
// a connection of its own, then attached to this machine's, where other
// windows may be writing, for one transaction with explicit column lists.
// Where the two were made by different versions, the columns both have are
// taken. Every lookup of one table's rows in another's goes through an index
// the restore makes or this machine's database has, whatever the backup's
// tables are keyed by, so no step grows with the square of the rows. The
// databases are read and written in a thread of their own, so the extension
// host goes on meanwhile. When a step fails, SQLite's own words go to the
// log and never into the message shown: the backup can put its own in them.
import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { ConversationStore } from "../store";
import { loadSqlite } from "../sqlite";

/** A session as the backup's history has it. */
export interface HistorySession {
  id: string;
  agent: string;
  /** Its conversation file on the source machine. */
  file: string;
  /** Where it worked on the source machine. */
  cwd: string;
  /** Epoch ms its transcript was found gone on the source machine; none while it was there. */
  purgedAt?: number;
  /** The backup holds the conversation of its file. */
  held: boolean;
}

/** A session to add, as it is on this machine. */
export interface HistoryPlace {
  file: string;
  cwd: string;
}

/** How the merge went. */
export interface HistoryMerge {
  added: number;
  /** `table.column` this version has and the backup's database does not. */
  missing: string[];
  /** `table.column` the backup's database has and this version does not: left out. */
  extra: string[];
  /** Why nothing went in, when nothing could. */
  failed?: string;
}

/** The most rows of each table a backup's history is read with. */
export interface HistoryLimits {
  sessions: number;
  files: number;
  messages: number;
  paths: number;
}

export interface HistoryReadOptions {
  /** Hears why a step failed, in SQLite's words, which can carry the backup's own. */
  log?(message: string): void;
  /** Lower limits in place of the usual ones, for tests. */
  limits?: Partial<HistoryLimits>;
}

export interface MergeOptions extends HistoryReadOptions {
  /** A session's place on this machine, when it is to go in; undefined leaves it out. */
  choose(session: HistorySession): HistoryPlace | undefined;
  /** A path a tool call worked on, as the store keys it, mapped to this machine. */
  mapPathKey(key: string): string;
  /** Where to copy this machine's database before anything goes into it; undefined when no copy can be made. */
  snapshot(): string | undefined;
  now: number;
}

/** The tables merged, with the columns each needs to go in at all. Tool calls and results stay out: they are never kept past a transcript's purge. */
const TABLES = {
  sessions: ["id", "agent", "file", "title", "cwd"],
  files: ["file", "reader", "identity", "end", "build"],
  messages: ["file", "idx", "role", "text"],
  paths: ["file", "path"],
} as const;
type Table = keyof typeof TABLES;
const TABLE_NAMES = Object.keys(TABLES) as Table[];

/** Far above what Lookout's own history holds; a history past them is not one it wrote, and would take too long to read. */
const LIMITS: HistoryLimits = { sessions: 500_000, files: 2_000_000, messages: 20_000_000, paths: 5_000_000 };

/** Other windows hold the database open: a write waits this long for them. */
const BUSY_MS = 10_000;

/** A column name of Lookout's own schema, safe to put in a statement. */
const COLUMN = /^[a-z_]+$/;

/** How a table SQLite made from a plain `CREATE TABLE` begins in the schema; a virtual table's begins `CREATE VIRTUAL TABLE`. */
const PLAIN_TABLE = /^CREATE TABLE /i;

/** How long a loop on the extension host's thread runs before it lets the rest have a turn. */
const SLICE_MS = 20;

const NO_SQLITE = "this runtime has no SQLite";
const FOREIGN = "the backup's history database is not one Lookout writes";
const DAMAGED = "the backup's history database is damaged";
const TOO_LARGE = "the backup's history database is too large to restore";
const UNREADABLE = "the backup's history database could not be read";

function quoted(columns: readonly string[], table?: string): string {
  return columns.map((column) => (table ? `${table}."${column}" AS "${column}"` : `"${column}"`)).join(", ");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : typeof value === "bigint" ? Number(value) : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The thread

type SqlValue = string | number | null;

/** A statement for the history thread: `exec` runs SQL text; `all` and `get` read rows; `run`, and `each` once per row of parameters, write and count the rows changed. */
export type HistoryOp = { kind: "exec"; sql: string } | { kind: "all" | "get" | "run"; sql: string; params: SqlValue[] } | { kind: "each"; sql: string; rows: SqlValue[][] };

export interface HistoryRequest {
  /** The database to open first: read-only for a backup's copy alone, with a busy timeout for this machine's. */
  open?: { file: string; readOnly: boolean; busyMs?: number };
  ops: HistoryOp[];
  /** The statements in one transaction that takes the write lock at once: all of them, or none. */
  atomic?: boolean;
}

/** Run in a thread of its own: checking, copying and merging can take seconds on a large database, and the extension host goes on meanwhile. */
const HISTORY_THREAD = `
const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
function open({ file, readOnly, busyMs }) {
  db = new DatabaseSync(file, { readOnly, allowExtension: false, defensive: true });
  // The busy handler first: other windows hold this machine's database open.
  if (busyMs) db.exec("PRAGMA busy_timeout = " + Number(busyMs));
  // No SQL changes the file's structure behind SQLite's back.
  if (typeof db.enableDefensive === "function") db.enableDefensive(true);
  // Nothing in a schema runs a function with side effects, and a page whose cells do not fit it is an error as it is read.
  db.exec("PRAGMA trusted_schema = OFF");
  db.exec("PRAGMA cell_size_check = ON");
}
function perform(op) {
  if (op.kind === "exec") return db.exec(op.sql);
  const statement = db.prepare(op.sql);
  if (op.kind === "all") return statement.all(...op.params);
  if (op.kind === "get") return statement.get(...op.params);
  if (op.kind === "run") return Number(statement.run(...op.params).changes);
  let changes = 0;
  for (const params of op.rows) changes += Number(statement.run(...params).changes);
  return changes;
}
parentPort.on("message", (request) => {
  if (request.close) {
    try {
      if (db) db.close();
    } catch {}
    db = undefined;
    parentPort.postMessage({ results: [] });
    return;
  }
  try {
    if (request.open) open(request.open);
    if (request.atomic) db.exec("BEGIN IMMEDIATE");
    let results;
    try {
      results = request.ops.map(perform);
      if (request.atomic) db.exec("COMMIT");
    } catch (error) {
      if (request.atomic) {
        try {
          db.exec("ROLLBACK");
        } catch {}
      }
      throw error;
    }
    parentPort.postMessage({ results });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
`;

type Reply = { results: unknown[] } | { error: string };

/**
 * A thread of its own for the history databases: one connection, opened by
 * the first request, with extensions off, the defensive flag on where the
 * runtime has it, the schema untrusted and every page's cells checked as
 * they are read. Requests run there one at a time, their statements in
 * order; a failure rejects with SQLite's own message.
 */
export class HistoryThread {
  private readonly worker = new Worker(HISTORY_THREAD, { eval: true });
  private waiting: { resolve(results: unknown[]): void; reject(error: Error): void } | undefined;
  private failure: unknown;
  private stopped: Error | undefined;

  constructor() {
    this.worker.on("message", (reply: Reply) => {
      const waiting = this.waiting;
      this.waiting = undefined;
      if ("error" in reply) waiting?.reject(new Error(reply.error));
      else waiting?.resolve(reply.results);
    });
    this.worker.on("error", (error) => (this.failure = error));
    this.worker.on("exit", (code) => {
      this.stopped = this.failure instanceof Error ? this.failure : new Error(`The history thread stopped (exit code ${code})`);
      this.waiting?.reject(this.stopped);
      this.waiting = undefined;
    });
  }

  /** The results of the request's statements, in order. */
  ask(request: HistoryRequest): Promise<unknown[]> {
    return this.post(request);
  }

  /** Closes the database and stops the thread. */
  async close(): Promise<void> {
    if (!this.stopped) {
      try {
        await this.post({ close: true });
      } catch {
        // Stopped anyway: the thread's end closes what it held.
      }
    }
    await this.worker.terminate();
  }

  private post(message: HistoryRequest | { close: true }): Promise<unknown[]> {
    if (this.stopped) return Promise.reject(this.stopped);
    if (this.waiting) return Promise.reject(new Error("The history thread is answering another request"));
    return new Promise<unknown[]>((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.worker.postMessage(message);
    });
  }
}

function exec(sql: string): HistoryOp {
  return { kind: "exec", sql };
}

function all(sql: string, ...params: SqlValue[]): HistoryOp {
  return { kind: "all", sql, params };
}

function get(sql: string, ...params: SqlValue[]): HistoryOp {
  return { kind: "get", sql, params };
}

function run(sql: string, ...params: SqlValue[]): HistoryOp {
  return { kind: "run", sql, params };
}

function each(sql: string, rows: SqlValue[][]): HistoryOp {
  return { kind: "each", sql, rows };
}

/** Visits every item on this thread, letting the rest of the extension host have a turn every few milliseconds. */
async function inTurns<T>(items: Iterable<T>, visit: (item: T) => void): Promise<void> {
  let since = performance.now();
  for (const item of items) {
    visit(item);
    if (performance.now() - since >= SLICE_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      since = performance.now();
    }
  }
}

// ---------------------------------------------------------------------------
// Checking

/**
 * Checks the backup's database (`schema`) before anything else is read from
 * it: each table merged is a plain table (a view or a virtual table in its
 * place runs what the backup says, and a generated column, which
 * `table_info` does not show, runs its expression on every read), no table
 * holds more rows than `limits`, and the file is whole. Their columns; or why
 * it is refused.
 */
async function vet(thread: HistoryThread, schema: "main" | "src", limits: HistoryLimits): Promise<{ columns: Record<Table, string[]> } | { failed: string }> {
  const names = TABLE_NAMES.map((table) => `'${table}'`).join(", ");
  const [listed, made, ...infos] = (await thread.ask({
    ops: [all(`PRAGMA ${schema}.table_list`), all(`SELECT name, sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name IN (${names})`), ...TABLE_NAMES.map((table) => all(`PRAGMA ${schema}.table_xinfo("${table}")`))],
  })) as Record<string, unknown>[][];
  const types = new Map(listed!.map((row) => [row.name, row.type]));
  const sql = new Map(made!.map((row) => [row.name, row.sql]));
  const columns = {} as Record<Table, string[]>;
  for (const [i, table] of TABLE_NAMES.entries()) {
    const info = infos[i]!;
    const create = sql.get(table);
    if (types.get(table) !== "table" || typeof create !== "string" || !PLAIN_TABLE.test(create)) return { failed: FOREIGN };
    if (info.length === 0 || info.some((column) => column.hidden !== 0)) return { failed: FOREIGN };
    columns[table] = info.map((column) => column.name).filter((name): name is string => typeof name === "string");
  }
  const counts = (await thread.ask({ ops: TABLE_NAMES.map((table) => get(`SELECT COUNT(*) AS n FROM ${schema}."${table}"`)) })) as { n: number }[];
  if (TABLE_NAMES.some((table, i) => counts[i]!.n > limits[table])) return { failed: TOO_LARGE };
  const [check] = (await thread.ask({ ops: [get(`PRAGMA ${schema}.quick_check(1)`)] })) as (Record<string, unknown> | undefined)[];
  if (check?.quick_check !== "ok") return { failed: DAMAGED };
  return { columns };
}

/** The limits to read with: the usual ones, or lower ones given; never higher, and never none. */
function limitsOf(options: HistoryReadOptions): HistoryLimits {
  const limits = { ...LIMITS };
  for (const table of TABLE_NAMES) {
    const lower = options.limits?.[table];
    if (typeof lower === "number" && Number.isFinite(lower)) limits[table] = Math.min(limits[table], lower);
  }
  return limits;
}

/** The files the backup holds the conversation of, in a table of the connection's own, keyed as text compares byte for byte. */
function heldFiles(schema: "main" | "src"): HistoryOp[] {
  return [exec("CREATE TEMP TABLE held(file TEXT PRIMARY KEY) WITHOUT ROWID"), run(`INSERT OR IGNORE INTO temp.held(file) SELECT file FROM ${schema}.files WHERE typeof(file) = 'text'`)];
}

// ---------------------------------------------------------------------------
// Reading

/**
 * The sessions of a backup's history database, from a copy of it on disk;
 * or why it cannot be read: no SQLite here, a damaged file, one too large,
 * or not the database Lookout writes.
 */
export async function readHistorySessions(copy: string, options: HistoryReadOptions = {}): Promise<{ sessions: HistorySession[] } | { failed: string }> {
  if (!loadSqlite()) return { failed: NO_SQLITE };
  let thread: HistoryThread | undefined;
  try {
    thread = new HistoryThread();
    await thread.ask({ open: { file: copy, readOnly: true }, ops: [] });
    const vetted = await vet(thread, "main", limitsOf(options));
    if ("failed" in vetted) return vetted;
    const columns = vetted.columns.sessions;
    if (!TABLES.sessions.every((column) => columns.includes(column)) || !vetted.columns.files.includes("file")) return { failed: FOREIGN };
    const purged = columns.includes("purged_at") ? "s.purged_at" : "NULL";
    const results = await thread.ask({
      ops: [...heldFiles("main"), all(`SELECT s.id AS id, s.agent AS agent, s.file AS file, s.cwd AS cwd, ${purged} AS purged_at, h.file IS NOT NULL AS held FROM main.sessions AS s LEFT JOIN temp.held AS h ON h.file = s.file COLLATE BINARY`)],
    });
    const sessions: HistorySession[] = [];
    for (const row of results[2] as Record<string, unknown>[]) {
      const id = text(row.id);
      const agent = text(row.agent);
      const file = text(row.file);
      const cwd = text(row.cwd);
      if (!id || !agent || !file || cwd === undefined) continue;
      const session: HistorySession = { id, agent, file, cwd, held: integer(row.held) === 1 };
      const purgedAt = integer(row.purged_at);
      if (purgedAt !== undefined) session.purgedAt = purgedAt;
      sessions.push(session);
    }
    return { sessions };
  } catch (error) {
    options.log?.(`${UNREADABLE}: ${messageOf(error)}`);
    return { failed: UNREADABLE };
  } finally {
    await thread?.close();
  }
}

// ---------------------------------------------------------------------------
// Merging

/** What to say when a step of the merge fails. */
const FAILED = {
  open: "the history database here could not be opened",
  read: UNREADABLE,
  copy: "this machine's history database could not be copied first",
  merge: "the history could not be merged",
} as const;

interface Chosen {
  /** The session's row in the backup, by column. */
  row: Record<string, unknown>;
  /** Its file in the backup. */
  from: string;
  place: HistoryPlace;
  purgedAt?: number;
}

/**
 * Adds to this machine's history (`storeFile`) the sessions of the backup's
 * (`copy`) that `choose` places, with their conversations: a session or a
 * file the database knows already is left as it is. One transaction, in a
 * thread of its own.
 */
export async function mergeHistory(copy: string, storeFile: string, options: MergeOptions): Promise<HistoryMerge> {
  const out: HistoryMerge = { added: 0, missing: [], extra: [] };
  if (!loadSqlite()) return { ...out, failed: NO_SQLITE };
  // Attaching a file that is not there would make an empty one.
  if (!fs.existsSync(copy)) return { ...out, failed: "the history could not be read out of the backup" };
  // Made, and brought up to this version, the way every window opens it.
  const store = ConversationStore.open(storeFile);
  if (!store) return { ...out, failed: FAILED.open };
  store.close();
  let thread: HistoryThread | undefined;
  let step: keyof typeof FAILED = "open";
  try {
    thread = new HistoryThread();
    await thread.ask({ open: { file: storeFile, readOnly: false, busyMs: BUSY_MS }, ops: [] });
    step = "read";
    await thread.ask({ ops: [run("ATTACH DATABASE ? AS src", copy)] });
    const vetted = await vet(thread, "src", limitsOf(options));
    if ("failed" in vetted) return { ...out, failed: vetted.failed };
    const infos = (await thread.ask({ ops: TABLE_NAMES.map((table) => all(`PRAGMA main.table_info("${table}")`)) })) as { name: unknown }[][];
    const here = {} as Record<Table, string[]>;
    const common = {} as Record<Table, string[]>;
    for (const [i, table] of TABLE_NAMES.entries()) {
      here[table] = infos[i]!.map((row) => row.name).filter((name): name is string => typeof name === "string");
      const there = new Set(vetted.columns[table]);
      for (const column of here[table]) if (!there.has(column)) out.missing.push(`${table}.${column}`);
      for (const column of there) if (!here[table].includes(column)) out.extra.push(`${table}.${column}`);
      if (!TABLES[table].every((column) => there.has(column))) return { ...out, failed: "the backup's history database is from a version too different to merge" };
      common[table] = here[table].filter((column) => there.has(column) && COLUMN.test(column));
    }
    // The backup's sessions it holds the conversation of, and this machine does not know.
    const sessionColumns = vetted.columns.sessions.filter((column) => COLUMN.test(column));
    const found = await thread.ask({
      ops: [
        ...heldFiles("src"),
        all(
          `SELECT ${quoted(sessionColumns, "s")} FROM src.sessions AS s CROSS JOIN temp.held AS h ON h.file = s.file COLLATE BINARY WHERE typeof(s.id) = 'text' AND typeof(s.file) = 'text' AND typeof(s.agent) = 'text' AND typeof(s.cwd) = 'text' AND NOT EXISTS (SELECT 1 FROM main.sessions AS m WHERE m.id = s.id COLLATE BINARY)`,
        ),
      ],
    });
    step = "merge";
    const chosen = await choose(found[2] as Record<string, unknown>[], options);
    if (chosen.length === 0) return out;
    // Each file to write, from the first session placed there, unless this machine knows it; and the paths its tool calls worked on.
    const picked = await thread.ask({
      ops: [
        exec("CREATE TEMP TABLE pick(dst TEXT PRIMARY KEY, src TEXT NOT NULL) WITHOUT ROWID; CREATE INDEX temp.pick_src ON pick(src); CREATE TEMP TABLE pathmap(src TEXT PRIMARY KEY, dst TEXT) WITHOUT ROWID"),
        each(
          "INSERT OR IGNORE INTO temp.pick(dst, src) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM main.files WHERE file = ?)",
          chosen.map((item) => [item.place.file, item.from, item.place.file]),
        ),
        run("INSERT OR IGNORE INTO temp.pathmap(src) SELECT sp.path FROM src.paths AS sp CROSS JOIN temp.pick AS p ON p.src = sp.file COLLATE BINARY WHERE typeof(sp.file) = 'text' AND typeof(sp.path) = 'text'"),
        all("SELECT src FROM temp.pathmap"),
        get("SELECT COUNT(*) AS n FROM temp.pick"),
        get("SELECT EXISTS (SELECT 1 FROM main.files) OR EXISTS (SELECT 1 FROM main.sessions) AS occupied"),
      ],
    });
    if ((picked[4] as { n: number }).n === 0) return out;
    const mapped: SqlValue[][] = [];
    await inTurns(picked[3] as { src: string }[], (row) => mapped.push([options.mapPathKey(row.src), row.src]));
    await thread.ask({ ops: [each("UPDATE temp.pathmap SET dst = ? WHERE src = ?", mapped)] });
    // A copy first, of a database that holds anything.
    if ((picked[5] as { occupied: number }).occupied) {
      const snapshot = options.snapshot();
      if (!snapshot) return { ...out, failed: FAILED.copy };
      step = "copy";
      await thread.ask({ ops: [run("VACUUM main INTO ?", snapshot)] });
      step = "merge";
    }
    const results = await thread.ask({ atomic: true, ops: inserts(chosen, common, here, options) });
    out.added = results[results.length - 1] as number;
    return out;
  } catch (error) {
    options.log?.(`${FAILED[step]}: ${messageOf(error)}`);
    return { ...out, added: 0, failed: FAILED[step] };
  } finally {
    await thread?.close();
  }
}

/** The backup's sessions to add, of those it holds and this machine does not know: placed by `choose`, the first of an id. */
async function choose(rows: readonly Record<string, unknown>[], options: MergeOptions): Promise<Chosen[]> {
  const out: Chosen[] = [];
  const ids = new Set<string>();
  await inTurns(rows, (row) => {
    const id = row.id as string;
    if (ids.has(id)) return;
    const from = row.file as string;
    const purgedAt = integer(row.purged_at);
    const session: HistorySession = { id, agent: row.agent as string, file: from, cwd: row.cwd as string, held: true };
    if (purgedAt !== undefined) session.purgedAt = purgedAt;
    const place = options.choose(session);
    if (!place) return;
    ids.add(id);
    out.push({ row, from, place, purgedAt });
  });
  return out;
}

/**
 * The statements that write the chosen sessions and their conversations,
 * for one transaction; the last one counts the sessions that went in. A file
 * this machine came to know since it was picked is left out, with its
 * sessions. Each backup table is read once, its rows matched to the picked
 * files through their index.
 */
function inserts(chosen: readonly Chosen[], common: Record<Table, string[]>, here: Record<Table, string[]>, options: MergeOptions): HistoryOp[] {
  const fileColumns = common.files.filter((column) => column !== "file" && column !== "tools");
  // The tool calls are not taken, so the file is marked read without them.
  const toolsFlag = here.files.includes("tools");
  const messageColumns = common.messages.filter((column) => column !== "file");
  const sessionColumns = common.sessions.filter((column) => column !== "file" && column !== "cwd" && column !== "purged_at");
  const purgedFlag = here.sessions.includes("purged_at");
  const insertColumns = [...sessionColumns, "file", "cwd", ...(purgedFlag ? ["purged_at"] : [])];
  const sessions = chosen.map((item) => {
    const values = sessionColumns.map((column) => sqlValue(column, item.row[column]));
    values.push(item.place.file, item.place.cwd);
    if (purgedFlag) values.push(item.purgedAt ?? options.now);
    return [...values, item.row.id as string, item.place.file];
  });
  return [
    run("DELETE FROM temp.pick WHERE EXISTS (SELECT 1 FROM main.files AS f WHERE f.file = temp.pick.dst)"),
    run(
      `INSERT INTO main.files("file", ${quoted(fileColumns)}${toolsFlag ? `, "tools"` : ""}) SELECT p.dst, ${quoted(fileColumns, "f")}${toolsFlag ? ", 0" : ""} FROM src.files AS f CROSS JOIN temp.pick AS p ON p.src = f.file COLLATE BINARY WHERE typeof(f.file) = 'text'`,
    ),
    run(
      `INSERT OR IGNORE INTO main.messages("file", ${quoted(messageColumns)}) SELECT p.dst, ${quoted(messageColumns, "m")} FROM src.messages AS m CROSS JOIN temp.pick AS p ON p.src = m.file COLLATE BINARY WHERE typeof(m.file) = 'text' AND typeof(m.idx) = 'integer' AND typeof(m.text) = 'text' AND m.role COLLATE BINARY IN ('you', 'agent')`,
    ),
    run(
      `INSERT OR IGNORE INTO main.paths("file", "path") SELECT p.dst, pm.dst FROM src.paths AS sp CROSS JOIN temp.pick AS p ON p.src = sp.file COLLATE BINARY CROSS JOIN temp.pathmap AS pm ON pm.src = sp.path COLLATE BINARY WHERE typeof(sp.file) = 'text' AND typeof(sp.path) = 'text' AND typeof(pm.dst) = 'text'`,
    ),
    each(`INSERT INTO main.sessions(${quoted(insertColumns)}) SELECT ${insertColumns.map(() => "?").join(", ")} WHERE NOT EXISTS (SELECT 1 FROM main.sessions WHERE id = ?) AND EXISTS (SELECT 1 FROM temp.pick WHERE dst = ?)`, sessions),
  ];
}

/** A session's value as this version keeps it: text where text belongs, a number or nothing where a time does. */
function sqlValue(column: string, value: unknown): string | number | null {
  if (column === "modified_at") return integer(value) ?? null;
  if (column === "branch") return text(value) ?? null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return column === "title" ? "" : null;
}
