import * as fs from "node:fs";
import * as path from "node:path";
import { findLastLine, readLineAt } from "../../jsonlTail";
import { credentialOrgOf, INTERRUPT } from "./transcript";
import type { PastScope } from "../agent";
import { encodeProjectDir } from "./paths";

/** A session that is not running: its transcript is all there is. */
export interface PastTranscript {
  id: string;
  file: string;
  cwd: string;
  title: string;
  /** The git branch it last worked on. */
  branch?: string;
  /** The organization of the account it last ran on, as Claude Code stamped it. */
  organizationUuid?: string;
  /** It is one of the folders' sessions, which Claude Code resumes in their window. */
  resumable: boolean;
  /** Epoch ms the transcript was last written. */
  modifiedAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The generated title and the first prompt are within the first lines. */
const HEAD_BYTES = 64 * 1024;
/**
 * How far in the conversation's start is looked for when the head holds none
 * of it: Claude Code can write large request records first.
 */
const START_SEARCH_BYTES = 1024 * 1024;
/** Beyond the head, only lines with one of these are parsed: the request records are large and say nothing of use. */
const START_NEEDLES = ['"type":"user"', '"type":"ai-title"', '"type":"custom-title"', '"cwd":"'];
/** Titles are stamped again on resume, and renames appended, at the end. */
const TAIL_SEARCH_BYTES = 256 * 1024;
const PROMPT_MAX = 80;

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const entry: unknown = JSON.parse(line);
    return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function titleIn(entry: Record<string, unknown>, key: "customTitle" | "aiTitle"): string | undefined {
  const value = entry[key];
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() || undefined : undefined;
}

function promptIn(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) return undefined;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") return undefined;
  const text = content.trim();
  if (text === "" || text.startsWith("<") || text.startsWith(INTERRUPT)) return undefined;
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > PROMPT_MAX ? `${line.slice(0, PROMPT_MAX - 1)}…` : line;
}

/** Reads the whole lines within the first `bytes` of a transcript. */
function head(file: string, bytes: number): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const got = fs.readSync(fd, buffer, 0, bytes, 0);
    const lines = buffer.toString("utf8", 0, got).split("\n");
    if (got === bytes) lines.pop();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

/** What the list shows of a transcript, read once per file version. */
export interface TranscriptInfo {
  title?: string;
  /** Where the session started, from its first entries. */
  cwd?: string;
  /** The git branch it last worked on. */
  branch?: string;
  /** The organization of the account it last ran on: the latest `credential_org` stamp. */
  organizationUuid?: string;
}

function cwdIn(entry: Record<string, unknown>): string | undefined {
  return entry.isSidechain !== true && typeof entry.cwd === "string" && entry.cwd !== "" ? entry.cwd : undefined;
}

function branchIn(entry: Record<string, unknown>): string | undefined {
  return entry.isSidechain !== true && typeof entry.gitBranch === "string" && entry.gitBranch.trim() !== "" ? entry.gitBranch.trim() : undefined;
}

/** A transcript's title; see `transcriptInfo`. */
export function transcriptTitle(file: string): string | undefined {
  return transcriptInfo(file).title;
}

/**
 * A transcript's title, where it started, its git branch, and the
 * organization of the account it last ran on. The title is
 * a rename, else the generated title, else the first prompt; none for a
 * transcript that holds no conversation. The head is read for the early
 * stamps and the directory, further in when request records come first, and
 * the tail for the latest stamps and branch.
 */
export function transcriptInfo(file: string): TranscriptInfo {
  let custom: string | undefined;
  let ai: string | undefined;
  let prompt: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let organizationUuid: string | undefined;
  const take = (line: string) => {
    const entry = parse(line);
    if (!entry) return;
    organizationUuid = credentialOrgOf(entry) ?? organizationUuid;
    cwd ??= cwdIn(entry);
    branch = branchIn(entry) ?? branch;
    if (entry.type === "custom-title") custom = titleIn(entry, "customTitle") ?? custom;
    else if (entry.type === "ai-title") ai = titleIn(entry, "aiTitle") ?? ai;
    else if (prompt === undefined) prompt = promptIn(entry);
  };
  const first = head(file, HEAD_BYTES);
  for (const line of first) take(line);
  if (cwd === undefined || (custom === undefined && ai === undefined && prompt === undefined)) {
    // The conversation starts after request records: read on, past the lines already taken.
    for (const line of head(file, START_SEARCH_BYTES).slice(first.length)) if (START_NEEDLES.some((needle) => line.includes(needle))) take(line);
  }
  // The last main-chain entry's: subagents' entries carry a branch too.
  const lastBranch = findLastLine(file, '"gitBranch":"', TAIL_SEARCH_BYTES, (line) => {
    const entry = parse(line);
    return entry !== undefined && branchIn(entry) !== undefined;
  });
  const branchLine = lastBranch === undefined ? undefined : readLineAt(file, lastBranch);
  const branchEntry = branchLine === undefined ? undefined : parse(branchLine);
  if (branchEntry) branch = branchIn(branchEntry) ?? branch;
  for (const [type, key] of [
    ["custom-title", "customTitle"],
    ["ai-title", "aiTitle"],
  ] as const) {
    const at = findLastLine(file, `"type":"${type}"`, TAIL_SEARCH_BYTES);
    if (at === undefined) continue;
    const line = readLineAt(file, at);
    const entry = line === undefined ? undefined : parse(line);
    if (!entry || entry.type !== type) continue;
    const title = titleIn(entry, key);
    // The latest stamp wins, even when it clears a rename.
    if (key === "customTitle") custom = title;
    else if (title) ai = title;
  }
  // Stamped again at each resume: the latest in the tail, else the head's.
  const orgAt = findLastLine(file, '"type":"credential_org"', TAIL_SEARCH_BYTES);
  const orgLine = orgAt === undefined ? undefined : readLineAt(file, orgAt);
  const orgEntry = orgLine === undefined ? undefined : parse(orgLine);
  if (orgEntry) organizationUuid = credentialOrgOf(orgEntry) ?? organizationUuid;
  return { title: custom ?? ai ?? prompt, cwd, branch, ...(organizationUuid ? { organizationUuid } : {}) };
}

/** A transcript file found, before its contents are read. */
interface Candidate {
  id: string;
  file: string;
  /** The window's folder it belongs to, if any. */
  folder?: string;
  mtimeMs: number;
  size: number;
}

/** Every project's transcripts are found again at most this often. */
const SCAN_ALL_MS = 15_000;
/** Transcripts whose contents a list reads at most; the rest show in the next lists. */
const READS_PER_LIST = 120;

/**
 * The transcripts that are not running, with their titles, directories and
 * branches; each file's contents are read once per version.
 */
export class PastTranscripts {
  private readonly infos = new Map<string, { mtimeMs: number; size: number; info: TranscriptInfo }>();
  private scanned: { at: number; files: Candidate[] } | undefined;

  constructor(
    private readonly configDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The newest `limit` of the scope's transcripts, newest first, without the
   * ids in `exclude` (the live and the archived) and without transcripts that
   * hold no conversation. `capped` when older conversations were left out;
   * `incomplete` when transcripts were left unread for the next list. `also`:
   * the sessions of `scope.also` the list does not hold, wherever they ran.
   */
  list(scope: PastScope, exclude: ReadonlySet<string>): { transcripts: PastTranscript[]; capped: boolean; incomplete: boolean; also: PastTranscript[] } {
    const seen = new Set<string>();
    // The window's own folders first, as their window resumes them: Claude Code keeps a folder's transcripts in the project
    // directory named after it, found here as the file system names it (without regard to case where it has none).
    const found = scope.all ? [...this.inFolders(scope.folders), ...this.everywhere()] : this.inFolders(scope.folders);
    const candidates = found
      .filter((candidate) => !exclude.has(candidate.id) && !seen.has(candidate.id) && seen.add(candidate.id) !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: PastTranscript[] = [];
    const stale = (candidate: Candidate) => {
      const cached = this.infos.get(candidate.file);
      return !cached || cached.mtimeMs !== candidate.mtimeMs || cached.size !== candidate.size;
    };
    let reads = 0;
    let unread = 0;
    let next = 0;
    // Transcripts without a conversation do not count toward the limit.
    for (; next < candidates.length && out.length < scope.limit; next++) {
      const candidate = candidates[next]!;
      // A long history is read a slice at a time; what is left shows in the next lists.
      if (stale(candidate) && reads++ >= READS_PER_LIST) {
        unread++;
        continue;
      }
      const listed = this.listed(candidate);
      if (listed) out.push(listed);
    }
    // Older ones left out: one not read yet, or one read that holds a conversation.
    const capped = candidates.slice(next).some((candidate) => stale(candidate) || this.infos.get(candidate.file)?.info.title !== undefined);
    // Sessions asked for by id besides, wherever they ran: the window's folders first, then every project.
    const shown = new Set(out.map((transcript) => transcript.id));
    const wanted = (scope.also ?? []).filter((id) => !shown.has(id) && !exclude.has(id));
    const also: PastTranscript[] = [];
    if (wanted.length > 0) {
      const byId = new Map<string, Candidate>();
      for (const candidate of [...found, ...(scope.all ? [] : this.everywhere())]) if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
      for (const id of wanted) {
        const candidate = byId.get(id);
        const listed = candidate && this.listed(candidate);
        if (listed) also.push(listed);
      }
    }
    return { transcripts: out, capped, incomplete: unread > 0, also };
  }

  /** A transcript as the list shows it, its contents read once per file version; none when it holds no conversation. */
  private listed(candidate: Candidate): PastTranscript | undefined {
    let cached = this.infos.get(candidate.file);
    if (!cached || cached.mtimeMs !== candidate.mtimeMs || cached.size !== candidate.size) {
      let info: TranscriptInfo;
      try {
        info = transcriptInfo(candidate.file);
      } catch {
        info = {};
      }
      cached = { mtimeMs: candidate.mtimeMs, size: candidate.size, info };
      this.infos.set(candidate.file, cached);
    }
    const { title, cwd, branch, organizationUuid } = cached.info;
    if (!title) return undefined;
    // Where it started, as it says: two folders can share a project directory ("my.app" and "my-app").
    return { id: candidate.id, file: candidate.file, cwd: cwd ?? candidate.folder ?? "", title, branch, ...(organizationUuid ? { organizationUuid } : {}), resumable: candidate.folder !== undefined, modifiedAt: Math.round(candidate.mtimeMs) };
  }

  private transcriptsIn(dir: string, folder: string | undefined, into: Candidate[]): void {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!UUID.test(id)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 0) into.push({ id, file, folder, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Gone meanwhile.
      }
    }
  }

  private inFolders(folders: readonly string[]): Candidate[] {
    const out: Candidate[] = [];
    for (const folder of folders) this.transcriptsIn(path.join(this.configDir, "projects", encodeProjectDir(folder)), folder, out);
    return out;
  }

  /** Every project's transcripts, found again at most every 15 seconds. */
  private everywhere(): Candidate[] {
    const now = this.now();
    if (this.scanned && now - this.scanned.at < SCAN_ALL_MS) return this.scanned.files;
    const root = path.join(this.configDir, "projects");
    const files: Candidate[] = [];
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      // No projects yet.
    }
    for (const dir of dirs) this.transcriptsIn(path.join(root, dir), undefined, files);
    this.scanned = { at: now, files };
    return files;
  }
}
