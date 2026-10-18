import * as fs from "node:fs";
import * as path from "node:path";
import { quoteAsk } from "../../asks";
import { within } from "../../folders";
import { readLineAt } from "../../jsonlTail";
import type { PastScope } from "../agent";
import { rolloutId, type ThreadNames } from "./paths";
import { isContext } from "./rollout";
import { metaOf } from "./rollouts";

/** The sessions tree is looked through again at most this often. */
const SCAN_MS = 15_000;
/** A list reads at most this many rollouts it has not read yet; the next list goes on. */
const READS_PER_LIST = 120;
/** The first prompt sits after Codex's context, within the first few records. */
const PROMPT_SEARCH_BYTES = 512 * 1024;
const META_MAX_BYTES = 4 * 1024 * 1024;
const TITLE_MAX = 60;

interface Candidate {
  id: string;
  file: string;
  mtimeMs: number;
}

interface Read {
  cwd?: string;
  originator?: string;
  /** The first prompt, for a thread Codex has not named. */
  prompt?: string;
}

/** A thread that is not running, as the Earlier list shows it. */
export interface PastRollout {
  id: string;
  file: string;
  cwd: string;
  title: string;
  /** It worked in one of the window's folders. */
  inFolders: boolean;
  modifiedAt: number;
  /** Who wrote it (`session_meta.originator`): `codex_vscode` for the VS Code extension's threads. */
  originator?: string;
}

export { within };

/** The first thing you wrote in a rollout: the first user message after Codex's own context. */
export function firstPromptOf(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(PROMPT_SEARCH_BYTES);
    const got = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, got).toString("utf8").split("\n")) {
      if (!line.includes('"role":"user"')) continue;
      try {
        const payload = (JSON.parse(line) as { payload?: { type?: unknown; role?: unknown; content?: { type?: unknown; text?: unknown }[] } }).payload;
        if (payload?.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) continue;
        const text = payload.content.map((part) => (part?.type === "input_text" && typeof part.text === "string" ? part.text : "")).join("\n").trim();
        if (text && !isContext(text)) return text;
      } catch {
        // Cut off at the end of the buffer.
      }
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Codex's threads that are not running, from the sessions tree: those of the
 * window's folders or of every project, newest first. A rollout's folder is
 * in its first line, read once per file. Compressed rollouts
 * (`.jsonl.zst`) are counted, not read: Lookout carries no decompressor.
 */
export class PastRollouts {
  private readonly reads = new Map<string, Read>();
  private scanned: { at: number; files: Candidate[]; compressed: number } | undefined;

  constructor(
    private readonly dir: string,
    private readonly names: ThreadNames,
    private readonly now: () => number = Date.now,
  ) {}

  list(scope: PastScope, exclude: ReadonlySet<string>): { rollouts: PastRollout[]; capped: boolean; incomplete: boolean; also: PastRollout[]; compressed: number } {
    const { files, compressed } = this.scan();
    const candidates = files.filter((c) => !exclude.has(c.id)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: PastRollout[] = [];
    let reads = 0;
    let unread = 0;
    let next = 0;
    for (; next < candidates.length && out.length < scope.limit; next++) {
      const candidate = candidates[next]!;
      if (!this.reads.has(candidate.file) && reads++ >= READS_PER_LIST) {
        unread++;
        continue;
      }
      const listed = this.listed(candidate, scope.folders);
      if (listed && (scope.all || listed.inFolders)) out.push(listed);
    }
    // Older ones left out: one not read yet, or one read that the scope holds.
    const capped = candidates.slice(next).some((c) => {
      const read = this.reads.get(c.file);
      return !read || (read.cwd !== undefined && (scope.all || within(read.cwd, scope.folders)));
    });
    const shown = new Set(out.map((r) => r.id));
    const also: PastRollout[] = [];
    for (const id of scope.also ?? []) {
      if (shown.has(id) || exclude.has(id)) continue;
      const candidate = files.find((c) => c.id === id);
      const listed = candidate && this.listed(candidate, scope.folders);
      if (listed) also.push(listed);
    }
    return { rollouts: out, capped, incomplete: unread > 0, also, compressed };
  }

  /** A rollout's file by thread id, among those found. */
  fileOf(id: string): string | undefined {
    return this.scanned?.files.find((c) => c.id === id)?.file;
  }

  private listed(candidate: Candidate, folders: readonly string[]): PastRollout | undefined {
    let read = this.reads.get(candidate.file);
    if (!read) {
      const meta = metaOf(readLineAt(candidate.file, 0, META_MAX_BYTES), candidate.file);
      read = { cwd: meta?.cwd, originator: meta?.originator, prompt: this.names.get(candidate.id) ? undefined : firstPromptOf(candidate.file) };
      this.reads.set(candidate.file, read);
    }
    const name = this.names.get(candidate.id);
    const title = name ?? (read.prompt ? quoteAsk(read.prompt, TITLE_MAX) : undefined);
    // No title: nothing was ever sent in it.
    if (!title) return undefined;
    const cwd = read.cwd ?? "";
    return { id: candidate.id, file: candidate.file, cwd, title, inFolders: cwd !== "" && within(cwd, folders), modifiedAt: Math.round(candidate.mtimeMs), ...(read.originator ? { originator: read.originator } : {}) };
  }

  /** Every rollout in the tree, found again at most every 15 seconds. */
  private scan(): { files: Candidate[]; compressed: number } {
    const now = this.now();
    if (this.scanned && now - this.scanned.at < SCAN_MS) return this.scanned;
    const files: Candidate[] = [];
    let compressed = 0;
    const visit = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 3) visit(full, depth + 1);
          continue;
        }
        if (entry.name.endsWith(".jsonl.zst")) {
          compressed++;
          continue;
        }
        const id = rolloutId(entry.name);
        if (!id) continue;
        try {
          const st = fs.statSync(full);
          if (st.size > 0) files.push({ id, file: full, mtimeMs: st.mtimeMs });
        } catch {
          // Gone meanwhile.
        }
      }
    };
    visit(this.dir, 0);
    // Forget what was read of rollouts that are gone.
    const present = new Set(files.map((c) => c.file));
    for (const file of this.reads.keys()) if (!present.has(file)) this.reads.delete(file);
    this.scanned = { at: now, files, compressed };
    return this.scanned;
  }
}
