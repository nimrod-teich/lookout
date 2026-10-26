// Node's own sqlite (`node:sqlite`, Node 22.5 and later): for reading the
// databases VS Code keeps, and for Lookout's own store of the conversations;
// nothing on older runtimes.
import { createRequire } from "node:module";
import * as path from "node:path";

export interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

export interface Sqlite {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => Database;
}

/** Node's sqlite, or undefined where the runtime has none. */
export function loadSqlite(): Sqlite | undefined {
  try {
    return createRequire(path.join(process.cwd(), "lookout.js"))("node:sqlite") as Sqlite;
  } catch {
    return undefined;
  }
}
