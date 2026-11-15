// What a backup can hold on this machine, and how much of it: every file
// under each Claude config directory's `projects/` that belongs to a session
// (its transcript, its subagents' transcripts and its tool outputs), the
// history database, the kept transcripts, the usage records and the
// removed-worktrees log, each with its size; and the light state, notes and
// open tabs that travel in the manifest. The files are listed in the order a
// backup writes them, so that related bytes sit close together in the
// compressed stream: a session's kept transcript right after its own.
// Nothing here writes to the disk.
import * as fs from "node:fs";
import * as path from "node:path";
import { namesProjectDir, type ClaudeDir } from "../agents/claude/paths";
import { CLAUDE_CODE } from "../agents/claude/provider";
import { projectOf } from "../model";
import { SessionRecords, type SessionRecord } from "../sessionRecords";
import { loadSqlite, type Database } from "../sqlite";
import { TranscriptVault } from "../vault";
import { LIGHT_STATE_KEYS, SECTIONS, type Codec, type FileKind, type LightStateKey, type SectionId, type WindowTabs } from "./types";

/** Where the parts of a backup are on this machine. */
export interface InventorySources {
  claudeDirs: readonly ClaudeDir[];
  /** The history database. */
  storeFile: string;
  /** The session records, which hold the notes. */
  recordsDir: string;
  /** The kept transcripts. */
  vaultDir: string;
  usageDir: string;
  removedWorktreesFile: string;
  state: Partial<Record<LightStateKey, unknown>>;
  tabs: WindowTabs[];
  /** Epoch ms: what the age filter counts back from. */
  now: number;
}

/** A file a backup can hold. */
export interface InventoryItem {
  section: SectionId;
  kind: FileKind;
  /** Claude files: the label of the config directory it is in. */
  dir?: string;
  /** Its path under its root, with forward slashes, as the backup names it. */
  rel: string;
  abs: string;
  sessionId?: string;
  /**
   * Claude files: where the session worked, when that place is also what its
   * project folder is named after, so a restore that maps the place keeps the
   * session's files together in one folder.
   */
  cwd?: string;
  /** Claude files: the repository the session worked in, worktrees under their main repository. */
  repo?: string;
  /** Claude files: epoch ms the session's transcript was last written. */
  lastActive?: number;
  /** Bytes, when listed. */
  size: number;
}

export interface SectionTotal {
  count: number;
  bytes: number;
}

export interface RepoTotal {
  repo: string;
  /** Sessions with files in the backup's session sections. */
  sessions: number;
  bytes: number;
}

export interface Inventory {
  /** Every file, in the order a backup writes them. */
  items: InventoryItem[];
  /** The sessions with notes. */
  notes: SessionRecord[];
  state: Partial<Record<LightStateKey, unknown>>;
  tabs: WindowTabs[];
  claudeDirs: readonly ClaudeDir[];
  /** Per section: files (or notes, state keys, tabs) and bytes. */
  totals: Record<SectionId, SectionTotal>;
  /** The repositories the sessions worked in, the largest first. */
  repos: RepoTotal[];
  /** Epoch ms the inventory was taken, which the age filter counts back from. */
  takenAt: number;
}

/** What the user chose to back up. */
export interface Selection {
  sections: SectionId[];
  /** Only the sessions whose transcript was written within this many days. */
  activeWithinDays?: number;
  /** Only the sessions in these repositories; every one when absent. */
  repos?: string[];
}

const DAY_MS = 24 * 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The sections whose files belong to a session, which the age and repository filters apply to. */
const SESSION_SECTIONS: ReadonlySet<SectionId> = new Set(["transcripts", "subagents", "toolResults"]);
/** How a transcript's head is read: a chunk at a time, and no further than this. */
const HEAD_CHUNK = 64 * 1024;
const HEAD_LIMIT = 1024 * 1024;
const CWD_NEEDLE = Buffer.from('"cwd":"');
const NEWLINE = 0x0a;
/** Transcripts whose heads are read at once. */
const HEAD_READS = 8;
/** A file being written whole and moved into place: never part of a backup. */
const TEMP = /\.tmp$/;

/** A file found, with what a backup needs to know of it before reading it. */
interface Found {
  abs: string;
  rel: string;
  size: number;
  mtime: number;
}

/** A session's files in one project folder of one config directory. */
interface SessionFiles {
  dir: ClaudeDir;
  folder: string;
  id: string;
  transcript?: Found;
  subagents: Found[];
  toolResults: Found[];
  /** Where the session worked, as best known, and whether its folder is named after it. */
  cwd?: string;
  cwdNamesFolder: boolean;
  repo: string;
  lastActive: number;
}

/** Everything a backup can hold, with sizes. Of the transcripts it reads only the heads, and only of those whose place the history database does not give. */
export async function takeInventory(sources: InventorySources): Promise<Inventory> {
  const items: InventoryItem[] = [];
  const history = await statFile(sources.storeFile);
  if (history) items.push({ section: "history", kind: "history", rel: path.basename(sources.storeFile), abs: sources.storeFile, size: history.size });
  const sessions = await claudeSessions(sources.claudeDirs, sources.storeFile);
  // A kept transcript is most often a hard link to the session's own: right after it, the compressed stream stores it for next to nothing.
  const kept = await vaultItems(sources.vaultDir);
  const keptOf = new Map<string, InventoryItem[]>();
  for (const item of kept) if (item.sessionId) keptOf.set(item.sessionId, [...(keptOf.get(item.sessionId) ?? []), item]);
  const placed = new Set<InventoryItem>();
  for (const session of sessions) {
    items.push(...sessionItems(session));
    for (const item of keptOf.get(session.id) ?? []) {
      items.push(item);
      placed.add(item);
    }
    keptOf.delete(session.id);
  }
  items.push(...kept.filter((item) => !placed.has(item)));
  for (const found of await filesUnder(sources.usageDir, "")) items.push({ section: "usage", kind: "usage", rel: found.rel, abs: found.abs, size: found.size });
  const removed = await statFile(sources.removedWorktreesFile);
  if (removed) items.push({ section: "worktreesLog", kind: "removed-worktrees", rel: path.basename(sources.removedWorktreesFile), abs: sources.removedWorktreesFile, size: removed.size });

  const notes = new SessionRecords(sources.recordsDir, () => sources.now).noted();
  const state: Partial<Record<LightStateKey, unknown>> = {};
  for (const key of LIGHT_STATE_KEYS) if (sources.state[key] !== undefined) state[key] = sources.state[key];
  const tabs = sources.tabs;

  const totals = Object.fromEntries(SECTIONS.map((section) => [section, { count: 0, bytes: 0 }])) as Record<SectionId, SectionTotal>;
  for (const item of items) {
    totals[item.section].count++;
    totals[item.section].bytes += item.size;
  }
  totals.state = { count: Object.keys(state).length, bytes: jsonBytes(state) };
  totals.notes = { count: notes.reduce((sum, record) => sum + (record.notes?.length ?? 0), 0), bytes: jsonBytes(notes) };
  totals.tabs = { count: tabs.reduce((sum, window) => sum + window.tabs.length, 0), bytes: jsonBytes(tabs) };

  return { items, notes, state, tabs, claudeDirs: sources.claudeDirs, totals, repos: repoTotals(items), takenAt: sources.now };
}

/** The inventory's files the selection takes, in the order a backup writes them. A session's subagents and tool outputs follow its transcript through the filters. */
export function select(inventory: Inventory, selection: Selection): InventoryItem[] {
  const sections = new Set(selection.sections);
  const since = selection.activeWithinDays === undefined ? undefined : inventory.takenAt - selection.activeWithinDays * DAY_MS;
  const repos = selection.repos === undefined ? undefined : new Set(selection.repos);
  return inventory.items.filter((item) => {
    if (!sections.has(item.section)) return false;
    if (!SESSION_SECTIONS.has(item.section)) return true;
    if (since !== undefined && (item.lastActive ?? -Infinity) < since) return false;
    return !repos || (item.repo !== undefined && repos.has(item.repo));
  });
}

/**
 * Compressed size over raw size, per codec and kind of file, measured on a
 * real machine's data: Claude transcripts, subagents and tool outputs
 * together, compressed as one stream with zstd's long window; the history
 * database with gzip. The history database with zstd was not measured: 0.25
 * is a guess between the two.
 */
const RATIOS: Record<"zstd3" | "zstd9" | "gzip", Record<FileKind, number>> = {
  zstd3: { transcript: 0.13, subagent: 0.13, "tool-result": 0.13, vault: 0.13, history: 0.25, usage: 0.3, "removed-worktrees": 0.3 },
  zstd9: { transcript: 0.126, subagent: 0.126, "tool-result": 0.126, vault: 0.126, history: 0.25, usage: 0.3, "removed-worktrees": 0.3 },
  gzip: { transcript: 0.297, subagent: 0.297, "tool-result": 0.297, vault: 0.297, history: 0.37, usage: 0.35, "removed-worktrees": 0.35 },
};
/** What a file's entry in the manifest adds once compressed: its path, sizes, times and digest. */
const MANIFEST_BYTES_PER_FILE = 100;

/** About how many bytes a backup of these files takes: an estimate from measured ratios, not a promise. */
export function estimate(items: readonly InventoryItem[], codec: Codec, level: number): number {
  const ratios = RATIOS[codec === "gzip" ? "gzip" : level >= 9 ? "zstd9" : "zstd3"];
  let bytes = 0;
  for (const item of items) bytes += item.size * ratios[item.kind] + MANIFEST_BYTES_PER_FILE;
  return Math.round(bytes);
}

/** The session's files as a backup lists them: the transcript, then its subagents, then its tool outputs. */
function sessionItems(session: SessionFiles): InventoryItem[] {
  const common = {
    dir: session.dir.label,
    sessionId: session.id,
    ...(session.cwd !== undefined && session.cwdNamesFolder ? { cwd: session.cwd } : {}),
    repo: session.repo,
    lastActive: session.lastActive,
  };
  const out: InventoryItem[] = [];
  if (session.transcript) out.push({ section: "transcripts", kind: "transcript", rel: session.transcript.rel, abs: session.transcript.abs, size: session.transcript.size, ...common });
  for (const found of session.subagents) out.push({ section: "subagents", kind: "subagent", rel: found.rel, abs: found.abs, size: found.size, ...common });
  for (const found of session.toolResults) out.push({ section: "toolResults", kind: "tool-result", rel: found.rel, abs: found.abs, size: found.size, ...common });
  return out;
}

/**
 * Every session's files under the config directories' `projects/`: the
 * top-level `<folder>/<id>.jsonl` transcripts, and `<folder>/<id>/subagents`
 * and `<folder>/<id>/tool-results`; nothing else in a folder (its `memory/`
 * least of all). Grouped by repository, then folder, oldest first: related
 * conversations sit next to each other.
 */
async function claudeSessions(dirs: readonly ClaudeDir[], storeFile: string): Promise<SessionFiles[]> {
  const sessions: SessionFiles[] = [];
  for (const dir of dirs) {
    const projects = path.join(dir.resolved, "projects");
    for (const folder of await subdirs(projects)) {
      const folderPath = path.join(projects, folder);
      const byId = new Map<string, SessionFiles>();
      const session = (id: string): SessionFiles => {
        let found = byId.get(id);
        if (!found) {
          found = { dir, folder, id, subagents: [], toolResults: [], cwdNamesFolder: false, repo: "", lastActive: 0 };
          byId.set(id, found);
        }
        return found;
      };
      await Promise.all(
        (await entries(folderPath)).map(async (entry) => {
          const id = entry.name.endsWith(".jsonl") ? entry.name.slice(0, -".jsonl".length) : entry.name;
          if (!UUID.test(id)) return;
          if (entry.isFile() && id !== entry.name) {
            const stat = await statFile(path.join(folderPath, entry.name));
            if (stat) session(id).transcript = { abs: path.join(folderPath, entry.name), rel: `${folder}/${entry.name}`, ...stat };
          } else if (entry.isDirectory() && id === entry.name) {
            const [subagents, toolResults] = await Promise.all([filesUnder(path.join(folderPath, id, "subagents"), `${folder}/${id}/subagents`), filesUnder(path.join(folderPath, id, "tool-results"), `${folder}/${id}/tool-results`)]);
            if (subagents.length > 0 || toolResults.length > 0) Object.assign(session(id), { subagents, toolResults });
          }
        }),
      );
      for (const found of byId.values()) {
        // A session's folders without its transcript: as old as their newest file.
        found.lastActive = found.transcript?.mtime ?? [...found.subagents, ...found.toolResults].reduce((newest, file) => Math.max(newest, file.mtime), 0);
        sessions.push(found);
      }
    }
  }
  await placeSessions(sessions, storedCwds(storeFile));
  return sessions.sort((a, b) => compare(a.repo, b.repo) || compare(a.folder, b.folder) || a.lastActive - b.lastActive || compare(a.id, b.id) || dirs.indexOf(a.dir) - dirs.indexOf(b.dir));
}

/**
 * Where each session worked, and its repository. The history database knows
 * most; a transcript's head tells the rest. A project folder is named after
 * the place a session started, so a place the folder is not named after (the
 * session went on elsewhere) is checked against the transcript's head, which
 * holds where it started. A session with no place known takes its folder's
 * repository from the other sessions there, else the folder's own name.
 */
async function placeSessions(sessions: readonly SessionFiles[], stored: ReadonlyMap<string, string>): Promise<void> {
  await eachLimited(sessions, HEAD_READS, async (session) => {
    const known = stored.get(session.id);
    const head = (known === undefined || !namesProjectDir(session.folder, known)) && session.transcript ? await headCwd(session.transcript.abs) : undefined;
    const naming = [known, head].find((cwd) => cwd !== undefined && namesProjectDir(session.folder, cwd));
    session.cwd = naming ?? known ?? head;
    session.cwdNamesFolder = naming !== undefined;
  });
  const repos = new Map<string, string>();
  const repoOf = (cwd: string): string => {
    let repo = repos.get(cwd);
    if (repo === undefined) {
      repo = projectOf(cwd).project;
      repos.set(cwd, repo);
    }
    return repo;
  };
  const folderRepos = new Map<string, string>();
  for (const session of sessions) {
    if (session.cwd === undefined) continue;
    session.repo = repoOf(session.cwd);
    const key = `${session.dir.label}/${session.folder}`;
    if (!folderRepos.has(key)) folderRepos.set(key, session.repo);
  }
  for (const session of sessions) if (session.cwd === undefined) session.repo = folderRepos.get(`${session.dir.label}/${session.folder}`) ?? session.folder;
}

/** The place each Claude session worked, as the history database has it; none where there is no database or it cannot be read. */
function storedCwds(storeFile: string): Map<string, string> {
  const out = new Map<string, string>();
  const sqlite = loadSqlite();
  if (!sqlite || !fs.existsSync(storeFile)) return out;
  let db: Database | undefined;
  try {
    db = new sqlite.DatabaseSync(storeFile, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    for (const row of db.prepare("SELECT id, cwd FROM sessions WHERE agent = ?").all(CLAUDE_CODE) as { id: string; cwd: unknown }[]) {
      if (typeof row.cwd === "string" && row.cwd !== "") out.set(row.id, row.cwd);
    }
  } catch {
    // An older or broken database: the transcripts' heads tell instead.
  } finally {
    db?.close();
  }
  return out;
}

/**
 * The place a transcript's session started: the `cwd` of its first
 * main-chain line that has one. The file is read from its start a chunk at a
 * time, up to that line and never past the first MiB, however large it is.
 */
export async function headCwd(file: string): Promise<string | undefined> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return undefined;
  }
  try {
    /** The line read so far, in pieces, until its end is found. */
    let pending: Buffer[] = [];
    let position = 0;
    while (position < HEAD_LIMIT) {
      const buffer = Buffer.allocUnsafe(Math.min(HEAD_CHUNK, HEAD_LIMIT - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
        const cwd = cwdIn(Buffer.concat([...pending, chunk.subarray(start, end)]));
        if (cwd !== undefined) return cwd;
        pending = [];
        start = end + 1;
      }
      pending.push(chunk.subarray(start));
    }
    // The last line of a file shorter than the limit, which may have no line end.
    return position < HEAD_LIMIT ? cwdIn(Buffer.concat(pending)) : undefined;
  } finally {
    await handle.close();
  }
}

/** The `cwd` of a main-chain line; the line is parsed only when it names one. */
function cwdIn(line: Buffer): string | undefined {
  if (!line.includes(CWD_NEEDLE)) return undefined;
  try {
    const entry = JSON.parse(line.toString("utf8")) as Record<string, unknown> | null;
    return entry && entry.isSidechain !== true && typeof entry.cwd === "string" && entry.cwd !== "" ? entry.cwd : undefined;
  } catch {
    return undefined;
  }
}

/** The kept transcripts and their records, each with the session it keeps where its record says. */
async function vaultItems(vaultDir: string): Promise<InventoryItem[]> {
  const vault = new TranscriptVault(vaultDir);
  const sessions = new Map<string, string>();
  for (const kept of vault.kept()) {
    const name = path.basename(vault.fileOf(kept.id));
    sessions.set(name, kept.id);
    sessions.set(name.replace(/\.jsonl$/, ".json"), kept.id);
  }
  const out: InventoryItem[] = [];
  for (const found of await filesUnder(vaultDir, "", false)) {
    if (!found.rel.endsWith(".json") && !found.rel.endsWith(".jsonl")) continue;
    const sessionId = sessions.get(found.rel);
    out.push({ section: "vault", kind: "vault", rel: found.rel, abs: found.abs, size: found.size, ...(sessionId ? { sessionId } : {}) });
  }
  return out;
}

/** Per repository: the sessions with files in the session sections, and their bytes. */
function repoTotals(items: readonly InventoryItem[]): RepoTotal[] {
  const byRepo = new Map<string, { sessions: Set<string>; bytes: number }>();
  for (const item of items) {
    if (!SESSION_SECTIONS.has(item.section) || item.repo === undefined) continue;
    let total = byRepo.get(item.repo);
    if (!total) {
      total = { sessions: new Set(), bytes: 0 };
      byRepo.set(item.repo, total);
    }
    total.sessions.add(`${item.dir}/${item.sessionId}`);
    total.bytes += item.size;
  }
  return [...byRepo]
    .map(([repo, total]) => ({ repo, sessions: total.sessions.size, bytes: total.bytes }))
    .sort((a, b) => b.bytes - a.bytes || compare(a.repo, b.repo));
}

/** The regular files under `root`, at any depth or only at the top, with their paths under it after `relBase`: no links followed, no files being written. Sorted by path. */
async function filesUnder(root: string, relBase: string, deep = true): Promise<Found[]> {
  const out: Found[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const found = await entries(dir);
    await Promise.all(
      found.map(async (entry) => {
        const abs = path.join(dir, entry.name);
        const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory() && deep) await walk(abs, entryRel);
        else if (entry.isFile() && !TEMP.test(entry.name)) {
          const stat = await statFile(abs);
          if (stat) out.push({ abs, rel: entryRel, ...stat });
        }
      }),
    );
  };
  await walk(root, relBase);
  return out.sort((a, b) => compare(a.rel, b.rel));
}

async function entries(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function subdirs(dir: string): Promise<string[]> {
  return (await entries(dir))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compare);
}

/** A regular file's size and time; none when it is not there or is not a file. */
async function statFile(file: string): Promise<{ size: number; mtime: number } | undefined> {
  try {
    const st = await fs.promises.stat(file);
    return st.isFile() ? { size: st.size, mtime: Math.round(st.mtimeMs) } : undefined;
  } catch {
    return undefined;
  }
}

/** Runs `work` on each item, no more than `limit` at once. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Code-point order: the same on every machine, whatever its locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
