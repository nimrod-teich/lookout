import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { chatStorageRoots } from "../../../src/core/agents/copilot/localChats";
import { cleanTitle, folderKey, openTabs, panelTabsOf, pendingFor, readPanelTabs, readPending, stateDbsFor, TabClaims, withoutTabs } from "../../../src/core/transfer/tabs";
import type { PendingTab } from "../../../src/core/transfer/types";
import { tempConfigDir } from "../helpers";

interface Db {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}

interface Sqlite {
  DatabaseSync: new (file: string) => Db;
}

function sqlite(): Sqlite | undefined {
  try {
    return createRequire(__filename)("node:sqlite") as Sqlite;
  } catch {
    return undefined;
  }
}

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const D = "00000000-0000-4000-8000-00000000000d";

/** Writes a VS Code state database the way VS Code does, with other extensions' state beside `value` under `key`. */
function writeStateDb(file: string, key: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (sqlite()!.DatabaseSync)(file);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("workbench.view.extension.claude-sidebar.state", '{"collapsed":false}');
  if (value !== undefined) db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(key, typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value));
  db.close();
}

/** The Claude Code extension's workspace state with these tabs open. */
function claudeState(tabs: { sessionId: unknown; title?: unknown; fullEditor?: boolean }[]) {
  return { panelSessionIds: [], panelTabSessions: tabs, storedStartupConfig: {} };
}

function pending(overrides: Partial<PendingTab> = {}): PendingTab {
  return { sessionId: A, title: "Wire the cache", cwd: "/work/app", from: "laptop", madeAt: 1_700_000_000_000, ...overrides };
}

describe("panelTabsOf", () => {
  it("lists the tabs in the extension's order, keeping each session once and dropping entries without a session id", () => {
    const state = claudeState([
      { sessionId: A, title: "Wire the cache", fullEditor: false },
      { sessionId: "not-a-uuid", title: "Bad" },
      { sessionId: "../../etc/passwd", title: "Worse" },
      { sessionId: 7, title: "Number" },
      { sessionId: B, title: "Fix the build" },
      { sessionId: A.toUpperCase(), title: "Again" },
    ]);
    expect(panelTabsOf(state)).toEqual([
      { sessionId: A, title: "Wire the cache" },
      { sessionId: B, title: "Fix the build" },
    ]);
    expect(panelTabsOf({ panelTabSessions: [null, 3, "x", { title: "no id" }] })).toEqual([]);
    expect(panelTabsOf({ panelTabSessions: "nope" })).toEqual([]);
    expect(panelTabsOf({})).toEqual([]);
    expect(panelTabsOf(null)).toEqual([]);
  });

  it("keeps a tab whose title is missing or odd, with a title fit to show", () => {
    expect(panelTabsOf(claudeState([{ sessionId: A }, { sessionId: B, title: { text: "x" } }, { sessionId: C, title: "a\u0000b\u202ec\nd\te" }]))).toEqual([
      { sessionId: A, title: "" },
      { sessionId: B, title: "" },
      { sessionId: C, title: "a b c d e" },
    ]);
  });
});

describe("cleanTitle", () => {
  it("puts a title on one line without control characters, and cuts a long one", () => {
    expect(cleanTitle("  Fix\r\nthe\u2028build  ")).toBe("Fix the build");
    expect(cleanTitle("ok \u2066tricky\u2069")).toBe("ok tricky");
    const long = cleanTitle("é".repeat(500));
    expect(Array.from(long)).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
    expect(cleanTitle(undefined)).toBe("");
  });
});

describe("readPanelTabs", () => {
  it("reads the tabs from a state database, whatever the key's case, and leaves the file as it was", () => {
    if (!sqlite()) return;
    const dir = tempConfigDir();
    const file = path.join(dir, "ws", "state.vscdb");
    writeStateDb(file, "Anthropic.claude-code", claudeState([{ sessionId: A, title: "Wire the cache…", fullEditor: false }, { sessionId: B, title: "Fix the build" }]));
    const before = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;
    expect(readPanelTabs(file)).toEqual([
      { sessionId: A, title: "Wire the cache…" },
      { sessionId: B, title: "Fix the build" },
    ]);
    // Read-only: no journal, no change.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["state.vscdb"]);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it("reads a value stored as bytes", () => {
    if (!sqlite()) return;
    const file = path.join(tempConfigDir(), "state.vscdb");
    writeStateDb(file, "anthropic.claude-code", new TextEncoder().encode(JSON.stringify(claudeState([{ sessionId: A, title: "Bytes" }]))));
    expect(readPanelTabs(file)).toEqual([{ sessionId: A, title: "Bytes" }]);
  });

  it("tells a database without the extension's state from one with no tab open", () => {
    if (!sqlite()) return;
    const dir = tempConfigDir();
    const without = path.join(dir, "without.vscdb");
    const empty = path.join(dir, "empty.vscdb");
    const torn = path.join(dir, "torn.vscdb");
    writeStateDb(without, "Anthropic.claude-code", undefined);
    writeStateDb(empty, "Anthropic.claude-code", claudeState([]));
    writeStateDb(torn, "Anthropic.claude-code", "{not json");
    expect(readPanelTabs(without)).toBeUndefined();
    expect(readPanelTabs(empty)).toEqual([]);
    expect(readPanelTabs(torn)).toBeUndefined();
  });

  it("gives undefined for a file that is not a database, or is missing", () => {
    const dir = tempConfigDir();
    const temp = path.join(dir, "temp");
    fs.mkdirSync(temp);
    fs.writeFileSync(path.join(dir, "broken.vscdb"), "not a database at all, but long enough to look like one".repeat(10));
    expect(readPanelTabs(path.join(dir, "broken.vscdb"), { tempDir: temp })).toBeUndefined();
    expect(readPanelTabs(path.join(dir, "missing.vscdb"), { tempDir: temp })).toBeUndefined();
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  it("reads a copy of a database VS Code holds locked, and removes the copy", () => {
    const node = sqlite();
    if (!node) return;
    const dir = tempConfigDir();
    const file = path.join(dir, "ws", "state.vscdb");
    const temp = path.join(dir, "temp");
    fs.mkdirSync(temp);
    writeStateDb(file, "Anthropic.claude-code", claudeState([{ sessionId: A, title: "Locked" }]));
    // VS Code in the middle of a write: an exclusive lock keeps every reader out of the file itself.
    const writer = new node.DatabaseSync(file);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      expect(readPanelTabs(file, { tempDir: temp })).toEqual([{ sessionId: A, title: "Locked" }]);
      expect(fs.readdirSync(temp)).toEqual([]);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});

describe("stateDbsFor", () => {
  it("finds a window's database under every storage folder, by its id and, for an id an extension host suffixed, by the plain one", () => {
    if (!sqlite()) return;
    const dir = tempConfigDir();
    const remote = path.join(dir, "remote", "workspaceStorage");
    const windows = path.join(dir, "windows", "workspaceStorage");
    // The extension host's own folder holds no state database, only extensions' folders.
    fs.mkdirSync(path.join(remote, "abc123-1", "some.extension"), { recursive: true });
    writeStateDb(path.join(windows, "abc123", "state.vscdb"), "x", {});
    expect(stateDbsFor("abc123-1", [remote, windows])).toEqual([path.join(windows, "abc123", "state.vscdb")]);
    expect(stateDbsFor("abc123", [remote, windows])).toEqual([path.join(windows, "abc123", "state.vscdb")]);
    expect(stateDbsFor("other", [remote, windows])).toEqual([]);
  });

  it("puts the most recently written first, and joins no odd id to a path", () => {
    if (!sqlite()) return;
    const dir = tempConfigDir();
    const code = path.join(dir, "Code", "workspaceStorage");
    const insiders = path.join(dir, "Insiders", "workspaceStorage");
    writeStateDb(path.join(code, "abc", "state.vscdb"), "x", {});
    writeStateDb(path.join(insiders, "abc", "state.vscdb"), "x", {});
    fs.utimesSync(path.join(code, "abc", "state.vscdb"), new Date(1_000_000), new Date(1_000_000));
    expect(stateDbsFor("abc", [code, insiders])).toEqual([path.join(insiders, "abc", "state.vscdb"), path.join(code, "abc", "state.vscdb")]);
    fs.writeFileSync(path.join(dir, "state.vscdb"), "");
    for (const id of ["..", ".", "../Code", "a/b", "-1", "", "a b"]) expect(stateDbsFor(id, [code]), id).toEqual([]);
  });
});

describe("openTabs", () => {
  it("lists each window's Claude tabs, from its own state database, this window first", async () => {
    if (!sqlite()) return;
    const dir = tempConfigDir();
    const remote = path.join(dir, "remote", "workspaceStorage");
    const windows = path.join(dir, "windows", "workspaceStorage");
    fs.mkdirSync(path.join(remote, "self-1"), { recursive: true });
    writeStateDb(path.join(windows, "self", "state.vscdb"), "Anthropic.claude-code", claudeState([{ sessionId: A, title: "Wire the cache" }, { sessionId: B, title: "Fix the build" }]));
    writeStateDb(path.join(remote, "api", "state.vscdb"), "Anthropic.claude-code", claudeState([{ sessionId: C, title: "Add the route" }, { sessionId: A, title: "Wire the cache" }]));
    writeStateDb(path.join(windows, "notes", "state.vscdb"), "Anthropic.claude-code", claudeState([]));
    writeStateDb(path.join(windows, "docs", "state.vscdb"), "Some.other-extension", { panelTabSessions: [{ sessionId: D, title: "Not Claude" }] });
    const tabs = await openTabs(
      [
        { label: "app", folders: ["/work/app", "/work/lib"], storageId: "self-1" },
        { label: "api", folders: ["/work/api"], storageId: "api" },
        { label: "notes", folders: ["/work/notes"], storageId: "notes" },
        { label: "docs", folders: ["/work/docs"], storageId: "docs" },
        { label: "empty window" },
        { label: "odd", folders: ["/work/odd"], storageId: "../windows" },
        // The same workspace again: read once.
        { label: "app again", folders: ["/work/app"], storageId: "self" },
      ],
      [remote, windows],
    );
    expect(tabs).toEqual([
      {
        label: "app",
        folders: ["/work/app", "/work/lib"],
        tabs: [
          { sessionId: A, title: "Wire the cache" },
          { sessionId: B, title: "Fix the build" },
        ],
      },
      // A session open in two windows stays with the first.
      { label: "api", folders: ["/work/api"], tabs: [{ sessionId: C, title: "Add the route" }] },
    ]);
  });

  it("finds the windows' tabs from the extension's global storage under a profile too, as VS Code lays its folders out", async () => {
    if (!sqlite()) return;
    const user = path.join(tempConfigDir(), "Code", "User");
    // A profile keeps its global state under profiles/<id>; the extension's global storage stays the default profile's,
    // and every window's workspace state is under User/workspaceStorage, whatever its profile.
    writeStateDb(path.join(user, "profiles", "-6a8f1c2", "globalStorage", "state.vscdb"), "Anthropic.claude-code", { lastProfileState: true });
    const extensionStorage = path.join(user, "globalStorage", "lookout.lookout");
    fs.mkdirSync(extensionStorage, { recursive: true });
    writeStateDb(path.join(user, "workspaceStorage", "1f2e3d4c", "state.vscdb"), "Anthropic.claude-code", claudeState([{ sessionId: A, title: "Wire the cache" }]));
    const roots = chatStorageRoots(path.dirname(extensionStorage), "darwin");
    expect(roots).toEqual([path.join(user, "workspaceStorage")]);
    expect(await openTabs([{ label: "app", folders: ["/work/app"], storageId: "1f2e3d4c" }], roots)).toEqual([{ label: "app", folders: ["/work/app"], tabs: [{ sessionId: A, title: "Wire the cache" }] }]);
  });

  it("gives nothing when no window has a database to read", async () => {
    expect(await openTabs([{ label: "app", folders: ["/work/app"], storageId: "abc" }], [path.join(tempConfigDir(), "missing")])).toEqual([]);
  });
});

describe("readPending", () => {
  it("keeps the entries that hold together, each session once", () => {
    const good = pending();
    expect(
      readPending([
        good,
        { ...good, title: "Same session" },
        { ...good, sessionId: B, title: "Line\none", from: 7 },
        { ...good, sessionId: C, cwd: "" },
        { ...good, sessionId: C, cwd: "/work/a\0b" },
        { ...good, sessionId: D, madeAt: "yesterday" },
        { ...good, sessionId: "../x" },
        null,
        "x",
      ]),
    ).toEqual([good, { ...good, sessionId: B, title: "Line one", from: "" }]);
    expect(readPending(undefined)).toEqual([]);
    expect(readPending({ sessionId: A })).toEqual([]);
  });
});

describe("folderKey and pendingFor", () => {
  it("matches a folder with or without trailing separators, and after resolving . and ..", () => {
    expect(folderKey("/work/app/", "linux")).toBe("/work/app");
    expect(folderKey("/work/app///", "linux")).toBe("/work/app");
    expect(folderKey("/work/lib/../app/.", "linux")).toBe("/work/app");
    expect(folderKey("/", "linux")).toBe("/");
    expect(folderKey("", "linux")).toBe("");
    expect(folderKey("C:\\Users\\Me\\App\\", "win32")).toBe("c:\\users\\me\\app");
    expect(folderKey("c:/users/me/app", "win32")).toBe("c:\\users\\me\\app");
    expect(folderKey("C:\\", "win32")).toBe("c:\\");
  });

  it("ignores case, and the Unicode form, only where the file system does", () => {
    expect(folderKey("/Users/Me/App", "darwin")).toBe(folderKey("/users/me/app/", "darwin"));
    expect(folderKey("/Users/me/Caf\u0065\u0301", "darwin")).toBe(folderKey("/Users/me/Caf\u00e9", "darwin"));
    expect(folderKey("/home/me/App", "linux")).not.toBe(folderKey("/home/me/app", "linux"));
  });

  it("gives a window the pending tabs whose session worked in its first folder", () => {
    const tabs = [pending({ sessionId: A, cwd: "/work/app/" }), pending({ sessionId: B, cwd: "/work/api" }), pending({ sessionId: C, cwd: "/work/App" }), pending({ sessionId: D, cwd: "/work/app/sub" })];
    expect(pendingFor(tabs, "/work/app", "linux").map((tab) => tab.sessionId)).toEqual([A]);
    expect(pendingFor(tabs, "/work/app", "darwin").map((tab) => tab.sessionId)).toEqual([A, C]);
    expect(pendingFor(tabs, undefined, "linux")).toEqual([]);
    expect(pendingFor(tabs, "", "linux")).toEqual([]);
  });

  it("takes tabs off a list by their sessions", () => {
    const tabs = [pending({ sessionId: A }), pending({ sessionId: B }), pending({ sessionId: C })];
    expect(withoutTabs(tabs, [pending({ sessionId: B.toUpperCase() })]).map((tab) => tab.sessionId)).toEqual([A, C]);
  });
});

describe("TabClaims", () => {
  it("lets exactly one window claim a tab, until it gives the tab up", () => {
    const dir = path.join(tempConfigDir(), "tab-claims");
    const mine = new TabClaims(dir);
    const theirs = new TabClaims(dir);
    const tab = pending();
    expect(mine.claim(tab)).toBe(true);
    expect(theirs.claim(tab)).toBe(false);
    expect(mine.claim(tab)).toBe(false);
    // The same session from a later backup is another tab to open.
    expect(theirs.claim({ ...tab, madeAt: tab.madeAt + 1 })).toBe(true);
    mine.release(tab);
    expect(theirs.claim(tab)).toBe(true);
  });

  it("refuses a tab whose id could not name a file, and forgets old claims", () => {
    const dir = path.join(tempConfigDir(), "tab-claims");
    const claims = new TabClaims(dir);
    expect(claims.claim(pending({ sessionId: "../../escape" }))).toBe(false);
    expect(claims.claim(pending({ madeAt: Number.NaN }))).toBe(false);
    expect(claims.claim(pending())).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([`${A}-1700000000000`]);
    claims.prune(Date.now());
    expect(fs.readdirSync(dir)).toHaveLength(1);
    claims.prune(Date.now() + 11 * 60_000);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(claims.claim(pending())).toBe(true);
    new TabClaims(path.join(dir, "missing")).prune(Date.now());
  });
});
