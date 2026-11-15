// Restoring a backup on this machine: what it would add, change or leave
// (the plan), and doing it. Nothing already here is lost: a merge keeps
// what is here, a file replaced is copied under the restore's own folder
// of `restore-backups` first, a transcript that went on differently here
// stays as it is with the backup's copy set aside in that folder, and
// restoring the same backup twice changes nothing the second time. Nothing
// in the backup is trusted: every path is put together from checked pieces
// under a root this machine chose (see restorePaths), notes are cleaned as
// the note page cleans them, the light state is read the way the board
// reads it, what does not parse dropped, and what a backup may bring is
// capped.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Transform, type Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { encodeProjectDir, type ClaudeDir } from "../agents/claude/paths";
import { readRetention, type Retention, type RetentionLevel } from "../agents/claude/retention";
import { isGroupBy } from "../grouping";
import { readParking } from "../parking";
import { plainText } from "../plainText";
import { RESTORE_DAYS } from "../removedWorktrees";
import { cleanNote, SessionRecords, type NoteEntry, type SessionRecord } from "../sessionRecords";
import { isSortKey, readSort } from "../sorting";
import { ConversationStore } from "../store";
import type { RemovedRecord } from "../worktrees";
import { mergeHistory, readHistorySessions, type HistoryMerge, type HistoryPlace, type HistorySession } from "./restoreHistory";
import { findLocalRepos, readRepoRecords, repoAt, repoMappings, type AmbiguousRepo, type RepoRecord } from "./repos";
import { inside, isFolderName, isSegment, isSessionId, layOf, makeFolders, mapCovered, mapFolderName, mapPath, mapPathKey, projectFolder, segmentsOf, under } from "./restorePaths";
import { PENDING_TABS_KEY, type BundleFile, type BundleManifest, type BundleSource, type LightStateKey, type PathMapping, type PendingTab, type SourceMachine } from "./types";

/** Lookout's state shared by every window: VS Code's `globalState`. */
export interface StateStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * The tabs each restored backup queued, so that restoring it again does not
 * queue a tab reopened or forgotten since: `<from>\0<madeAt>\0<session id>`,
 * the newest last. Kept for the machine, never synced.
 */
export const RESTORED_TABS_KEY = "lookout.restoredTabs";
/** The backups restored on this machine (`RestoredBackup[]`), the newest last. Kept for the machine, never synced. */
export const RESTORED_BACKUPS_KEY = "lookout.restoredBackups";

/** A backup restored on this machine. */
export interface RestoredBackup {
  host: string;
  createdAt: number;
  /** Hex sha256 of its manifest. */
  manifest: string;
  /** Epoch ms it was restored. */
  at: number;
}

/** Where a restore puts things on this machine. */
export interface RestoreTargets {
  home: string;
  /** This machine's Claude Code config directories. */
  claudeDirs: readonly Pick<ClaudeDir, "label" | "resolved" | "isDefault">[];
  /** The session records: notes. */
  recordsDir: string;
  /** The history database. */
  storeFile: string;
  vaultDir: string;
  usageDir: string;
  removedWorktreesFile: string;
  /** `<globalStorage>/restore-backups`: what a restore replaces is copied under a folder of its own here first. */
  backupsDir: string;
  state: StateStore;
  /** Where each other agent keeps its conversation files on this machine, by agent id: a kept transcript or a history entry of an agent not listed is left out. */
  agentRoots?: Readonly<Record<string, string>>;
  /** For the history database while it is read out of the backup; the system's temporary folder when not given. */
  tempDir?: string;
  /** The window's folders: their own settings files can set how long Claude Code keeps transcripts. */
  folders?: readonly string[];
  /** How long Claude Code keeps transcripts of a config directory here; `readRetention` with the window's folders when not given. */
  retention?(configDir: string): Retention;
  now?: () => number;
}

/** A number of files and their bytes. */
export interface Tally {
  count: number;
  bytes: number;
}

/** Something in the backup a restore leaves out, and why, in plain words. */
export interface Refusal {
  what: string;
  why: string;
}

export interface NoteCounts {
  /** Sessions with notes not on this machine. */
  added: number;
  /** Sessions whose notes here gain notes from the backup, or a newer edit of one. */
  merged: number;
  unchanged: number;
  /** Records in the backup that do not parse, or past the most a backup brings. */
  skipped: number;
}

export interface StateCounts {
  /** Keys unset here, taken from the backup. */
  taken: LightStateKey[];
  /** Keys set here that gain from the backup's. */
  merged: LightStateKey[];
}

export interface TabCounts {
  /** Tabs to reopen once their folder is open. */
  added: number;
  /** Tabs already waiting to reopen. */
  present: number;
  /** Tabs this backup queued when it was restored before, reopened or forgotten since. */
  earlier: number;
  /** Tabs whose session's transcript is neither on this machine nor in the backup. */
  gone: number;
  /** Tabs of a folder no mapping covers, or whose folder's names are not ones a restore takes. */
  refused: number;
  /** Tabs of a window with no folder, or that do not parse. */
  skipped: number;
}

/** Claude Code's files, by what a restore does with each. */
export interface FileCounts {
  /** Not on this machine. */
  new: Tally;
  /** Longer in the backup: replaced when this machine's copy is the start of the backup's, else kept with the backup's set aside. */
  newer: Tally;
  /** The same bytes here. */
  same: Tally;
  /** Longer here, and starting with the backup's: kept as it is. */
  kept: Tally;
  /** Different here, the session having gone on differently on each machine: kept as it is, with the backup's copy set aside. */
  different: Tally;
  refused: number;
}

export interface MissingFolder {
  /** On the source machine. */
  from: string;
  /** Where the mapping puts it on this machine, where nothing is. */
  to: string;
  /** How many of the backup's sessions worked in it. */
  sessions: number;
}

/** A backup's history database, read out of the file ahead of the restore. */
export interface HistoryCopy {
  file: string;
  sessions: HistorySession[];
  /** Why its sessions cannot be read, when they cannot. */
  failed?: string;
  /** Lets go of the copy. */
  dispose(): void;
}

/** The restored Claude Code files that Claude Code deletes at its next start: last written longer ago than it keeps transcripts here. */
export interface RetentionRisk {
  /** Transcripts, subagents' transcripts and tool outputs. */
  files: number;
  transcripts: number;
  bytes: number;
  /** Epoch ms the oldest of them was last written. */
  oldest: number;
  /** Its age in whole days, rounded up. */
  oldestDays: number;
  /** Each config directory that deletes some: how long it keeps transcripts, and what sets that. */
  dirs: RetentionDir[];
}

export interface RetentionDir {
  label: string;
  /** The config directory. */
  resolved: string;
  days: number;
  level: RetentionLevel;
  /** The settings file that sets it; none for Claude Code's default. */
  file?: string;
  /** Its files that go. */
  files: number;
}

/** What restoring a backup would do. Counts only: never a note's text. */
export interface RestorePlan {
  source: SourceMachine;
  createdAt: number;
  mapping: PathMapping[];
  notes: NoteCounts;
  state: StateCounts;
  /** `<id>.jsonl` files. */
  transcripts: FileCounts;
  /** Their `subagents/` and `tool-results/` files. */
  sessionFiles: FileCounts;
  /** The backup's history: the size of its database, and, when it was read ahead, the sessions it would add and those whose file has no place here. */
  history?: { bytes: number; sessions?: number; leftOut?: number; failed?: string };
  tabs: TabCounts;
  /** Kept transcripts, and the bytes of those it would write with their records. */
  vault: { added: number; present: number; bytes: number };
  usage: { added: number; present: number; bytes: number };
  /** The backup has a removed-worktrees log. */
  worktreesLog: boolean;
  /** The folders the backup's sessions worked in that the mapping puts where nothing is, the most used first. */
  missingFolders: MissingFolder[];
  /** The restored files Claude Code deletes at its next start, when there are any. */
  retention?: RetentionRisk;
  /** Epoch ms this very backup was last restored on this machine, when it was. */
  restoredBefore?: number;
  refused: Refusal[];
  /** The history database read ahead (`readBackupHistory`), for the restore to use rather than read it again. */
  historyCopy?: HistoryCopy;
}

/** Claude Code's files, by what the restore did with each. */
export interface FilesDone {
  written: Tally;
  replaced: Tally;
  same: Tally;
  /** Longer here and starting with the backup's: kept. */
  kept: Tally;
  /** Different here: kept, and the backup's copy written under the restore's `diverged` folder. */
  diverged: Tally;
  refused: number;
}

/** What a restore did. */
export interface RestoreResult {
  notes: NoteCounts;
  state: StateCounts;
  transcripts: FilesDone;
  sessionFiles: FilesDone;
  /** How the history merge went, when the backup has one. */
  history?: HistoryMerge;
  /** The history's conversations left out because their file has no place here; each is among `refused` with why. */
  historyLeftOut: number;
  tabs: TabCounts;
  vault: { added: number; present: number; skipped: number };
  usage: { added: number; present: number };
  /** Removed worktrees added to this machine's log, and those refused: a folder no mapping covers. */
  worktreesLog: { added: number; refused: number };
  refused: Refusal[];
  /** Files that could not be written, with why. */
  failed: Refusal[];
  /** Where what the restore replaced was copied, when it replaced anything. */
  backupDir?: string;
  /** Where the backup's copies of the files that differ here went, when any did. */
  divergedDir?: string;
  /** Stopped before the end: what was done until then stays. */
  cancelled: boolean;
}

const FAVOURITES: LightStateKey = "lookout.favourites";
const ARCHIVE: LightStateKey = "lookout.archive";
const PARKING: LightStateKey = "lookout.parking";
const SORT: LightStateKey = "lookout.sort";
const GROUP: LightStateKey = "lookout.group";
const CLAUDE_ORGS: LightStateKey = "lookout.claudeOrgs";

const CLAUDE_AGENT = "claude-code";
const DAY_MS = 24 * 60 * 60_000;
/** The removed-worktrees log keeps this many. */
const REMOVED_MAX = 1000;
/** Files read whole into memory are no bigger: a kept transcript's record, the removed-worktrees log. */
const SMALL_MAX = 4 * 1024 * 1024;
/** The largest history database a restore takes out of a backup. */
const HISTORY_MAX = 2 * 1024 ** 3;
const HISTORY_TOO_BIG = "it is larger than the 2 GiB a restore takes";
/** Refusals listed in a plan or a result; the rest are counted. */
const REFUSALS_LISTED = 50;
/** What a backup may bring: session records with notes, notes on one session (the newest), ids in the favourites and the archive, in each parking list, account names. */
const NOTE_RECORDS_MAX = 10_000;
const NOTES_PER_SESSION = 1_000;
const LIST_MAX = 5_000;
const PARKING_MAX = 500;
const ORGS_MAX = 100;
/** The tabs and backups remembered as restored. */
const RESTORED_TABS_MAX = 5_000;
const RESTORED_BACKUPS_MAX = 100;
/** How the names of a restore's temporary folders start. */
const TEMP_PREFIX = "lookout-restore-";

/** An id from the backup: a session's, a note's, an account's. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** An id in the favourites, the archive or parking. */
const LIST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const NOTE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
const VAULT_NAME = /^[0-9a-f]{40}\.jsonl?$/;
const USAGE_NAME = /^[\w.-]+$/;

/** A path of the source machine, as it is here. */
type Mapper = (p: unknown) => string | undefined;

/** The mapping a restore starts from: the source machine's home is this one's. */
export function defaultMapping(source: SourceMachine, home: string = os.homedir()): PathMapping[] {
  return typeof source?.home === "string" && source.home !== "" ? [{ from: source.home, to: home }] : [];
}

/** `p` is below `home` on the source machine, not `home` itself: compared its way, without case where it ignores case. */
function strictlyInside(home: unknown, p: string, platform: NodeJS.Platform): boolean {
  if (typeof home !== "string" || home === "") return false;
  const split = (x: string) => x.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter((part) => part !== "");
  const fold = platform === "win32" || platform === "darwin";
  const h = split(home);
  const q = split(p);
  if (q.length <= h.length || q.some((part) => part === "." || part === "..")) return false;
  return h.every((part, i) => (fold ? part.toLowerCase() === q[i]!.toLowerCase() : part === q[i]));
}

/**
 * The mapping a restore starts from: the old home folder to this one, and
 * each repository the backup records to its clone here when it has moved
 * or been renamed (`repoMappings`). Clones are looked for in `starts`, the
 * folders this machine is known to work in, and under the home folder, and
 * only when some repository is not where the home folder's mapping puts it.
 * Repositories with several equally good clones are named in `ambiguous`.
 * Only a repository inside the old home folder is mapped: the backup's
 * repositories refine where the home folder's mapping puts a path, and never
 * bring a path outside it into a folder of this machine.
 */
export function suggestMapping(manifest: BundleManifest, home: string, starts: readonly string[]): { mapping: PathMapping[]; ambiguous: AmbiguousRepo[] } {
  const base = defaultMapping(manifest.source, home);
  const platform = manifest.source?.platform ?? "linux";
  const sources = readRepoRecords(manifest.repos).filter((repo) => !repo.linked && strictlyInside(manifest.source?.home, repo.root, platform));
  if (sources.length === 0) return { mapping: base, ambiguous: [] };
  const mapped = (p: string) => mapPath(p, base, platform);
  const placed = (repo: RepoRecord) => {
    const there = mapped(repo.root);
    const at = there ? repoAt(there) : undefined;
    return there !== undefined && at !== undefined && path.resolve(at.root) === path.resolve(there) && at.remotes.some((key) => repo.remotes.includes(key));
  };
  // Every repository at its place: nothing to look for.
  const wanted = new Set(sources.filter((repo) => !placed(repo)).flatMap((repo) => repo.remotes));
  if (wanted.size === 0) return { mapping: base, ambiguous: [] };
  const local = findLocalRepos(starts, home, wanted);
  const found = repoMappings(sources, local, mapped, home, platform);
  return { mapping: [...base, ...found.mapping], ambiguous: found.ambiguous };
}

function tally(): Tally {
  return { count: 0, bytes: 0 };
}

function add(t: Tally, bytes: number): void {
  t.count++;
  t.bytes += bytes;
}

function fileCounts(): FileCounts {
  return { new: tally(), newer: tally(), same: tally(), kept: tally(), different: tally(), refused: 0 };
}

function filesDone(): FilesDone {
  return { written: tally(), replaced: tally(), same: tally(), kept: tally(), diverged: tally(), refused: 0 };
}

function tabCounts(): TabCounts {
  return { added: 0, present: 0, earlier: 0, gone: 0, refused: 0, skipped: 0 };
}

function refuse(list: Refusal[], what: string, why: string): void {
  if (list.length < REFUSALS_LISTED) list.push({ what, why });
}

/** A file's name in a refusal: kind and path, as plain text. */
function nameOf(entry: Partial<BundleFile>): string {
  const rel = typeof entry.rel === "string" ? plainText(entry.rel.replace(/[\p{Cc}]/gu, "?")) : "?";
  return `${typeof entry.kind === "string" ? plainText(entry.kind, 40) : "file"} ${rel}`;
}

/** The entry's key, the same for the manifest's entry and the one the reader passes. */
function keyOf(entry: BundleFile): string {
  return `${entry.offset}\0${entry.kind}\0${entry.dir ?? ""}\0${entry.rel}`;
}

/** The source machine's name as Lookout shows it: plain text. */
function hostName(manifest: BundleManifest): string {
  return plainText(manifest.source?.host) || "another machine";
}

// ---------------------------------------------------------------------------
// Where Claude Code's files go

/** A Claude Code file of the backup, placed on this machine. */
interface Placed {
  entry: BundleFile;
  /** Its session. */
  id: string;
  /** The config directory on this machine. */
  configDir: string;
  /** `<configDir>/projects`. */
  root: string;
  /** That config directory's label. */
  label: string;
  /** Its path under the root. */
  parts: string[];
  target: string;
  transcript: boolean;
}

interface Placement {
  byKey: Map<string, Placed>;
  /** Where each transcript goes, by its source directory label, folder and session. */
  transcripts: Map<string, string>;
  refused: Refusal[];
  refusedCount: { transcripts: number; sessionFiles: number };
}

const CLAUDE_KINDS = new Set(["transcript", "subagent", "tool-result"]);

/** This machine's config directory for a file of the source machine's directory with this label: the one with the same label, else the default one. */
function claudeDirFor(label: unknown, targets: RestoreTargets): { label: string; resolved: string; root: string } | undefined {
  const dir = targets.claudeDirs.find((d) => d.label === label) ?? targets.claudeDirs.find((d) => d.isDefault) ?? targets.claudeDirs[0];
  return dir ? { label: dir.label, resolved: dir.resolved, root: path.join(dir.resolved, "projects") } : undefined;
}

function sessionKey(label: unknown, folder: string, id: string): string {
  return `${typeof label === "string" ? label : ""}\0${folder}\0${id.toLowerCase()}`;
}

/** Checks a Claude Code file's path from the backup: its folder, its session, and its shape for its kind. */
function claudeParts(entry: BundleFile): { folder: string; id: string; rest: string[] } | string {
  const parts = segmentsOf(entry.rel);
  if (!parts || !isFolderName(parts[0])) return "its path is not one a backup writes";
  const [folder, second] = parts as [string, string | undefined];
  if (entry.kind === "transcript") {
    if (parts.length !== 2 || !second?.endsWith(".jsonl")) return "its path is not one a backup writes";
    const id = second.slice(0, -".jsonl".length);
    if (!isSessionId(id)) return "its session id is not one";
    if (entry.sessionId !== undefined && entry.sessionId !== id) return "its session id is not one";
    return { folder, id, rest: parts.slice(1) };
  }
  const sub = entry.kind === "subagent" ? "subagents" : "tool-results";
  if (parts.length < 4 || parts[2] !== sub) return "its path is not one a backup writes";
  if (!isSessionId(second)) return "its session id is not one";
  if (entry.sessionId !== undefined && entry.sessionId !== second) return "its session id is not one";
  return { folder, id: second, rest: parts.slice(1) };
}

/**
 * Where each of the backup's Claude Code files goes: the config directory
 * with the same label here, else the default one; the folder of the place
 * the session worked, mapped, else the folder's name mapped. A session's
 * subagents and tool results follow its transcript.
 */
function placeClaudeFiles(manifest: BundleManifest, targets: RestoreTargets, map: Mapper, mapping: readonly PathMapping[], platform: NodeJS.Platform): Placement {
  const out: Placement = { byKey: new Map(), transcripts: new Map(), refused: [], refusedCount: { transcripts: 0, sessionFiles: 0 } };
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const claude = files.filter((entry) => CLAUDE_KINDS.has(entry?.kind));
  const taken = new Set<string>();
  const no = (entry: BundleFile, why: string) => {
    refuse(out.refused, nameOf(entry), why);
    if (entry.kind === "transcript") out.refusedCount.transcripts++;
    else out.refusedCount.sessionFiles++;
  };
  // Transcripts first, for their sessions' other files to follow.
  const ordered = [...claude.filter((entry) => entry.kind === "transcript"), ...claude.filter((entry) => entry.kind !== "transcript")];
  for (const entry of ordered) {
    const checked = claudeParts(entry);
    if (typeof checked === "string") {
      no(entry, checked);
      continue;
    }
    const dir = claudeDirFor(entry.dir, targets);
    if (!dir) {
      no(entry, "no Claude Code folder here takes it");
      continue;
    }
    const root = dir.root;
    const sk = sessionKey(entry.dir, checked.folder, checked.id);
    let folder = entry.kind === "transcript" ? undefined : out.transcripts.get(sk);
    if (folder === undefined) {
      const cwd = typeof entry.cwd === "string" && entry.cwd !== "" ? map(entry.cwd) : undefined;
      folder = (cwd ? projectFolder(cwd) : undefined) ?? mapFolderName(checked.folder, mapping, platform);
    }
    const parts = folder ? [folder, ...checked.rest] : undefined;
    const target = parts ? under(root, parts) : undefined;
    if (!parts || !target) {
      no(entry, "its path is not one a backup writes");
      continue;
    }
    if (taken.has(target)) {
      no(entry, "another file in the backup goes to the same place");
      continue;
    }
    taken.add(target);
    if (entry.kind === "transcript") out.transcripts.set(sk, folder!);
    out.byKey.set(keyOf(entry), { entry, id: checked.id, configDir: dir.resolved, root, label: dir.label, parts, target, transcript: entry.kind === "transcript" });
  }
  return out;
}

/** A path of the source machine in its parts, split its way. */
function sourceParts(file: string, platform: NodeJS.Platform): string[] {
  return file.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter((part) => part !== "");
}

/** The parts of a source machine's path under one of its Claude Code config directories' `projects`, with that directory's label. */
function underSourceProjects(file: string, manifest: BundleManifest): { label: string; parts: string[] } | undefined {
  const platform = manifest.source?.platform ?? "linux";
  const fold = platform === "win32" || platform === "darwin";
  const same = (a: string, b: string) => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);
  const parts = sourceParts(file, platform);
  for (const dir of Array.isArray(manifest.claudeDirs) ? manifest.claudeDirs : []) {
    if (typeof dir?.resolved !== "string" || typeof dir.label !== "string") continue;
    const root = [...sourceParts(dir.resolved, platform), "projects"];
    if (parts.length <= root.length || !root.every((part, i) => same(part, parts[i]!))) continue;
    return { label: dir.label, parts: parts.slice(root.length) };
  }
  return undefined;
}

/**
 * Where a Claude Code transcript of the source machine is on this one: where
 * the backup's copy goes when the backup has it, else its folder's name
 * mapped. A transcript under a config directory the backup does not list
 * goes under this machine's default one, by the `projects/<folder>/<file>`
 * its path ends in. Undefined for a path that is not a transcript's.
 */
function claudeTranscriptHere(file: string, id: string, ctx: Context): string | undefined {
  if (!isSessionId(id)) return undefined;
  const listed = underSourceProjects(file, ctx.manifest);
  let label: string | undefined;
  let parts: string[];
  if (listed) {
    label = listed.label;
    parts = listed.parts;
  } else {
    const all = sourceParts(file, ctx.platform);
    if (all.length < 3 || all.at(-3) !== "projects") return undefined;
    parts = all.slice(-2);
  }
  if (parts.length !== 2 || parts[1] !== `${id}.jsonl`) return undefined;
  const folder = parts[0]!;
  if (!isFolderName(folder)) return undefined;
  const dir = claudeDirFor(label, ctx.targets);
  if (!dir) return undefined;
  const here = (label !== undefined ? ctx.placement.transcripts.get(sessionKey(label, folder, id)) : undefined) ?? mapFolderName(folder, ctx.mapping, ctx.platform);
  return here ? under(dir.root, [here, `${id}.jsonl`]) : undefined;
}

/** Where another agent's conversation file of the source machine is on this one: mapped, and inside the folder that agent keeps them in here. */
function agentFileHere(file: string, agent: string, map: Mapper, targets: RestoreTargets): string | undefined {
  const root = targets.agentRoots?.[agent];
  const mapped = map(file);
  if (!root || !mapped || !inside(root, mapped) || path.resolve(mapped) === path.resolve(root)) return undefined;
  const parts = path.relative(path.resolve(root), path.resolve(mapped)).split(path.sep);
  return parts.every(isSegment) ? path.resolve(mapped) : undefined;
}

/** Where a session's conversation file is on this machine, for the history and the kept transcripts. */
function conversationHere(file: string, id: string, agent: string, ctx: Context): string | undefined {
  if (agent === CLAUDE_AGENT) return claudeTranscriptHere(file, id, ctx);
  return agentFileHere(file, agent, ctx.map, ctx.targets);
}

interface Context {
  manifest: BundleManifest;
  targets: RestoreTargets;
  mapping: readonly PathMapping[];
  platform: NodeJS.Platform;
  /** A path mapped, or as it was where no mapping holds it. */
  map: Mapper;
  /** A path mapped only where a mapping holds it, for a folder a later click opens or makes. */
  cover: Mapper;
  placement: Placement;
}

function contextOf(manifest: BundleManifest, targets: RestoreTargets, mapping: readonly PathMapping[]): Context {
  const platform = manifest.source?.platform ?? "linux";
  const map: Mapper = (p) => mapPath(p, mapping, platform);
  const cover: Mapper = (p) => mapCovered(p, mapping, platform);
  return { manifest, targets, mapping, platform, map, cover, placement: placeClaudeFiles(manifest, targets, map, mapping, platform) };
}

/** A history session's place on this machine: its file and folder mapped; or why it has none. */
function historyPlace(session: HistorySession, ctx: Context): HistoryPlace | string {
  if (!ID.test(session.id) || !AGENT.test(session.agent)) return "its session id or agent is not one Lookout knows";
  let file: string | undefined;
  if (session.agent === CLAUDE_AGENT) {
    file = claudeTranscriptHere(session.file, session.id, ctx);
    if (!file) return "its file is not a transcript in a Claude Code projects folder";
  } else {
    if (!ctx.targets.agentRoots?.[session.agent]) return "Lookout does not know where its agent keeps conversations on this machine";
    file = agentFileHere(session.file, session.agent, ctx.map, ctx.targets);
    if (!file) return "its file is outside the folder where its agent keeps conversations";
  }
  const cwd = session.cwd === "" ? "" : ctx.map(session.cwd);
  return cwd === undefined ? "the folder it worked in is not a full path" : { file, cwd };
}

/** A history session in a refusal. */
function conversationName(session: HistorySession): string {
  return ID.test(session.id) ? `conversation ${session.id}` : "a conversation";
}

// ---------------------------------------------------------------------------
// Notes

/** A record from the backup, cleaned: its notes as the note page keeps them, the newest of them up to the most a session takes, its folder mapped. None when nothing in it parses. */
function cleanRecord(raw: unknown, map: Mapper): SessionRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id) || typeof r.agent !== "string" || !AGENT.test(r.agent)) return undefined;
  const record: SessionRecord = { v: 1, id: r.id, agent: r.agent };
  if (typeof r.title === "string") record.title = r.title.replace(/[\p{Cc}]/gu, " ").slice(0, 500);
  const cwd = typeof r.cwd === "string" ? map(r.cwd) : undefined;
  if (cwd !== undefined) record.cwd = cwd;
  if (typeof r.branch === "string") record.branch = r.branch.replace(/[\p{Cc}]/gu, "").slice(0, 255);
  if (typeof r.modifiedAt === "number" && Number.isFinite(r.modifiedAt)) record.modifiedAt = r.modifiedAt;
  const notes: NoteEntry[] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(r.notes) ? r.notes : []) {
    const n = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof n.id !== "string" || !NOTE_ID.test(n.id) || ids.has(n.id) || typeof n.at !== "number" || !Number.isFinite(n.at)) continue;
    const text = cleanNote(typeof n.text === "string" ? n.text : undefined);
    if (text === undefined) continue;
    ids.add(n.id);
    const entry: NoteEntry = { id: n.id, text, at: n.at };
    if (typeof n.editedAt === "number" && Number.isFinite(n.editedAt)) entry.editedAt = n.editedAt;
    notes.push(entry);
  }
  if (notes.length === 0) return undefined;
  notes.sort((a, b) => a.at - b.at);
  record.notes = notes.length > NOTES_PER_SESSION ? notes.slice(-NOTES_PER_SESSION) : notes;
  return record;
}

/**
 * The backup's notes on a session merged into this machine's: a note whose
 * id is not here and whose text is not here either is added, and of one
 * note on both the later edit wins. Undefined when nothing changes.
 */
function mergeRecord(here: SessionRecord, theirs: SessionRecord): SessionRecord | undefined {
  const notes = [...(here.notes ?? [])];
  const byId = new Map<string, number>();
  notes.forEach((note, i) => {
    if (!byId.has(note.id)) byId.set(note.id, i);
  });
  // How many notes hold each text, as notes are replaced and added.
  const texts = new Map<string, number>();
  const count = (text: string, by: number) => texts.set(text, (texts.get(text) ?? 0) + by);
  for (const note of notes) count(note.text, 1);
  let changed = false;
  for (const note of theirs.notes ?? []) {
    const i = byId.get(note.id);
    if (i !== undefined) {
      const mine = notes[i]!;
      if (note.text !== mine.text && (note.editedAt ?? note.at) > (mine.editedAt ?? mine.at)) {
        count(mine.text, -1);
        count(note.text, 1);
        notes[i] = note;
        changed = true;
      }
      continue;
    }
    if ((texts.get(note.text) ?? 0) > 0) continue;
    byId.set(note.id, notes.length);
    count(note.text, 1);
    notes.push(note);
    changed = true;
  }
  if (!changed) return undefined;
  const record: SessionRecord = { ...here, notes: notes.sort((a, b) => a.at - b.at) };
  if (record.cwd === undefined && theirs.cwd !== undefined) record.cwd = theirs.cwd;
  return record;
}

interface NoteMerge {
  write: { record: SessionRecord; replaces: boolean }[];
  counts: NoteCounts;
}

function mergeNotes(manifest: BundleManifest, targets: RestoreTargets, map: Mapper): NoteMerge {
  const out: NoteMerge = { write: [], counts: { added: 0, merged: 0, unchanged: 0, skipped: 0 } };
  const records = new SessionRecords(targets.recordsDir);
  const all = Array.isArray(manifest.notes) ? manifest.notes : [];
  // Past the most a backup brings, records are not looked at.
  out.counts.skipped = Math.max(0, all.length - NOTE_RECORDS_MAX);
  const seen = new Set<string>();
  for (const raw of all.slice(0, NOTE_RECORDS_MAX)) {
    const theirs = cleanRecord(raw, map);
    if (!theirs || seen.has(theirs.id)) {
      out.counts.skipped++;
      continue;
    }
    seen.add(theirs.id);
    const here = records.get(theirs.id);
    if (!here) {
      out.write.push({ record: theirs, replaces: false });
      out.counts.added++;
      continue;
    }
    const merged = mergeRecord(here, theirs);
    if (!merged) {
      out.counts.unchanged++;
      continue;
    }
    out.write.push({ record: merged, replaces: true });
    out.counts.merged++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Light state

interface StateChange {
  key: LightStateKey;
  value: unknown;
  taken: boolean;
}

/** Session ids as the board reads a list of them. */
function idList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

/** A list of ids from the backup: those that are ids, each once, at most `max`. */
function theirIds(raw: unknown, max: number): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set<string>();
  for (const id of raw) {
    if (out.length >= max) break;
    if (typeof id !== "string" || !LIST_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** `mine`, then what `theirs` has that `mine` has not, in its order, until there are `max`; `mine` stays whole. */
function union(mine: readonly string[], theirs: readonly string[], max: number): string[] {
  const out = [...mine];
  const have = new Set(mine);
  for (const id of theirs) {
    if (out.length >= max) break;
    if (have.has(id)) continue;
    have.add(id);
    out.push(id);
  }
  return out;
}

/** The account names as the board reads them: organization → the key of an address, at most as many as a backup brings; anything else dropped. */
function orgMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  let n = 0;
  for (const [org, key] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= ORGS_MAX) break;
    if (!ID.test(org) || typeof key !== "string" || key.length > 256) continue;
    out[org] = key;
    n++;
  }
  return out;
}

/**
 * The backup's light state merged into this machine's: favourites and the
 * archive are unions with this machine's first, parking a union per list,
 * the sort and the grouping taken only when this machine has none, and the
 * account names a union where this machine's win. What the backup brings
 * is capped: a list grows to its most at the outside, never by dropping
 * what is here.
 */
function mergeState(theirs: Partial<Record<LightStateKey, unknown>>, here: StateStore): StateChange[] {
  const out: StateChange[] = [];
  const backup = typeof theirs === "object" && theirs !== null ? theirs : {};
  for (const key of [FAVOURITES, ARCHIVE]) {
    const mine = idList(here.get(key));
    const next = union(mine, theirIds(backup[key], LIST_MAX), LIST_MAX);
    if (next.length > mine.length) out.push({ key, value: next, taken: mine.length === 0 });
  }
  if (backup[PARKING] !== undefined) {
    const raw = here.get(PARKING);
    const mine = readParking(raw);
    const other = readParking(backup[PARKING]);
    const next = { parked: union(mine.parked, theirIds(other.parked, PARKING_MAX), PARKING_MAX), kept: union(mine.kept, theirIds(other.kept, PARKING_MAX), PARKING_MAX) };
    if (next.parked.length > mine.parked.length || next.kept.length > mine.kept.length) out.push({ key: PARKING, value: next, taken: raw === undefined });
  }
  const sort = backup[SORT] as { by?: unknown } | undefined;
  if (here.get(SORT) === undefined && typeof sort === "object" && sort !== null && isSortKey(sort.by)) out.push({ key: SORT, value: readSort(sort), taken: true });
  if (here.get(GROUP) === undefined && isGroupBy(backup[GROUP])) out.push({ key: GROUP, value: backup[GROUP], taken: true });
  const orgs = orgMap(backup[CLAUDE_ORGS]);
  const rawOrgs = here.get(CLAUDE_ORGS);
  const mineOrgs = typeof rawOrgs === "object" && rawOrgs !== null && !Array.isArray(rawOrgs) ? (rawOrgs as Record<string, unknown>) : {};
  const room = Math.max(0, ORGS_MAX - Object.keys(mineOrgs).length);
  const newOrgs = Object.keys(orgs)
    .filter((org) => !Object.hasOwn(mineOrgs, org))
    .slice(0, room);
  if (newOrgs.length) out.push({ key: CLAUDE_ORGS, value: { ...Object.fromEntries(newOrgs.map((org) => [org, orgs[org]])), ...mineOrgs }, taken: Object.keys(mineOrgs).length === 0 });
  return out;
}

function stateCounts(changes: readonly StateChange[]): StateCounts {
  return { taken: changes.filter((c) => c.taken).map((c) => c.key), merged: changes.filter((c) => !c.taken).map((c) => c.key) };
}

// ---------------------------------------------------------------------------
// Open tabs

/** A title from the backup, as a tab keeps it: plain text on one line. */
function cleanTitle(title: unknown): string {
  return typeof title === "string" ? plainText(title.replace(/[\p{Cc}]/gu, " ")) : "";
}

/** A tab's key among those a backup queued. */
function tabKey(from: string, madeAt: number, id: string): string {
  return `${from}\0${madeAt}\0${id.toLowerCase()}`;
}

/** Whether a session's transcript is on this machine: under the folder named after where it works, else anywhere in the Claude Code folders, all of them listed once when first needed. */
function transcriptsHere(dirs: readonly { resolved: string }[]): (id: string, cwd: string) => boolean {
  let all: Set<string> | undefined;
  const list = () => {
    const out = new Set<string>();
    for (const dir of dirs) {
      const projects = path.join(dir.resolved, "projects");
      let folders: string[];
      try {
        folders = fs.readdirSync(projects);
      } catch {
        continue;
      }
      for (const folder of folders) {
        let names: string[];
        try {
          names = fs.readdirSync(path.join(projects, folder));
        } catch {
          continue;
        }
        for (const name of names) if (name.endsWith(".jsonl")) out.add(name.slice(0, -".jsonl".length).toLowerCase());
      }
    }
    return out;
  };
  return (id, cwd) => {
    for (const dir of dirs) if (fs.existsSync(path.join(dir.resolved, "projects", encodeProjectDir(cwd), `${id}.jsonl`))) return true;
    all ??= list();
    return all.has(id.toLowerCase());
  };
}

interface TabMerge {
  /** The pending tabs, when any are added. */
  next?: unknown[];
  /** The tabs remembered as queued by a backup, when this one adds to them. */
  remembered?: string[];
  counts: TabCounts;
}

/**
 * The backup's open tabs as tabs waiting to reopen here, each under its
 * window's first folder, mapped only where a mapping covers it: a tab
 * already waiting, one this backup queued when it was restored before,
 * and one whose session's transcript will not be here (`here`) are left
 * out.
 */
function mergeTabs(manifest: BundleManifest, ctx: Context, here: (id: string, cwd: string) => boolean): TabMerge {
  const state = ctx.targets.state;
  const counts = tabCounts();
  const raw = state.get(PENDING_TABS_KEY);
  const existing = Array.isArray(raw) ? raw : [];
  const ids = new Set(
    existing
      .map((tab) => (typeof tab === "object" && tab !== null ? (tab as { sessionId?: unknown }).sessionId : undefined))
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.toLowerCase()),
  );
  const rememberedRaw = state.get(RESTORED_TABS_KEY);
  const remembered = Array.isArray(rememberedRaw) ? rememberedRaw.filter((key): key is string => typeof key === "string") : [];
  const queued = new Set(remembered);
  const noted: string[] = [];
  const added: PendingTab[] = [];
  const from = hostName(manifest);
  const madeAt = typeof manifest.createdAt === "number" && Number.isFinite(manifest.createdAt) ? manifest.createdAt : 0;
  for (const win of Array.isArray(manifest.tabs) ? manifest.tabs : []) {
    const tabs: unknown[] = Array.isArray(win?.tabs) ? win.tabs : [];
    const first = Array.isArray(win?.folders) ? win.folders[0] : undefined;
    const cwd = typeof first === "string" ? ctx.cover(first) : undefined;
    for (const item of tabs) {
      const tab = (typeof item === "object" && item !== null ? item : {}) as { sessionId?: unknown; title?: unknown };
      if (typeof first !== "string" || !isSessionId(tab.sessionId)) {
        counts.skipped++;
        continue;
      }
      if (!cwd) {
        counts.refused++;
        continue;
      }
      const key = tabKey(from, madeAt, tab.sessionId);
      if (ids.has(tab.sessionId.toLowerCase())) {
        counts.present++;
        if (!queued.has(key)) {
          queued.add(key);
          noted.push(key);
        }
        continue;
      }
      if (queued.has(key)) {
        counts.earlier++;
        continue;
      }
      if (!here(tab.sessionId, cwd)) {
        counts.gone++;
        continue;
      }
      ids.add(tab.sessionId.toLowerCase());
      queued.add(key);
      noted.push(key);
      added.push({ sessionId: tab.sessionId, title: cleanTitle(tab.title), cwd, from, madeAt });
      counts.added++;
    }
  }
  const out: TabMerge = { counts };
  if (added.length) out.next = [...existing, ...added];
  if (noted.length) out.remembered = [...remembered, ...noted].slice(-RESTORED_TABS_MAX);
  return out;
}

// ---------------------------------------------------------------------------
// Backups restored before

function manifestHash(manifest: BundleManifest): string {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function readRestored(raw: unknown): RestoredBackup[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is RestoredBackup => typeof r === "object" && r !== null && typeof r.host === "string" && typeof r.createdAt === "number" && typeof r.manifest === "string" && typeof r.at === "number",
  );
}

/** When this backup was last restored here, if it was. */
function restoredBefore(manifest: BundleManifest, hash: string, state: StateStore): number | undefined {
  const host = hostName(manifest);
  const times = readRestored(state.get(RESTORED_BACKUPS_KEY))
    .filter((r) => r.host === host && r.createdAt === manifest.createdAt && r.manifest === hash)
    .map((r) => r.at);
  return times.length ? Math.max(...times) : undefined;
}

/** Remembers that this backup was restored now. */
async function rememberRestored(manifest: BundleManifest, hash: string, state: StateStore, now: number): Promise<void> {
  const host = hostName(manifest);
  const others = readRestored(state.get(RESTORED_BACKUPS_KEY)).filter((r) => !(r.host === host && r.createdAt === manifest.createdAt && r.manifest === hash));
  await state.update(RESTORED_BACKUPS_KEY, [...others, { host, createdAt: manifest.createdAt, manifest: hash, at: now }].slice(-RESTORED_BACKUPS_MAX));
}

// ---------------------------------------------------------------------------
// The removed-worktrees log

/** A removal from the backup, its repository and folder mapped only where a mapping covers them: a click puts the worktree back there. */
function cleanRemoved(raw: unknown, cover: Mapper): RemovedRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.removedAt !== "number" || !Number.isFinite(r.removedAt)) return undefined;
  const repo = cover(r.repo);
  const where = cover(r.path);
  if (!repo || !where) return undefined;
  const record: RemovedRecord = { repo, path: where, removedAt: r.removedAt };
  if (typeof r.branch === "string" && r.branch !== "" && !/[\p{Cc}\s]/u.test(r.branch)) record.branch = r.branch;
  if (typeof r.head === "string" && /^[0-9a-f]{7,64}$/i.test(r.head)) record.head = r.head;
  if (r.branchDeleted === true) record.branchDeleted = true;
  return record;
}

/** The log here as it is on disk: every record that parses, out of reach or not. */
function readRemoved(file: string): RemovedRecord[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter((r): r is RemovedRecord => typeof r === "object" && r !== null && typeof r.repo === "string" && typeof r.path === "string" && typeof r.removedAt === "number");
}

/** The backup's removals added to this machine's log, those still in reach and not there yet (the same folder at the same time), newest first; how many; and how many were refused. */
function mergeRemoved(mine: readonly RemovedRecord[], theirs: unknown, cover: Mapper, now: number): { next?: RemovedRecord[]; added: number; refused: number } | undefined {
  if (!Array.isArray(theirs)) return undefined;
  const have = new Set(mine.map((r) => `${r.path}\0${r.removedAt}`));
  const added: RemovedRecord[] = [];
  let refused = 0;
  for (const raw of theirs) {
    const record = cleanRemoved(raw, cover);
    if (!record) {
      refused++;
      continue;
    }
    if (now - record.removedAt >= RESTORE_DAYS * DAY_MS) continue;
    const key = `${record.path}\0${record.removedAt}`;
    if (have.has(key)) continue;
    have.add(key);
    added.push(record);
  }
  if (!added.length) return { added: 0, refused };
  return { next: [...mine, ...added].sort((a, b) => b.removedAt - a.removedAt).slice(0, REMOVED_MAX), added: added.length, refused };
}

// ---------------------------------------------------------------------------
// The plan

/** The folders the backup's sessions worked in that the mapping puts where nothing is on this machine. */
function missingFolders(manifest: BundleManifest, map: Mapper, history: readonly HistorySession[]): MissingFolder[] {
  const counts = new Map<string, { to: string; sessions: Set<string> }>();
  const note = (from: unknown, session: string) => {
    if (typeof from !== "string" || from === "") return;
    const to = map(from);
    if (!to) return;
    let entry = counts.get(from);
    if (!entry) {
      entry = { to, sessions: new Set() };
      counts.set(from, entry);
    }
    entry.sessions.add(session);
  };
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) if (entry?.kind === "transcript" && typeof entry.sessionId === "string") note(entry.cwd, entry.sessionId);
  for (const record of Array.isArray(manifest.notes) ? manifest.notes : []) if (typeof record?.id === "string") note(record.cwd, record.id);
  for (const win of Array.isArray(manifest.tabs) ? manifest.tabs : []) {
    const first = Array.isArray(win?.folders) ? win.folders[0] : undefined;
    for (const tab of Array.isArray(win?.tabs) ? win.tabs : []) if (typeof tab?.sessionId === "string") note(first, tab.sessionId);
  }
  for (const session of history) note(session.cwd, session.id);
  const out: MissingFolder[] = [];
  for (const [from, entry] of counts) if (!fs.existsSync(entry.to)) out.push({ from, to: entry.to, sessions: entry.sessions.size });
  return out.sort((a, b) => b.sessions - a.sessions || a.to.localeCompare(b.to));
}

/** The sha256 of a file's first `limit` bytes (of all of them without one), with how many were read told to `onBytes`. */
async function hashFile(file: string, onBytes?: (n: number) => void, limit?: number): Promise<string> {
  const hash = crypto.createHash("sha256");
  if (limit === 0) return hash.digest("hex");
  for await (const chunk of fs.createReadStream(file, limit === undefined ? {} : { end: limit - 1 }) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    onBytes?.(chunk.length);
  }
  return hash.digest("hex");
}

/** This machine's files hashed for a plan, by path, size, time and how much was read: a plan made again with another mapping does not read them again. */
const planHashes = new WeakMap<RestoreTargets, Map<string, string>>();

type Look = "new" | "newer" | "same" | "kept" | "different" | "unsafe";

/** What a Claude Code file's place holds: nothing, a shorter file, the same bytes, a longer file starting with the backup's, a different one, or something not to write through. */
async function lookAt(placed: Placed, hashes: Map<string, string>): Promise<Look> {
  const lay = layOf(placed.root, placed.parts);
  if (lay !== "file") return lay === "missing" ? "new" : "unsafe";
  const st = await fs.promises.stat(placed.target);
  const size = placed.entry.size;
  if (st.size < size) return "newer";
  const key = `${placed.target}\0${st.size}\0${st.mtimeMs}\0${st.ino}\0${size}`;
  let sha256 = hashes.get(key);
  if (sha256 === undefined) {
    sha256 = await hashFile(placed.target, undefined, size);
    hashes.set(key, sha256);
  }
  if (sha256 !== placed.entry.sha256) return "different";
  return st.size === size ? "same" : "kept";
}

/** Whether a file the backup carries under `dir` would be new there. */
function vaultOrUsage(entry: BundleFile, dir: string, kind: "vault" | "usage"): "new" | "present" | "refused" {
  const parts = kind === "vault" ? (typeof entry.rel === "string" && VAULT_NAME.test(entry.rel) ? [entry.rel] : undefined) : segmentsOf(entry.rel);
  if (!parts || (kind === "usage" && !parts.every((part) => USAGE_NAME.test(part)))) return "refused";
  const lay = layOf(dir, parts);
  return lay === "missing" ? "new" : lay === "file" ? "present" : "refused";
}

/** How long Claude Code keeps transcripts in a config directory here. */
function retentionOf(targets: RestoreTargets, configDir: string): Retention {
  return targets.retention ? targets.retention(configDir) : readRetention(configDir, targets.folders ?? []);
}

/**
 * Of the files a restore writes into Claude Code's folders, with the times
 * they were last written on the source machine, those Claude Code deletes
 * at its next start: older than the transcripts its retention keeps in
 * their config directory. None when there are none, or while a retention
 * is unknown: Claude Code then deletes nothing.
 */
function retentionRisk(restoring: readonly Placed[], targets: RestoreTargets, now: number): RetentionRisk | undefined {
  const dirs = new Map<string, { label: string; retention: Retention; files: number }>();
  let risk: RetentionRisk | undefined;
  for (const placed of restoring) {
    let dir = dirs.get(placed.configDir);
    if (!dir) {
      dir = { label: placed.label, retention: retentionOf(targets, placed.configDir), files: 0 };
      dirs.set(placed.configDir, dir);
    }
    const days = dir.retention.days;
    const mtime = placed.entry.mtime;
    if (days === undefined || !Number.isFinite(mtime) || mtime >= now - days * DAY_MS) continue;
    risk ??= { files: 0, transcripts: 0, bytes: 0, oldest: mtime, oldestDays: 0, dirs: [] };
    risk.files++;
    if (placed.transcript) risk.transcripts++;
    risk.bytes += placed.entry.size;
    risk.oldest = Math.min(risk.oldest, mtime);
    dir.files++;
  }
  if (!risk) return undefined;
  risk.oldestDays = Math.ceil((now - risk.oldest) / DAY_MS);
  for (const [resolved, dir] of dirs) {
    if (!dir.files) continue;
    const entry: RetentionDir = { label: dir.label, resolved, days: dir.retention.days!, level: dir.retention.level, files: dir.files };
    if (dir.retention.file) entry.file = dir.retention.file;
    risk.dirs.push(entry);
  }
  return risk;
}

/**
 * What restoring the backup would do on this machine with this mapping.
 * This machine's Claude Code files of the same size as the backup's, or
 * longer, are hashed to tell the same from different; the restore checks
 * every one again before it writes. The history's sessions are counted
 * when the history was read ahead (`readBackupHistory`).
 */
export async function planRestore(manifest: BundleManifest, targets: RestoreTargets, mapping: readonly PathMapping[], history?: HistoryCopy): Promise<RestorePlan> {
  const now = (targets.now ?? Date.now)();
  const ctx = contextOf(manifest, targets, mapping);
  const notes = mergeNotes(manifest, targets, ctx.map);
  const plan: RestorePlan = {
    source: manifest.source,
    createdAt: manifest.createdAt,
    mapping: [...mapping],
    notes: notes.counts,
    state: stateCounts(mergeState(manifest.state, targets.state)),
    transcripts: fileCounts(),
    sessionFiles: fileCounts(),
    tabs: tabCounts(),
    vault: { added: 0, present: 0, bytes: 0 },
    usage: { added: 0, present: 0, bytes: 0 },
    worktreesLog: false,
    missingFolders: [],
    refused: [...ctx.placement.refused],
  };
  plan.transcripts.refused = ctx.placement.refusedCount.transcripts;
  plan.sessionFiles.refused = ctx.placement.refusedCount.sessionFiles;
  let hashes = planHashes.get(targets);
  if (!hashes) {
    hashes = new Map();
    planHashes.set(targets, hashes);
  }
  const arriving = new Set<string>();
  const sessions = new Set<string>();
  const restoring: Placed[] = [];
  for (const placed of ctx.placement.byKey.values()) {
    const counts = placed.transcript ? plan.transcripts : plan.sessionFiles;
    let look: Look;
    try {
      look = await lookAt(placed, hashes);
    } catch {
      counts.refused++;
      refuse(plan.refused, nameOf(placed.entry), "this machine's copy could not be read");
      continue;
    }
    if (look === "unsafe") {
      counts.refused++;
      refuse(plan.refused, nameOf(placed.entry), "a link or a folder is in its place");
      continue;
    }
    add(counts[look], placed.entry.size);
    if (look === "new" || look === "newer") restoring.push(placed);
    if (placed.transcript) {
      arriving.add(placed.target);
      sessions.add(placed.id.toLowerCase());
    }
  }
  const onDisk = transcriptsHere(targets.claudeDirs);
  plan.tabs = mergeTabs(manifest, ctx, (id, cwd) => sessions.has(id.toLowerCase()) || onDisk(id, cwd)).counts;
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    if (entry?.kind === "history" && !plan.history) {
      plan.history = { bytes: entry.size };
      if (!(entry.size <= HISTORY_MAX)) plan.history.failed = HISTORY_TOO_BIG;
    }
    if (entry?.kind === "removed-worktrees") plan.worktreesLog = true;
    if (entry?.kind === "usage") {
      const look = vaultOrUsage(entry, targets.usageDir, "usage");
      if (look === "refused") refuse(plan.refused, nameOf(entry), "its path is not one a backup writes");
      else if (look === "present") plan.usage.present++;
      else {
        plan.usage.added++;
        plan.usage.bytes += entry.size;
      }
    }
    if (entry?.kind === "vault" && typeof entry.rel === "string") {
      const transcript = entry.rel.endsWith(".jsonl");
      const look = vaultOrUsage(entry, targets.vaultDir, "vault");
      if (look === "refused") {
        if (transcript) refuse(plan.refused, nameOf(entry), "its path is not one a backup writes");
      } else if (look === "present") {
        if (transcript) plan.vault.present++;
      } else {
        if (transcript) plan.vault.added++;
        plan.vault.bytes += entry.size;
      }
    }
  }
  if (plan.history && !plan.history.failed && history) {
    plan.historyCopy = history;
    if (history.failed) plan.history.failed = history.failed;
    else {
      const counted = countHistory(history.sessions, ctx, arriving, plan.refused);
      plan.history.sessions = counted.sessions;
      if (counted.leftOut) plan.history.leftOut = counted.leftOut;
    }
  } else if (history) plan.historyCopy = history;
  plan.retention = retentionRisk(restoring, targets, now);
  plan.restoredBefore = restoredBefore(manifest, manifestHash(manifest), targets.state);
  plan.missingFolders = missingFolders(manifest, ctx.map, history?.sessions ?? []);
  return plan;
}

/**
 * How many of the history's sessions would go in: those whose transcript is
 * neither here nor arriving with the backup, and that this machine's
 * history does not know. And how many are left out, their file having no
 * place here, each added to `refused` with why.
 */
function countHistory(sessions: readonly HistorySession[], ctx: Context, arriving: ReadonlySet<string>, refused: Refusal[]): { sessions: number; leftOut: number } {
  const store = fs.existsSync(ctx.targets.storeFile) ? ConversationStore.open(ctx.targets.storeFile) : undefined;
  try {
    let count = 0;
    let leftOut = 0;
    const ids = new Set<string>();
    for (const session of sessions) {
      if (!session.held || ids.has(session.id)) continue;
      const place = historyPlace(session, ctx);
      if (typeof place === "string") {
        leftOut++;
        refuse(refused, conversationName(session), place);
        continue;
      }
      if (arriving.has(place.file) || fs.existsSync(place.file)) continue;
      if (store && (store.session(session.id) || store.has(place.file))) continue;
      ids.add(session.id);
      count++;
    }
    return { sessions: count, leftOut };
  } finally {
    store?.close();
  }
}

// ---------------------------------------------------------------------------
// Reading files out of the backup

/** Thrown to stop a pass through the payload once the file wanted is read. */
class Stop extends Error {}

/** Reads a stream to its end, keeping nothing. */
async function drain(data: Readable): Promise<void> {
  data.resume();
  await finished(data);
}

/** A file's bytes from the backup, written to `temp`: their size and sha256, and the sha256 of their first `head` bytes when asked. */
async function receive(data: Readable, temp: string, head?: number, onBytes?: (n: number) => void): Promise<{ size: number; sha256: string; head?: string }> {
  const whole = crypto.createHash("sha256");
  const start = head !== undefined ? crypto.createHash("sha256") : undefined;
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      whole.update(chunk);
      if (start && size < head!) start.update(chunk.subarray(0, Math.min(chunk.length, head! - size)));
      size += chunk.length;
      onBytes?.(chunk.length);
      done(null, chunk);
    },
  });
  await pipeline(data, tap, fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }));
  return { size, sha256: whole.digest("hex"), head: start?.digest("hex") };
}

/** A file's bytes from the backup into memory, up to `max`; none past it, or when they do not match the entry's sha256. */
async function receiveSmall(data: Readable, entry: BundleFile, max = SMALL_MAX): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of data as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= max) chunks.push(chunk);
  }
  if (size > max) return undefined;
  const bytes = Buffer.concat(chunks);
  return crypto.createHash("sha256").update(bytes).digest("hex") === entry.sha256 ? bytes : undefined;
}

function tempName(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.restore`);
}

async function removeQuietly(file: string): Promise<void> {
  try {
    await fs.promises.rm(file, { force: true });
  } catch {
    // Gone already, or not ours to remove.
  }
}

/** Moves `temp` to `target` only while nothing is there: a link then the temp's removal, or a rename where the file system has no links. False when something is there, the temp left for the caller. */
async function placeNew(temp: string, target: string): Promise<boolean> {
  try {
    await fs.promises.link(temp, target);
    await removeQuietly(temp);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
  }
  try {
    await fs.promises.lstat(target);
    return false;
  } catch {
    await fs.promises.rename(temp, target);
    return true;
  }
}

/** Writes `text` to `file` whole: a temporary file moved into place. */
async function writeWhole(file: string, text: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = tempName(file);
  try {
    await fs.promises.writeFile(temp, text, { flag: "wx", mode: 0o600 });
    await fs.promises.rename(temp, file);
  } catch (error) {
    await removeQuietly(temp);
    throw error;
  }
}

/**
 * Removes the temporary folders restores left in `dir` more than a day ago,
 * as one stopped by the extension host's end leaves them. Only folders
 * named as a restore names them; a link is left alone.
 */
export function sweepRestoreTemp(dir: string, now: number = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const at = path.join(dir, name);
    try {
      const st = fs.lstatSync(at);
      if (st.isDirectory() && now - st.mtimeMs > DAY_MS) fs.rmSync(at, { recursive: true, force: true });
    } catch {
      // Gone meanwhile, or not ours to remove.
    }
  }
}

/** The backup's history entry, when it has one. */
function historyEntry(manifest: BundleManifest): BundleFile | undefined {
  return (Array.isArray(manifest.files) ? manifest.files : []).find((file) => file?.kind === "history");
}

/**
 * Reads the backup's history database out of the file ahead of the
 * restore, stopping once it is read, and the sessions it holds: for the
 * plan to count the sessions it would add. None when the backup has no
 * history; one that says why for a history larger than a restore takes.
 * The copy is the caller's to let go of (`dispose`), unless a restore
 * given the plan holding it does.
 */
export async function readBackupHistory(source: BundleSource, tempDir: string = os.tmpdir()): Promise<HistoryCopy | undefined> {
  const entry = historyEntry(source.manifest);
  if (!entry) return undefined;
  if (!(entry.size <= HISTORY_MAX)) return { file: "", sessions: [], failed: HISTORY_TOO_BIG, dispose: () => {} };
  const dir = await fs.promises.mkdtemp(path.join(tempDir, TEMP_PREFIX));
  const dispose = () => fs.rmSync(dir, { recursive: true, force: true });
  const file = path.join(dir, "history.sqlite");
  let ok = false;
  try {
    await source.forEachFile(
      async (_entry, data) => {
        const got = await receive(data, file);
        ok = got.sha256 === entry.sha256;
        throw new Stop();
      },
      (candidate) => keyOf(candidate) === keyOf(entry),
    );
  } catch (error) {
    // Once the history is read whole and checked, how the reader takes being stopped does not matter.
    if (!(error instanceof Stop) && !ok) {
      dispose();
      throw error;
    }
  }
  if (!ok) {
    dispose();
    return undefined;
  }
  const read = await readHistorySessions(file);
  return "failed" in read ? { file, sessions: [], failed: read.failed, dispose } : { file, sessions: read.sessions, dispose };
}

// ---------------------------------------------------------------------------
// Applying

/** Where what a restore replaces is copied first: a folder of its own under `restore-backups`, named after the time, made when first needed. */
class Safekeeping {
  private dir: string | undefined;

  constructor(
    private readonly root: string,
    private readonly now: number,
  ) {}

  get made(): string | undefined {
    return this.dir;
  }

  /** The restore's folder, `<yyyymmdd-hhmmss>` of the restore's start, with `-2`, `-3` after a name another restore took. */
  folder(): string {
    if (this.dir) return this.dir;
    fs.mkdirSync(this.root, { recursive: true });
    const d = new Date(this.now);
    const two = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    for (let n = 1; ; n++) {
      const dir = path.join(this.root, n === 1 ? stamp : `${stamp}-${n}`);
      try {
        fs.mkdirSync(dir);
        this.dir = dir;
        return dir;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  /** Where a copy goes, its folders made. */
  async place(parts: readonly string[]): Promise<string> {
    const dest = path.join(this.folder(), ...parts);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    return dest;
  }

  /** Keeps `file` as it is now: a hard link where the file system makes one, which costs nothing and holds the old bytes once the file is replaced, else a copy. */
  async keep(file: string, parts: readonly string[]): Promise<void> {
    const dest = await this.place(parts);
    try {
      await fs.promises.link(file, dest);
    } catch {
      await fs.promises.copyFile(file, dest, fs.constants.COPYFILE_EXCL);
      const st = await fs.promises.stat(file);
      await fs.promises.utimes(dest, st.atime, st.mtime);
    }
  }

  /** Lets go of a copy kept for nothing, and of the folders it leaves empty. */
  async drop(parts: readonly string[]): Promise<void> {
    if (!this.dir) return;
    let at = path.join(this.dir, ...parts);
    await removeQuietly(at);
    for (at = path.dirname(at); at !== this.dir && inside(this.dir, at); at = path.dirname(at)) {
      try {
        await fs.promises.rmdir(at);
      } catch {
        return;
      }
    }
  }

  /** Moves a file to its place under the restore's folder; a copy when the two are on different file systems. */
  async move(file: string, parts: readonly string[]): Promise<void> {
    const dest = await this.place(parts);
    try {
      await fs.promises.rename(file, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await fs.promises.copyFile(file, dest, fs.constants.COPYFILE_EXCL);
      const st = await fs.promises.stat(file);
      await fs.promises.utimes(dest, st.atime, st.mtime);
      await removeQuietly(file);
    }
  }
}

/** What to do with a Claude Code file, its bytes here looked at. */
type Decision = { kind: "write" } | { kind: "replace"; size: number; mtimeMs: number; sha256: string } | { kind: "same" } | { kind: "kept" } | { kind: "diverged" } | { kind: "unsafe" };

async function decide(placed: Placed, onBytes: (n: number) => void): Promise<Decision> {
  const lay = layOf(placed.root, placed.parts);
  if (lay === "missing") return { kind: "write" };
  if (lay === "unsafe") return { kind: "unsafe" };
  const st = await fs.promises.stat(placed.target);
  const size = placed.entry.size;
  if (st.size > size) return (await hashFile(placed.target, onBytes, size)) === placed.entry.sha256 ? { kind: "kept" } : { kind: "diverged" };
  const sha256 = await hashFile(placed.target, onBytes);
  if (st.size === size) return sha256 === placed.entry.sha256 ? { kind: "same" } : { kind: "diverged" };
  return { kind: "replace", size: st.size, mtimeMs: st.mtimeMs, sha256 };
}

export type RestoreProgress = (done: number, total: number) => void;

/**
 * Restores a backup on this machine as planned, with the plan's mapping.
 * The notes and the light state first, from the manifest; then one pass
 * through the file for Claude Code's files, the kept transcripts, the
 * usage records and the removed-worktrees log; then the open tabs whose
 * sessions' transcripts are here; then the history, for the sessions whose
 * transcript is still not on this machine. `progress` hears bytes looked
 * at of all there are; `signal` stops it between files, what was done
 * staying.
 */
export async function applyRestore(source: BundleSource, plan: RestorePlan, targets: RestoreTargets, progress?: RestoreProgress, signal?: AbortSignal): Promise<RestoreResult> {
  const manifest = source.manifest;
  if (manifest.createdAt !== plan.createdAt || manifest.source?.host !== plan.source?.host) throw new Error("The plan is for another backup.");
  const now = (targets.now ?? Date.now)();
  const ctx = contextOf(manifest, targets, plan.mapping);
  const keep = new Safekeeping(targets.backupsDir, now);
  const result: RestoreResult = {
    notes: { added: 0, merged: 0, unchanged: 0, skipped: 0 },
    state: { taken: [], merged: [] },
    transcripts: filesDone(),
    sessionFiles: filesDone(),
    historyLeftOut: 0,
    tabs: tabCounts(),
    vault: { added: 0, present: 0, skipped: 0 },
    usage: { added: 0, present: 0 },
    worktreesLog: { added: 0, refused: 0 },
    refused: [...ctx.placement.refused],
    failed: [],
    cancelled: false,
  };
  result.transcripts.refused = ctx.placement.refusedCount.transcripts;
  result.sessionFiles.refused = ctx.placement.refusedCount.sessionFiles;
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const payload = files.reduce((sum, entry) => sum + (Number.isFinite(entry?.size) ? entry.size : 0), 0);
  let hashing = 0;
  for (const placed of ctx.placement.byKey.values()) {
    try {
      hashing += Math.min(fs.lstatSync(placed.target).size, placed.entry.size);
    } catch {
      // Not here: nothing to look at.
    }
  }
  const total = payload + hashing;
  let hashed = 0;
  let streamed = 0;
  const tell = () => progress?.(Math.min(total, hashed + streamed), total);
  const read = (n: number) => {
    streamed += n;
    tell();
  };
  const stopped = () => signal?.aborted === true;
  let tempDir: string | undefined;
  const history = historyEntry(manifest);
  const historyTooBig = history !== undefined && !(history.size <= HISTORY_MAX);
  // The history read ahead for the plan, unless it was let go of meanwhile; read again on the pass then.
  const readAhead = plan.historyCopy && fs.existsSync(plan.historyCopy.file) ? plan.historyCopy : undefined;
  let historyFile = readAhead && !readAhead.failed ? readAhead.file : undefined;
  try {
    // From the manifest.
    const notes = mergeNotes(manifest, targets, ctx.map);
    result.notes = notes.counts;
    const records = new SessionRecords(targets.recordsDir);
    for (const { record, replaces } of notes.write) {
      const file = records.fileOf(record.id);
      try {
        if (replaces) await keep.keep(file, ["notes", path.basename(file)]);
        await writeWhole(file, JSON.stringify(record));
      } catch (error) {
        refuse(result.failed, "notes of a session", reasonOf(error));
      }
    }
    const changes = mergeState(manifest.state, targets.state);
    if (changes.length) {
      const before: Record<string, unknown> = {};
      for (const change of changes) before[change.key] = targets.state.get(change.key);
      if (Object.values(before).some((value) => value !== undefined)) await writeWhole(await keep.place(["state.json"]), JSON.stringify(before));
      for (const change of changes) await targets.state.update(change.key, change.value);
    }
    result.state = stateCounts(changes);

    // What to do with each Claude Code file, its bytes here looked at.
    const decisions = new Map<string, Decision>();
    for (const [key, placed] of ctx.placement.byKey) {
      if (stopped()) break;
      let decision: Decision;
      try {
        decision = await decide(placed, (n) => {
          hashed += n;
          tell();
        });
      } catch (error) {
        refuse(result.failed, nameOf(placed.entry), reasonOf(error));
        continue;
      }
      const done = placed.transcript ? result.transcripts : result.sessionFiles;
      if (decision.kind === "same") add(done.same, placed.entry.size);
      else if (decision.kind === "kept") add(done.kept, placed.entry.size);
      else if (decision.kind === "unsafe") {
        done.refused++;
        refuse(result.refused, nameOf(placed.entry), "a link or a folder is in its place");
      } else decisions.set(key, decision);
    }

    // One pass through the file.
    const vaultWritten = new Map<string, string>();
    const handlers = new Map<string, (entry: BundleFile, data: Readable) => Promise<void>>();
    for (const [key, decision] of decisions) {
      const placed = ctx.placement.byKey.get(key)!;
      handlers.set(key, (_entry, data) => writeClaudeFile(placed, decision, data, keep, result, read));
    }
    if (history && !readAhead && !historyTooBig) {
      handlers.set(keyOf(history), async (_entry, data) => {
        tempDir ??= await fs.promises.mkdtemp(path.join(targets.tempDir ?? os.tmpdir(), TEMP_PREFIX));
        const file = path.join(tempDir, "history.sqlite");
        const got = await receive(data, file, undefined, read);
        if (got.sha256 === history.sha256) historyFile = file;
        else refuse(result.failed, "history", "its bytes do not match the backup's record of them");
      });
    }
    for (const entry of files) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.kind === "vault") {
        const look = vaultOrUsage(entry, targets.vaultDir, "vault");
        if (look === "refused") {
          result.vault.skipped += entry.rel?.endsWith?.(".jsonl") ? 1 : 0;
          refuse(result.refused, nameOf(entry), "its path is not one a backup writes");
        } else if (look === "present") {
          if (entry.rel.endsWith(".jsonl")) result.vault.present++;
        } else handlers.set(keyOf(entry), (_entry, data) => writeVaultFile(entry, data, ctx, vaultWritten, result));
      } else if (entry.kind === "usage") {
        const look = vaultOrUsage(entry, targets.usageDir, "usage");
        if (look === "refused") refuse(result.refused, nameOf(entry), "its path is not one a backup writes");
        else if (look === "present") result.usage.present++;
        else handlers.set(keyOf(entry), (_entry, data) => writeUsageFile(entry, data, targets.usageDir, result));
      } else if (entry.kind === "removed-worktrees") {
        handlers.set(keyOf(entry), async (_entry, data) => {
          const bytes = await receiveSmall(data, entry);
          if (!bytes) return refuse(result.failed, nameOf(entry), "it is not the log a backup writes");
          await mergeRemovedLog(bytes, targets.removedWorktreesFile, ctx.cover, now, keep, result);
        });
      }
    }
    if (handlers.size && !stopped()) {
      const visited = new Set<string>();
      await source
        .forEachFile(
          async (entry, data) => {
            const key = keyOf(entry);
            const handler = handlers.get(key);
            streamed = Math.max(streamed, Number.isFinite(entry.offset) ? entry.offset : 0);
            tell();
            if (stopped()) {
              data.destroy();
              throw new Stop();
            }
            if (!handler || visited.has(key)) return drain(data);
            visited.add(key);
            await handler(entry, data);
          },
          (entry) => handlers.has(keyOf(entry)),
        )
        .catch((error: unknown) => {
          // Stopped on purpose: whatever the reader says of the stream let go of, the pass ends here.
          if (!(error instanceof Stop) && !stopped()) throw error;
        });
    }
    // A kept transcript whose record did not come or did not parse is no use without it.
    for (const [name, file] of vaultWritten) {
      if (fs.existsSync(path.join(targets.vaultDir, name.replace(/\.jsonl$/, ".json")))) {
        result.vault.added++;
        continue;
      }
      await removeQuietly(file);
      result.vault.skipped++;
    }

    // The open tabs whose session's transcript is on this machine now.
    const tabs = mergeTabs(manifest, ctx, transcriptsHere(targets.claudeDirs));
    if (tabs.next) await targets.state.update(PENDING_TABS_KEY, tabs.next);
    if (tabs.remembered) await targets.state.update(RESTORED_TABS_KEY, tabs.remembered);
    result.tabs = tabs.counts;
    if (stopped()) {
      result.cancelled = true;
      return result;
    }

    // The history: the sessions whose transcript is still not here.
    if (historyFile) {
      result.history = await mergeHistory(historyFile, targets.storeFile, {
        choose: (session) => {
          const place = historyPlace(session, ctx);
          if (typeof place === "string") {
            result.historyLeftOut++;
            refuse(result.refused, conversationName(session), place);
            return undefined;
          }
          return fs.existsSync(place.file) ? undefined : place;
        },
        mapPathKey: (key) => mapPathKey(key, ctx.mapping),
        snapshot: () => {
          try {
            return path.join(keep.folder(), "history.sqlite");
          } catch {
            return undefined;
          }
        },
        now,
      });
    } else if (history) {
      result.history = { added: 0, missing: [], extra: [], failed: historyTooBig ? HISTORY_TOO_BIG : (readAhead?.failed ?? "the history could not be read out of the backup") };
    }
    await rememberRestored(manifest, manifestHash(manifest), targets.state, now);
    progress?.(total, total);
    return result;
  } finally {
    result.backupDir = keep.made;
    if (result.transcripts.diverged.count + result.sessionFiles.diverged.count > 0 && keep.made) result.divergedDir = path.join(keep.made, "diverged");
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    plan.historyCopy?.dispose();
  }
}

function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC") return "the disk is full";
  if (code === "EACCES" || code === "EPERM") return "it may not be written there";
  return "it could not be written";
}

/** A Claude Code file's place for its copy under the restore's folder: its config directory's label, then its path under `projects`. */
function relativeParts(placed: Placed): string[] {
  return [isSegment(placed.label) ? placed.label : "claude", "projects", ...placed.parts];
}

/** Where the backup's copy of a file that differs here goes, under the restore's folder. */
function divergedParts(placed: Placed): string[] {
  return ["diverged", "claude", ...relativeParts(placed)];
}

/**
 * A Claude Code file from the backup: written where nothing is, or put in
 * place of this machine's when this machine's is the start of it. When
 * this machine's copy differs, or changes while the restore looks, it
 * stays, and the backup's copy goes under the restore's `diverged` folder.
 */
async function writeClaudeFile(placed: Placed, decision: Decision, data: Readable, keep: Safekeeping, result: RestoreResult, onBytes: (n: number) => void): Promise<void> {
  const done = placed.transcript ? result.transcripts : result.sessionFiles;
  const entry = placed.entry;
  let temp: string | undefined;
  try {
    if (decision.kind === "diverged") {
      const dest = await keep.place(divergedParts(placed));
      temp = tempName(dest);
      const got = await receive(data, temp, undefined, onBytes);
      if (got.size !== entry.size || got.sha256 !== entry.sha256) return refuse(result.failed, nameOf(entry), "its bytes do not match the backup's record of them");
      await setTime(temp, entry);
      await placeNew(temp, dest);
      add(done.diverged, entry.size);
      return;
    }
    if (!(await makeFolders(placed.root, placed.parts.slice(0, -1)))) {
      await drain(data);
      done.refused++;
      return refuse(result.refused, nameOf(entry), "a link or a file is among its folders");
    }
    temp = tempName(placed.target);
    const got = await receive(data, temp, decision.kind === "replace" ? decision.size : undefined, onBytes);
    if (got.size !== entry.size || got.sha256 !== entry.sha256) return refuse(result.failed, nameOf(entry), "its bytes do not match the backup's record of them");
    await setTime(temp, entry);
    const setAside = async () => {
      await keep.move(temp!, divergedParts(placed));
      temp = undefined;
      add(done.diverged, entry.size);
    };
    if (decision.kind === "write") {
      // Something that came to its place meanwhile stays.
      if (!(await placeNew(temp, placed.target))) return await setAside();
      temp = undefined;
      add(done.written, entry.size);
      return;
    }
    if (decision.kind !== "replace") return;
    // This machine's copy must be the start of the backup's.
    if (got.head !== decision.sha256 || layOf(placed.root, placed.parts) !== "file") return await setAside();
    // Kept before the last look, so that a session here writing to it between that look and the rename writes into the kept copy.
    const safety = ["claude", ...relativeParts(placed)];
    await keep.keep(placed.target, safety);
    const now = await fs.promises.stat(placed.target);
    if (now.size !== decision.size || now.mtimeMs !== decision.mtimeMs) {
      await keep.drop(safety);
      return await setAside();
    }
    await fs.promises.rename(temp, placed.target);
    temp = undefined;
    add(done.replaced, entry.size);
  } catch (error) {
    if (!data.readableEnded) await drain(data).catch(() => undefined);
    refuse(result.failed, nameOf(entry), reasonOf(error));
  } finally {
    if (temp) await removeQuietly(temp);
  }
}

/** Gives a file the time the backup has for it, which Claude Code's retention and the usage records go by. */
async function setTime(file: string, entry: BundleFile): Promise<void> {
  const mtime = Number.isFinite(entry.mtime) ? new Date(entry.mtime) : new Date();
  await fs.promises.utimes(file, mtime, mtime);
}

/** A kept transcript or its record, written when the vault has neither: the record's path mapped to where the agent keeps the transcript here. */
async function writeVaultFile(entry: BundleFile, data: Readable, ctx: Context, written: Map<string, string>, result: RestoreResult): Promise<void> {
  const dir = ctx.targets.vaultDir;
  const target = under(dir, [entry.rel])!;
  if (entry.rel.endsWith(".jsonl")) {
    await fs.promises.mkdir(dir, { recursive: true });
    const temp = tempName(target);
    try {
      const got = await receive(data, temp);
      if (got.sha256 !== entry.sha256) return refuse(result.failed, nameOf(entry), "its bytes do not match the backup's record of them");
      await setTime(temp, entry);
      if (await placeNew(temp, target)) written.set(entry.rel, target);
      else result.vault.present++;
    } catch (error) {
      if (!data.readableEnded) await drain(data).catch(() => undefined);
      refuse(result.failed, nameOf(entry), reasonOf(error));
    } finally {
      await removeQuietly(temp);
    }
    return;
  }
  const bytes = await receiveSmall(data, entry, 64 * 1024);
  const record = bytes ? vaultRecord(bytes, entry.rel, ctx) : undefined;
  if (!record) return refuse(result.refused, nameOf(entry), "it is not a kept transcript's record, or its transcript has no place here");
  const temp = tempName(target);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    await placeNew(temp, target);
  } catch (error) {
    refuse(result.failed, nameOf(entry), reasonOf(error));
  } finally {
    await removeQuietly(temp);
  }
}

/** A kept transcript's record from the backup, its transcript's path mapped to this machine; none when it does not parse or the path has no place here. */
function vaultRecord(bytes: Buffer, name: string, ctx: Context): Record<string, unknown> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (r.v !== 1 || typeof r.id !== "string" || !ID.test(r.id) || typeof r.agent !== "string" || !AGENT.test(r.agent) || typeof r.file !== "string" || typeof r.keptAt !== "number" || !Number.isFinite(r.keptAt)) return undefined;
  if (`${crypto.createHash("sha1").update(r.id).digest("hex")}.json` !== name) return undefined;
  const file = conversationHere(r.file, r.id, r.agent, ctx);
  if (!file) return undefined;
  return { v: 1, id: r.id, agent: r.agent, file, keptAt: r.keptAt, size: typeof r.size === "number" && Number.isFinite(r.size) ? r.size : 0, linked: false };
}

/** A usage record from the backup, written where the usage folder has none. */
async function writeUsageFile(entry: BundleFile, data: Readable, dir: string, result: RestoreResult): Promise<void> {
  const parts = segmentsOf(entry.rel)!;
  let temp: string | undefined;
  try {
    if (!(await makeFolders(dir, parts.slice(0, -1)))) {
      await drain(data);
      return refuse(result.refused, nameOf(entry), "a link or a file is among its folders");
    }
    const target = under(dir, parts)!;
    temp = tempName(target);
    const got = await receive(data, temp);
    if (got.sha256 !== entry.sha256) return refuse(result.failed, nameOf(entry), "its bytes do not match the backup's record of them");
    // The usage records are read by their times.
    await setTime(temp, entry);
    if (await placeNew(temp, target)) result.usage.added++;
    else result.usage.present++;
  } catch (error) {
    if (!data.readableEnded) await drain(data).catch(() => undefined);
    refuse(result.failed, nameOf(entry), reasonOf(error));
  } finally {
    if (temp) await removeQuietly(temp);
  }
}

/** The backup's removed-worktrees log merged into this machine's, the old log copied first. */
async function mergeRemovedLog(bytes: Buffer, file: string, cover: Mapper, now: number, keep: Safekeeping, result: RestoreResult): Promise<void> {
  let theirs: unknown;
  try {
    theirs = JSON.parse(bytes.toString("utf8"));
  } catch {
    return refuse(result.failed, "removed-worktrees log", "it is not the log a backup writes");
  }
  const mine = readRemoved(file);
  if (!mine) return refuse(result.failed, "removed-worktrees log", "this machine's log could not be read, so it was left as it is");
  const merged = mergeRemoved(mine, theirs, cover, now);
  if (!merged) return;
  result.worktreesLog.refused += merged.refused;
  if (merged.refused) refuse(result.refused, `${merged.refused} removed worktrees`, "their folders are outside the folder mapping, or their names are not ones a restore takes");
  if (!merged.next) return;
  try {
    if (fs.existsSync(file)) await keep.keep(file, ["worktrees", path.basename(file)]);
    await writeWhole(file, JSON.stringify(merged.next));
    result.worktreesLog.added += merged.added;
  } catch (error) {
    refuse(result.failed, "removed-worktrees log", reasonOf(error));
  }
}
