// The Claude tabs open in each VS Code window, for a backup, and the tabs a
// restore left to reopen: which window they belong in, and which window opens
// each one.
//
// The Claude Code extension keeps its workspace state in VS Code's state
// database for the window's workspace, `<workspaceStorage>/<id>/state.vscdb`,
// table `ItemTable`, under the key `Anthropic.claude-code`: a JSON object
// whose `panelTabSessions` lists the window's tabs, `{ sessionId, title,
// fullEditor }`, the ones it shows first, then the ones it restored after a
// reload and has not opened yet. Under WSL that database is on the Windows
// side, with the window's other workspace state. VS Code holds it open and
// writes to it: it is only ever read here, in place or from a copy.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSqlite, type Sqlite } from "../sqlite";
import { isStorageId } from "../windows";
import type { PendingTab, TabEntry, WindowTabs } from "./types";

/** The key of the Claude Code extension's state; compared without case. */
const STATE_KEY = "anthropic.claude-code";
const STATE_DB = "state.vscdb";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude Code's own titles are tab labels of 25 characters; a longer one is cut here. */
const TITLE_MAX = 200;
/** Control characters, and the ones that turn text around or break lines, in a title. */
const UNSAFE_CHARS = /[\p{Cc}\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
/** How long a window's claim on a pending tab holds off the other windows. */
const CLAIM_MS = 10 * 60_000;

/** A Claude Code session id. */
export function isSessionId(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

/** A title fit to show: on one line, without control characters, at most `TITLE_MAX` characters. Anything not a string is "". */
export function cleanTitle(title: unknown): string {
  if (typeof title !== "string") return "";
  const clean = title.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("")}…` : clean;
}

/** The tabs the extension's state lists, in its order: an entry without a session id is dropped, and a session listed twice is kept once. */
export function panelTabsOf(state: unknown): TabEntry[] {
  const list = state && typeof state === "object" ? (state as { panelTabSessions?: unknown }).panelTabSessions : undefined;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const tabs: TabEntry[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { sessionId, title } = entry as { sessionId?: unknown; title?: unknown };
    if (!isSessionId(sessionId) || seen.has(sessionId.toLowerCase())) continue;
    seen.add(sessionId.toLowerCase());
    tabs.push({ sessionId, title: cleanTitle(title) });
  }
  return tabs;
}

export interface ReadOptions {
  /** Node's sqlite; by default the runtime's own, when it has one. */
  sqlite?: Sqlite;
  /** Where a database that cannot be read in place is copied to be read; the system's temp directory by default. */
  tempDir?: string;
}

/** The text stored under the extension's key, or undefined when there is none. Throws when the database cannot be read. */
function stateText(sqlite: Sqlite, file: string, readOnly: boolean): string | undefined {
  const db = new sqlite.DatabaseSync(file, { readOnly });
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE lower(key) = ?").get(STATE_KEY) as { value?: unknown } | undefined;
    const value = row?.value;
    if (typeof value === "string") return value;
    return value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined;
  } finally {
    db.close();
  }
}

/**
 * The Claude tabs one state database records, or undefined when it holds no
 * state for the extension or cannot be read. The database is opened read-only;
 * when that fails (VS Code is writing to it, or left a journal that only a
 * writer can roll back), it is copied with its journal to a temp directory
 * and the copy is read, then removed.
 */
export function readPanelTabs(file: string, options: ReadOptions = {}): TabEntry[] | undefined {
  const sqlite = options.sqlite ?? loadSqlite();
  if (!sqlite) return undefined;
  let text: string | undefined;
  try {
    text = stateText(sqlite, file, true);
  } catch {
    text = readCopy(sqlite, file, options.tempDir ?? os.tmpdir());
  }
  if (text === undefined) return undefined;
  try {
    return panelTabsOf(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The extension's state from a copy of the database, which SQLite may bring to a consistent state; undefined when even that cannot be read. */
function readCopy(sqlite: Sqlite, file: string, tempDir: string): string | undefined {
  let dir: string | undefined;
  try {
    dir = fs.mkdtempSync(path.join(tempDir, "lookout-state-"));
    const copy = path.join(dir, STATE_DB);
    fs.copyFileSync(file, copy);
    for (const suffix of ["-journal", "-wal"]) {
      try {
        fs.copyFileSync(file + suffix, copy + suffix);
      } catch {
        // No journal of that kind.
      }
    }
    // Opened for writing: a hot journal is rolled back in the copy, never in VS Code's file.
    return stateText(sqlite, copy, false);
  } catch {
    return undefined;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The state databases that may hold a window's workspace state, the most
 * recently written first: under each of VS Code's workspace storage folders,
 * by the window's storage id and, for an id an extension host suffixed with
 * `-<n>` because the plain one was taken, by the plain one, which is the one
 * VS Code itself writes the window's state under. Only files that exist.
 */
export function stateDbsFor(storageId: string, roots: readonly string[]): string[] {
  if (!isStorageId(storageId)) return [];
  const ids = [...new Set([storageId, storageId.replace(/-\d+$/, "")])];
  const found: { file: string; mtimeMs: number }[] = [];
  for (const root of roots) {
    for (const id of ids) {
      const file = path.join(root, id, STATE_DB);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) found.push({ file, mtimeMs: stat.mtimeMs });
      } catch {
        // Not under this root.
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.file);
}

/** A VS Code window as the tabs are looked up for: `OtherWindow` from the registry, or this window. */
export interface TabWindow {
  label: string;
  folders?: readonly string[];
  /** Its folder under VS Code's workspaceStorage; a window without one has no tabs to read. */
  storageId?: string;
}

/**
 * The Claude tabs open in each of the windows, in the windows' order, each
 * window's in the order the extension lists them. `storageRoots` are VS
 * Code's workspace storage folders (`chatStorageRoots`). A session open in two
 * windows is kept with the first; a window with no tab is left out.
 */
export async function openTabs(windows: Iterable<TabWindow>, storageRoots: readonly string[], options: ReadOptions = {}): Promise<WindowTabs[]> {
  const out: WindowTabs[] = [];
  const readIds = new Set<string>();
  const sessions = new Set<string>();
  for (const window of windows) {
    if (!isStorageId(window.storageId)) continue;
    const id = window.storageId.replace(/-\d+$/, "");
    if (readIds.has(id)) continue;
    readIds.add(id);
    let tabs: TabEntry[] | undefined;
    for (const file of stateDbsFor(window.storageId, storageRoots)) {
      tabs = readPanelTabs(file, options);
      if (tabs) break;
    }
    const fresh = (tabs ?? []).filter((tab) => !sessions.has(tab.sessionId.toLowerCase()));
    for (const tab of fresh) sessions.add(tab.sessionId.toLowerCase());
    if (fresh.length > 0) out.push({ label: window.label, folders: [...(window.folders ?? [])], tabs: fresh });
    // Each database is read synchronously: the other work of the extension host runs between windows.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return out;
}

/** The tabs a restore left to reopen, as kept under `PENDING_TABS_KEY`: an entry that does not hold together is dropped, and a session listed twice is kept once. */
export function readPending(value: unknown): PendingTab[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PendingTab[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { sessionId, title, cwd, from, madeAt } = entry as Record<string, unknown>;
    if (!isSessionId(sessionId) || seen.has(sessionId.toLowerCase())) continue;
    if (typeof cwd !== "string" || cwd.trim() === "" || cwd.includes("\0")) continue;
    if (typeof madeAt !== "number" || !Number.isFinite(madeAt)) continue;
    seen.add(sessionId.toLowerCase());
    out.push({ sessionId, title: cleanTitle(title), cwd, from: cleanTitle(from), madeAt });
  }
  return out;
}

/**
 * A folder as compared with another: `.` and `..` resolved, separators and
 * trailing ones evened out, and without case or Unicode form where the file
 * system ignores them (macOS, Windows).
 */
export function folderKey(dir: string, platform: NodeJS.Platform = process.platform): string {
  if (!dir) return "";
  const paths = platform === "win32" ? path.win32 : path.posix;
  let key = paths.normalize(dir);
  const root = paths.parse(key).root;
  while (key.length > root.length && (key.endsWith("/") || (platform === "win32" && key.endsWith("\\")))) key = key.slice(0, -1);
  return platform === "darwin" || platform === "win32" ? key.normalize("NFC").toLowerCase() : key;
}

/** The pending tabs that belong in a window whose first folder is `folder`: those of sessions that worked there. */
export function pendingFor(pending: readonly PendingTab[], folder: string | undefined, platform: NodeJS.Platform = process.platform): PendingTab[] {
  if (!folder) return [];
  const key = folderKey(folder, platform);
  return pending.filter((tab) => folderKey(tab.cwd, platform) === key);
}

/** `pending` without the sessions of `tabs`. */
export function withoutTabs(pending: readonly PendingTab[], tabs: readonly PendingTab[]): PendingTab[] {
  const ids = new Set(tabs.map((tab) => tab.sessionId.toLowerCase()));
  return pending.filter((tab) => !ids.has(tab.sessionId.toLowerCase()));
}

/**
 * Which window opens each pending tab, shared by every window on the host:
 * one file per tab in a directory they all see, created exclusively, so
 * exactly one window opens it, even while another still lists it as pending.
 * A claim holds for a while after the tab left the pending list everywhere.
 */
export class TabClaims {
  constructor(private readonly dir: string) {}

  /** True for the one caller that gets to open this tab. */
  claim(tab: PendingTab): boolean {
    if (!isSessionId(tab.sessionId) || !Number.isFinite(tab.madeAt)) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.closeSync(fs.openSync(this.file(tab), "wx"));
      return true;
    } catch {
      return false;
    }
  }

  /** Gives the tab up: it could not be opened, and may be tried again. */
  release(tab: PendingTab): void {
    if (!isSessionId(tab.sessionId) || !Number.isFinite(tab.madeAt)) return;
    fs.rmSync(this.file(tab), { force: true });
  }

  /** Forgets the claims older than `keepMs`, so the directory stays small and a tab restored again can be opened again. */
  prune(now: number, keepMs: number = CLAIM_MS): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        if (now - fs.statSync(path.join(this.dir, name)).mtimeMs > keepMs) fs.rmSync(path.join(this.dir, name), { force: true });
      } catch {
        // Another window removed it first.
      }
    }
  }

  private file(tab: PendingTab): string {
    return path.join(this.dir, `${tab.sessionId.toLowerCase()}-${Math.trunc(tab.madeAt)}`);
  }
}
