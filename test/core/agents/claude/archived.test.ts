import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ArchivedSessions, stateDbCandidates } from "../../../../src/core/agents/claude/archived";
import { tempConfigDir } from "../../helpers";

interface Sqlite {
  DatabaseSync: new (file: string) => { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): unknown }; close(): void };
}

function sqlite(): Sqlite | undefined {
  try {
    return createRequire(__filename)("node:sqlite") as Sqlite;
  } catch {
    return undefined;
  }
}

/** Writes a VS Code state database holding the extension's state under `key`. */
function writeStateDb(file: string, key: string, state: unknown): void {
  const { DatabaseSync } = sqlite()!;
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(key, JSON.stringify(state));
  db.close();
}

describe("stateDbCandidates", () => {
  it("looks next to the extension's storage, and under WSL at every Windows user's VS Code too", () => {
    const root = tempConfigDir();
    const local = path.join(root, "globalStorage");
    fs.mkdirSync(local);
    fs.writeFileSync(path.join(local, "state.vscdb"), "");
    const mounts = path.join(root, "mnt");
    const windows = path.join(mounts, "c", "Users", "nimrod", "AppData", "Roaming", "Code - Insiders", "User", "globalStorage");
    fs.mkdirSync(windows, { recursive: true });
    fs.writeFileSync(path.join(windows, "state.vscdb"), "");
    fs.mkdirSync(path.join(mounts, "c", "Users", "other", "AppData", "Roaming", "Codex"), { recursive: true });
    expect(stateDbCandidates(local, "linux", mounts)).toEqual([path.join(local, "state.vscdb"), path.join(windows, "state.vscdb")]);
    expect(stateDbCandidates(local, "darwin", mounts)).toEqual([path.join(local, "state.vscdb")]);
    expect(stateDbCandidates(path.join(root, "missing"), "win32", mounts)).toEqual([]);
  });
});

describe("ArchivedSessions", () => {
  it("reads the archived ids from the first database that holds the extension's state, whatever the key's case", () => {
    if (!sqlite()) return;
    const root = tempConfigDir();
    const without = path.join(root, "without.vscdb");
    const withIds = path.join(root, "with.vscdb");
    writeStateDb(without, "some.other-extension", { hiddenSessionIds: ["nope"] });
    writeStateDb(withIds, "Anthropic.claude-code", { hiddenSessionIds: ["a", 7, "b"], other: true });
    const archived = new ArchivedSessions([without, withIds]);
    expect(archived.available).toBe(true);
    expect([...archived.read()]).toEqual(["a", "b"]);
    // Read again only when the database changed.
    fs.rmSync(withIds);
    expect([...archived.read()]).toEqual(["a", "b"]);
  });

  it("gives an empty set when no database can be read", () => {
    const root = tempConfigDir();
    const broken = path.join(root, "broken.vscdb");
    fs.writeFileSync(broken, "not a database");
    expect(new ArchivedSessions([broken, path.join(root, "missing.vscdb")]).read().size).toBe(0);
    expect(new ArchivedSessions([]).available).toBe(false);
  });
});
