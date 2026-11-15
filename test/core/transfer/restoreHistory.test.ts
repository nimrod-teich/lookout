import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSqlite } from "../../../src/core/sqlite";
import { ConversationStore } from "../../../src/core/store";
import { HistoryThread, mergeHistory, readHistorySessions, type HistoryLimits, type HistoryOp, type MergeOptions } from "../../../src/core/transfer/restoreHistory";
import { sessionId, tempConfigDir } from "../helpers";
import { historyBytes, type HistoryRow } from "./fakeBundle";

// Key derivation, compression and SQLite at real sizes: slower runners need more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const sqlite = loadSqlite();
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
/** A collation name that VS Code would show as a link running a command, were it put in a notification. */
const CRAFTED = "[Fix the history](command:workbench.action.reloadWindow)";

const FOREIGN = "the backup's history database is not one Lookout writes";
const TOO_LARGE = "the backup's history database is too large to restore";
const UNREADABLE = "the backup's history database could not be read";

function fileOf(id: string, cwd = "/home/alice/proj"): string {
  return `/home/alice/.claude/projects/${cwd.replace(/\//g, "-")}/${id}.jsonl`;
}

function rows(n: number): HistoryRow[] {
  return Array.from({ length: n }, (_, i) => {
    const id = sessionId(i + 1);
    return { id, agent: "claude-code", file: fileOf(id), cwd: "/home/alice/proj", messages: [`question ${i}`, `answer ${i}`], paths: [`/home/alice/proj/src/file${i}.ts`] };
  });
}

/** The backup's history as the restore copies it out of the file. */
function copyOf(dir: string, bytes: Buffer): string {
  const file = path.join(dir, `backup-${Math.random().toString(16).slice(2)}.sqlite`);
  fs.writeFileSync(file, bytes);
  return file;
}

/** Merge options that place every session under `/here`, and keep what they log. */
function options(dir: string, over: Partial<MergeOptions> = {}): MergeOptions & { logged: string[] } {
  const logged: string[] = [];
  return {
    choose: (session) => ({ file: `/here${session.file}`, cwd: `/here${session.cwd}` }),
    mapPathKey: (key) => key.replace(/^\/home\/alice\//, "/here/alice/"),
    snapshot: () => path.join(dir, `before-${Math.random().toString(16).slice(2)}.sqlite`),
    now: NOW,
    log: (message) => logged.push(message),
    ...over,
    logged,
  };
}

function storeIn(dir: string): string {
  return path.join(dir, "storage", "history.sqlite");
}

/**
 * A backup's history of `n` sessions, each with two messages and a path,
 * written at once. `lookout` makes the tables as Lookout does; `bare` as a
 * crafted file can: plain tables without keys, their file columns compared
 * case-blind, so no index of the backup's own serves a lookup by file.
 */
function bulk(dir: string, n: number, schema: "lookout" | "bare"): string {
  const file = path.join(dir, `bulk-${schema}-${n}.sqlite`);
  if (schema === "lookout") ConversationStore.open(file)!.close();
  const db = new sqlite!.DatabaseSync(file);
  if (schema === "bare") {
    db.exec(`
      CREATE TABLE files(file TEXT COLLATE NOCASE, reader TEXT, identity TEXT, end INTEGER, tail TEXT, messages INTEGER, build TEXT, tools INTEGER);
      CREATE TABLE messages(file TEXT COLLATE NOCASE, idx INTEGER, role TEXT COLLATE NOCASE, at INTEGER, text TEXT);
      CREATE TABLE paths(file TEXT COLLATE NOCASE, path TEXT COLLATE NOCASE);
      CREATE TABLE sessions(id TEXT COLLATE NOCASE, agent TEXT, file TEXT COLLATE NOCASE, title TEXT, cwd TEXT, branch TEXT, modified_at INTEGER, purged_at INTEGER);
    `);
  }
  db.exec(`
    CREATE TEMP TABLE n AS WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${n}) SELECT i, printf('00000000-0000-4000-8000-%012d', i) AS id FROM c;
    BEGIN;
    INSERT INTO files(file, reader, identity, end, tail, messages, build, tools) SELECT '/home/alice/proj/' || id || '.jsonl', 'claude-transcript', 'ident', 100, NULL, 2, 'build-1', 1 FROM temp.n;
    INSERT INTO messages(file, idx, role, at, text) SELECT '/home/alice/proj/' || id || '.jsonl', k, CASE k WHEN 0 THEN 'you' ELSE 'agent' END, 1000 + k, 'message ' || k || ' of session ' || i FROM temp.n, (SELECT 0 AS k UNION ALL SELECT 1);
    INSERT INTO paths(file, path) SELECT '/home/alice/proj/' || id || '.jsonl', '/home/alice/proj/src/file' || i || '.ts' FROM temp.n;
    INSERT INTO sessions(id, agent, file, title, cwd, branch, modified_at, purged_at) SELECT id, 'claude-code', '/home/alice/proj/' || id || '.jsonl', 'Session ' || i, '/home/alice/proj', NULL, 5000, NULL FROM temp.n;
    COMMIT;
    PRAGMA journal_mode = DELETE;
  `);
  db.close();
  return file;
}

function rowsOf(file: string, sql: string, ...params: (string | number)[]): Record<string, unknown>[] {
  const db = new sqlite!.DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

async function until(ready: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe.skipIf(!sqlite)("reading a backup's history", () => {
  it("reads the sessions, and which ones the backup holds the conversation of", async () => {
    const dir = tempConfigDir();
    const [one, two] = rows(2) as [HistoryRow, HistoryRow];
    const copy = copyOf(dir, historyBytes(dir, [one, { ...two, purgedAt: NOW - 5 }], undefined, `DELETE FROM files WHERE file = '${two.file}'`));
    expect(await readHistorySessions(copy)).toEqual({
      sessions: [
        { id: one.id, agent: "claude-code", file: one.file, cwd: one.cwd, held: true },
        { id: two.id, agent: "claude-code", file: two.file, cwd: two.cwd, purgedAt: NOW - 5, held: false },
      ],
    });
  });

  it("refuses a virtual table where a table is read, and reads the plain one", async () => {
    const dir = tempConfigDir();
    // The table as SQLite lists it is a "table" either way; only the statement that made it tells them apart.
    const virtual = copyOf(dir, historyBytes(dir, rows(3), undefined, "ALTER TABLE files RENAME TO plain_files; CREATE VIRTUAL TABLE files USING fts5(file, reader, identity, end, build); INSERT INTO files SELECT file, reader, identity, end, build FROM plain_files; DROP TABLE plain_files"));
    expect(rowsOf(virtual, "SELECT type, sql FROM sqlite_master WHERE name = 'files'")).toEqual([{ type: "table", sql: "CREATE VIRTUAL TABLE files USING fts5(file, reader, identity, end, build)" }]);
    expect(await readHistorySessions(virtual)).toEqual({ failed: FOREIGN });
    expect(await mergeHistory(virtual, storeIn(dir), options(dir))).toEqual({ added: 0, missing: [], extra: [], failed: FOREIGN });

    const plain = copyOf(dir, historyBytes(dir, rows(3)));
    expect((await readHistorySessions(plain)) as { sessions: unknown[] }).toMatchObject({ sessions: { length: 3 } });
    expect(await mergeHistory(plain, storeIn(dir), options(dir))).toEqual({ added: 3, missing: [], extra: [] });
  });

  it.each([
    ["a virtual generated column of sessions", "ALTER TABLE sessions ADD COLUMN slow TEXT GENERATED ALWAYS AS (upper(title)) VIRTUAL", "sessions"],
    [
      "a stored generated column of paths",
      "ALTER TABLE paths RENAME TO old_paths; CREATE TABLE paths(file TEXT NOT NULL, path TEXT NOT NULL, loud TEXT GENERATED ALWAYS AS (upper(path)) STORED, PRIMARY KEY (file, path)); INSERT INTO paths(file, path) SELECT file, path FROM old_paths; DROP TABLE old_paths",
      "paths",
    ],
  ])("refuses %s, which table_info does not show, and reads the table without it", async (_what, craft, table) => {
    const dir = tempConfigDir();
    const generated = copyOf(dir, historyBytes(dir, rows(2), undefined, craft));
    // Invisible to the pragma the columns used to be read with.
    expect(rowsOf(generated, `PRAGMA table_info(${table})`).map((column) => column.name)).not.toContain(table === "sessions" ? "slow" : "loud");
    expect(await readHistorySessions(generated)).toEqual({ failed: FOREIGN });
    expect(await mergeHistory(generated, storeIn(dir), options(dir))).toEqual({ added: 0, missing: [], extra: [], failed: FOREIGN });

    const plain = copyOf(dir, historyBytes(dir, rows(2)));
    expect((await readHistorySessions(plain)) as { sessions: unknown[] }).toMatchObject({ sessions: { length: 2 } });
    expect(await mergeHistory(plain, storeIn(dir), options(dir))).toEqual({ added: 2, missing: [], extra: [] });
  });

  it.each([
    ["sessions", 3],
    ["files", 3],
    ["messages", 6],
    ["paths", 3],
  ] as const)("refuses a history with more %s rows than the limit, plainly, and reads one at the limit", async (table, count) => {
    const dir = tempConfigDir();
    const copy = copyOf(dir, historyBytes(dir, rows(3)));
    const over: Partial<HistoryLimits> = { [table]: count - 1 };
    expect(await readHistorySessions(copy, { limits: over })).toEqual({ failed: TOO_LARGE });
    expect(await mergeHistory(copy, storeIn(dir), options(dir, { limits: over }))).toEqual({ added: 0, missing: [], extra: [], failed: TOO_LARGE });

    const at: Partial<HistoryLimits> = { [table]: count };
    expect((await readHistorySessions(copy, { limits: at })) as { sessions: unknown[] }).toMatchObject({ sessions: { length: 3 } });
    expect(await mergeHistory(copy, storeIn(dir), options(dir, { limits: at }))).toEqual({ added: 3, missing: [], extra: [] });
  });

  it("refuses more than 500,000 sessions without being told a limit", async () => {
    const dir = tempConfigDir();
    const copy = path.join(dir, "many.sqlite");
    ConversationStore.open(copy)!.close();
    const db = new sqlite!.DatabaseSync(copy);
    db.exec(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i <= 500000) INSERT INTO sessions(id, agent, file, title, cwd) SELECT i, 'a', 'f', '', '/' FROM c; PRAGMA journal_mode = DELETE`);
    db.close();
    expect(await readHistorySessions(copy)).toEqual({ failed: TOO_LARGE });
    // Limits given only ever lower it.
    expect(await readHistorySessions(copy, { limits: { sessions: 1_000_000 } })).toEqual({ failed: TOO_LARGE });
    expect(await readHistorySessions(copy, { limits: { sessions: Number.NaN } })).toEqual({ failed: TOO_LARGE });
    expect(await readHistorySessions(copy, { limits: { sessions: undefined } })).toEqual({ failed: TOO_LARGE });
  }, 30_000);

  it("says only a fixed message when SQLite's words carry the backup's own, and gives those words to the log", async () => {
    const dir = tempConfigDir();
    // A collation no SQLite has, named as a link: every lookup through the file column's index fails, saying its name.
    const crafted = copyOf(dir, historyBytes(dir, rows(2), undefined, `PRAGMA writable_schema = ON; UPDATE sqlite_master SET sql = replace(sql, 'file TEXT PRIMARY KEY', 'file TEXT COLLATE "${CRAFTED}" PRIMARY KEY') WHERE name = 'files'; PRAGMA writable_schema = OFF`));
    const logged: string[] = [];
    expect(await readHistorySessions(crafted, { log: (message) => logged.push(message) })).toEqual({ failed: UNREADABLE });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(CRAFTED);
    const merging = options(dir);
    const merged = await mergeHistory(crafted, storeIn(dir), merging);
    expect(merged).toEqual({ added: 0, missing: [], extra: [], failed: UNREADABLE });
    expect(merging.logged).toHaveLength(1);
    expect(merging.logged[0]).toContain(CRAFTED);
    // Without a log, the words go nowhere.
    expect(await readHistorySessions(crafted)).toEqual({ failed: UNREADABLE });

    // A damaged file is refused in the same plain words, or as damaged.
    const bytes = historyBytes(dir, rows(20));
    bytes.fill(0xff, 2 * 4096 + 16, 3 * 4096);
    const damaged = await readHistorySessions(copyOf(dir, bytes));
    expect(["the backup's history database is damaged", UNREADABLE]).toContain((damaged as { failed: string }).failed);

    // A history that reads well logs nothing.
    const plain = options(dir);
    expect(await mergeHistory(copyOf(dir, historyBytes(dir, rows(2))), storeIn(tempConfigDir()), plain)).toEqual({ added: 2, missing: [], extra: [] });
    expect(plain.logged).toEqual([]);
  });

  it("opens the database with extensions off, the schema untrusted, every page's cells checked and the defensive flag on", async () => {
    const dir = tempConfigDir();
    const file = path.join(dir, "plain.sqlite");
    const made = new sqlite!.DatabaseSync(file);
    made.exec("CREATE TABLE t(a)");
    made.close();
    const get = (sql: string): HistoryOp => ({ kind: "get", sql, params: [] });
    const thread = new HistoryThread();
    try {
      expect(await thread.ask({ open: { file, readOnly: false }, ops: [get("PRAGMA trusted_schema"), get("PRAGMA cell_size_check")] })).toEqual([{ trusted_schema: 0 }, { cell_size_check: 1 }]);
      await expect(thread.ask({ ops: [get("SELECT load_extension('nothing')")] })).rejects.toThrow(/not authorized/);
      // The runtime has the flag where `enableDefensive` is there: no SQL then writes the schema table, writable_schema or not.
      if ("enableDefensive" in sqlite!.DatabaseSync.prototype) {
        await expect(thread.ask({ ops: [{ kind: "exec", sql: "PRAGMA writable_schema = ON" }, { kind: "run", sql: "UPDATE sqlite_master SET sql = sql", params: [] }] })).rejects.toThrow(/may not be modified/);
      }
    } finally {
      await thread.close();
    }
    // A connection opened the runtime's default way allows all of it.
    const plain = new sqlite!.DatabaseSync(file);
    expect(plain.prepare("PRAGMA trusted_schema").get()).toEqual({ trusted_schema: 1 });
    plain.exec("PRAGMA writable_schema = ON");
    plain.exec("UPDATE sqlite_master SET sql = sql");
    plain.close();
  });
});

describe.skipIf(!sqlite)("merging a backup's history", () => {
  it("adds the chosen sessions with their conversations and paths mapped, and leaves what this machine knows as it is", async () => {
    const dir = tempConfigDir();
    const [s1, s2, s3, s4, s5, s6, s7] = rows(7) as [HistoryRow, HistoryRow, HistoryRow, HistoryRow, HistoryRow, HistoryRow, HistoryRow];
    // s2 this machine knows; s3's file it knows; s4 is not placed; s6 goes where s5 goes; s7's conversation is not in the backup.
    const copy = copyOf(dir, historyBytes(dir, [s1, { ...s2, purgedAt: NOW - 9 }, s3, s4, s5, s6, s7], undefined, `DELETE FROM files WHERE file = '${s7.file}'`));
    const storeFile = storeIn(dir);
    const live = ConversationStore.open(storeFile)!;
    live.rememberSession({ id: s2.id, agent: "claude-code", file: "/here/known.jsonl", title: "Known", cwd: "/here" });
    live.close();
    const db = new sqlite!.DatabaseSync(storeFile);
    db.prepare("INSERT INTO files(file, reader, identity, end, tail, messages, build, tools) VALUES (?, 'claude-transcript', 'mine', 1, NULL, 0, 'b', 1)").run(`/here${s3.file}`);
    db.close();
    const merging = options(dir, {
      choose: (session) => (session.id === s4.id ? undefined : { file: `/here${(session.id === s6.id ? s5 : session).file}`, cwd: "/here/alice/proj" }),
    });
    let snapshot: string | undefined;
    const result = await mergeHistory(copy, storeFile, { ...merging, snapshot: () => (snapshot = merging.snapshot()) });
    expect(result).toEqual({ added: 3, missing: [], extra: [] });
    expect(merging.logged).toEqual([]);

    const store = ConversationStore.open(storeFile)!;
    try {
      expect(store.session(s1.id)).toEqual({ id: s1.id, agent: "claude-code", file: `/here${s1.file}`, title: `Session ${s1.id.slice(-4)}`, cwd: "/here/alice/proj", modifiedAt: 5000, purgedAt: NOW });
      expect(store.messages(`/here${s1.file}`)?.map((message) => [message.role, message.text])).toEqual([
        ["you", "question 0"],
        ["agent", "answer 0"],
      ]);
      expect(store.progress(`/here${s1.file}`)).toMatchObject({ identity: "ident", tools: false });
      expect(store.search([`/here${s1.file}`], ["question"], 3).get(`/here${s1.file}`)?.count).toBe(1);
      expect(store.session(s2.id)).toMatchObject({ title: "Known", file: "/here/known.jsonl" });
      expect(store.session(s3.id)).toBeUndefined();
      expect(store.progress(`/here${s3.file}`)).toMatchObject({ identity: "mine" });
      expect(store.session(s4.id)).toBeUndefined();
      expect(store.session(s5.id)?.file).toBe(`/here${s5.file}`);
      expect(store.session(s6.id)?.file).toBe(`/here${s5.file}`);
      expect(store.messages(`/here${s5.file}`)?.map((message) => message.text)).toEqual(["question 4", "answer 4"]);
      expect(store.session(s7.id)).toBeUndefined();
    } finally {
      store.close();
    }
    expect(rowsOf(storeFile, "SELECT file, path FROM paths ORDER BY file")).toEqual([
      { file: `/here${s1.file}`, path: "/here/alice/proj/src/file0.ts" },
      { file: `/here${s5.file}`, path: "/here/alice/proj/src/file4.ts" },
    ]);
    // This machine's database was copied first, as it was.
    expect(rowsOf(snapshot!, "SELECT id FROM sessions")).toEqual([{ id: s2.id }]);
  });

  it("matches rows to sessions through indexes of its own, whatever the backup's tables are keyed by", async () => {
    const dir = tempConfigDir();
    // Without keys, looking up each session's file, messages and paths in these tables is a scan each: billions of rows, minutes rather than seconds.
    const copy = bulk(dir, 20_000, "bare");
    const started = performance.now();
    const read = await readHistorySessions(copy);
    expect((read as { sessions: { held: boolean }[] }).sessions.filter((session) => session.held)).toHaveLength(20_000);
    const result = await mergeHistory(copy, storeIn(dir), options(dir));
    const elapsed = performance.now() - started;
    expect(result).toEqual({ added: 20_000, missing: [], extra: [] });
    expect(rowsOf(storeIn(dir), "SELECT COUNT(*) AS n FROM messages")).toEqual([{ n: 40_000 }]);
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);

  it("works off the extension host's thread: a timer goes on ticking, and another window's write lock is waited out", async () => {
    const dir = tempConfigDir();
    const copy = bulk(dir, 5_000, "lookout");
    const storeFile = storeIn(dir);
    const live = ConversationStore.open(storeFile)!;
    live.rememberSession({ id: sessionId(999_999), agent: "claude-code", file: "/here/elsewhere.jsonl", title: "Here", cwd: "/here" });
    live.close();
    // Another window, in the middle of a write: the merge waits for it, and only a thread that is free lets go of it.
    const other = new sqlite!.DatabaseSync(storeFile);
    other.exec("BEGIN IMMEDIATE");
    other.exec("INSERT INTO paths(file, path) VALUES ('/here/elsewhere.jsonl', '/here/x')");
    const snapshot = path.join(dir, "before.sqlite");
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const merging = mergeHistory(copy, storeFile, options(dir, { snapshot: () => snapshot }));
      // The copy of this machine's database comes before the write.
      await until(() => fs.existsSync(snapshot));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const whileLocked = ticks;
      other.exec("COMMIT");
      const result = await merging;
      expect(result).toEqual({ added: 5_000, missing: [], extra: [] });
      expect(whileLocked).toBeGreaterThan(10);
    } finally {
      clearInterval(timer);
      other.close();
    }
    expect(rowsOf(storeFile, "SELECT COUNT(*) AS n FROM sessions")).toEqual([{ n: 5_001 }]);
    expect(rowsOf(storeFile, "SELECT COUNT(*) AS n FROM paths")).toEqual([{ n: 5_001 }]);
  }, 30_000);
});
