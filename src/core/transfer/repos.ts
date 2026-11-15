// The git repositories a backup's sessions worked in, so a restore finds
// each one where it is on the new machine: a clone keeps its remote when
// it moves or is renamed, as a path does not. A backup records, for each
// repository its sessions, notes and tabs worked in, its root and its
// remotes reduced to their paths (`owner/repo`), never a whole URL, which
// can hold a token. A restore looks for clones with a remote in common,
// in the folders this machine is known to work in and a little way under
// the home folder, and maps each repository's old root to its clone here
// when that is the one clone it can be.
import * as fs from "node:fs";
import * as path from "node:path";
import type { PathMapping } from "./types";

/** A repository of the source machine, as a backup records it. */
export interface RepoRecord {
  /** Its root on the source machine: the folder that holds `.git`. */
  root: string;
  /** A linked worktree (`git worktree add`), whose `.git` is a file. */
  linked: boolean;
  /** Its remotes' paths, lowercased, from `remoteKey`. */
  remotes: string[];
}

/** A repository on this machine. */
export interface LocalRepo {
  root: string;
  linked: boolean;
  remotes: string[];
}

/** A repository of the source machine that has more than one clone here, none of them the obvious one. */
export interface AmbiguousRepo {
  from: string;
  choices: string[];
}

/** How far up from a folder its repository's root is looked for. */
const MAX_UP = 40;
/** The most remotes kept of a repository, and the longest one. */
const MAX_REMOTES = 20;
const MAX_REMOTE_LENGTH = 300;
/** The most repositories a backup records, and a restore reads. */
export const MAX_REPOS = 5000;
/** How deep under the home folder a restore looks for clones, and how many folders it reads at most. */
const SCAN_DEPTH = 3;
const SCAN_MAX_DIRS = 20_000;
/** Folders under the home folder no clone is looked for in: system and media folders, and what tools build. */
const SKIPPED = new Set([
  "node_modules",
  "Library",
  "Applications",
  "Pictures",
  "Movies",
  "Music",
  "Photos",
  "AppData",
  "snap",
  "go",
  "venv",
  "target",
  "dist",
  "build",
]);

/**
 * A remote's URL reduced to its path, `owner/repo` lowercased without
 * `.git`: the same for `git@github.com:o/r.git`, `ssh://git@github.com/o/r`
 * and `https://user:token@github.com/O/R`. The host is left out, since an
 * SSH host alias names it differently on each machine. None for a local
 * path or a URL that names no path: such a remote matches nothing elsewhere.
 */
export function remoteKey(url: string): string | undefined {
  const text = url.trim();
  let rest: string | undefined;
  const scp = /^[^\s/@:]+@[^\s/:]+:(?!\/\/)(.+)$/.exec(text);
  if (scp) rest = scp[1];
  else if (/^(ssh|git|https?|git\+ssh|ssh\+git):\/\//i.test(text)) {
    try {
      rest = new URL(text).pathname;
    } catch {
      return undefined;
    }
  } else return undefined;
  const key = decodeSafe(rest!)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .replace(/^~[^/]*\//, "")
    .toLowerCase();
  return key.includes("/") && !key.split("/").some((part) => part === "" || part === "." || part === "..") ? key : undefined;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The remotes' URLs of a git config file, `url` and `pushurl` of every `[remote "…"]` section. */
export function remoteUrls(config: string): string[] {
  const urls: string[] = [];
  let inRemote = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inRemote = /^\[\s*remote\s+"[^"]*"\s*\]$/i.test(line);
      continue;
    }
    if (!inRemote) continue;
    const m = /^(url|pushurl)\s*=\s*(.*)$/i.exec(line);
    if (m) urls.push(m[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return urls;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The repository `dir` is in: the nearest folder up from it that holds
 * `.git`, read from its files without running git. A `.git` file names
 * the repository's folder (`gitdir:`); one with a `commondir` is a linked
 * worktree's, whose remotes are its main checkout's. None outside a
 * repository.
 */
export function repoAt(dir: string): LocalRepo | undefined {
  let at = path.resolve(dir);
  for (let i = 0; i < MAX_UP; i++) {
    const dotGit = path.join(at, ".git");
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = undefined;
    }
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        const named = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? "")?.[1]?.trim();
        if (!named) return undefined;
        gitDir = path.resolve(at, named);
      } else if (!st.isDirectory()) return undefined;
      const common = readText(path.join(gitDir, "commondir"))?.trim();
      const commonDir = common ? path.resolve(gitDir, common) : gitDir;
      const keys = new Set<string>();
      for (const url of remoteUrls(readText(path.join(commonDir, "config")) ?? "")) {
        const key = remoteKey(url);
        if (key && key.length <= MAX_REMOTE_LENGTH && keys.size < MAX_REMOTES) keys.add(key);
      }
      return { root: at, linked: common !== undefined, remotes: [...keys].sort() };
    }
    const up = path.dirname(at);
    if (up === at) return undefined;
    at = up;
  }
  return undefined;
}

/** The repositories `folders` are in, each once, with a remote: what a backup records. */
export function describeRepos(folders: Iterable<string>): RepoRecord[] {
  const byRoot = new Map<string, RepoRecord>();
  const seen = new Set<string>();
  for (const folder of folders) {
    if (typeof folder !== "string" || folder === "" || seen.has(folder)) continue;
    seen.add(folder);
    const repo = repoAt(folder);
    if (!repo || repo.remotes.length === 0 || byRoot.has(repo.root)) continue;
    byRoot.set(repo.root, { root: repo.root, linked: repo.linked, remotes: repo.remotes });
    if (byRoot.size >= MAX_REPOS) break;
  }
  return [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root));
}

/** A backup's repositories, checked: an absolute root, a flag, and remotes in the shape `remoteKey` makes. The rest is left out. */
export function readRepoRecords(value: unknown): RepoRecord[] {
  if (!Array.isArray(value)) return [];
  const out: RepoRecord[] = [];
  for (const item of value.slice(0, MAX_REPOS)) {
    if (typeof item !== "object" || item === null) continue;
    const { root, linked, remotes } = item as Record<string, unknown>;
    if (typeof root !== "string" || root === "" || root.length > 4096 || root.includes("\0") || typeof linked !== "boolean" || !Array.isArray(remotes)) continue;
    const keys = remotes.filter((key): key is string => typeof key === "string" && key.length <= MAX_REMOTE_LENGTH && /^[^\s/]+(\/[^\s/]+)+$/.test(key) && !/(^|\/)\.\.?(\/|$)/.test(key)).slice(0, MAX_REMOTES);
    if (keys.length) out.push({ root, linked, remotes: keys });
  }
  return out;
}

/**
 * The clones on this machine of any of the `wanted` remotes: the
 * repositories of the folders `starts` names (and the ones they are in),
 * and those up to three folders deep under `home`, hidden folders and
 * system, media and build folders left out. Each repository once.
 */
export function findLocalRepos(starts: readonly string[], home: string, wanted: ReadonlySet<string>, limits: { depth?: number; maxDirs?: number } = {}): LocalRepo[] {
  const found = new Map<string, LocalRepo>();
  const consider = (repo: LocalRepo | undefined) => {
    if (repo && !found.has(repo.root) && repo.remotes.some((key) => wanted.has(key))) found.set(repo.root, repo);
  };
  if (wanted.size === 0) return [];
  for (const start of starts) if (typeof start === "string" && start !== "") consider(repoAt(start));
  const depth = limits.depth ?? SCAN_DEPTH;
  let budget = limits.maxDirs ?? SCAN_MAX_DIRS;
  const walk = (dir: string, level: number) => {
    if (budget-- <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      consider(repoAt(dir));
      return;
    }
    if (level >= depth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
      walk(path.join(dir, entry.name), level + 1);
    }
  };
  if (home) walk(home, 0);
  return [...found.values()];
}

/** A path's parts, compared without case where the machine ignores it. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Where each of the source machine's repositories is here, by its remotes.
 * A repository the mapping already puts on a clone of it is left as it is.
 * Else of the clones here with a remote in common, main checkouts come
 * before linked worktrees, then those named as the repository was, then
 * those under the home folder; the one left first is its place, unless
 * several are equally good, when it is left for the user to choose. A
 * linked worktree of the source machine is not mapped: its main checkout's
 * mapping carries it, and its own folder is not here.
 */
export function repoMappings(
  sources: readonly RepoRecord[],
  local: readonly LocalRepo[],
  mapped: (p: string) => string | undefined,
  home: string,
  sourcePlatform: NodeJS.Platform,
): { mapping: PathMapping[]; ambiguous: AmbiguousRepo[] } {
  const mapping: PathMapping[] = [];
  const ambiguous: AmbiguousRepo[] = [];
  const baseOf = (p: string) => (sourcePlatform === "win32" ? path.win32.basename(p) : path.posix.basename(p));
  for (const source of sources) {
    if (source.linked) continue;
    const wanted = new Set(source.remotes);
    const there = mapped(source.root);
    const atPlace = there ? repoAt(there) : undefined;
    if (there && atPlace && path.resolve(atPlace.root) === path.resolve(there) && atPlace.remotes.some((key) => wanted.has(key))) continue;
    let choices = local.filter((repo) => repo.remotes.some((key) => wanted.has(key)));
    if (choices.length === 0) continue;
    const narrow = (keep: (repo: LocalRepo) => boolean) => {
      const kept = choices.filter(keep);
      if (kept.length > 0) choices = kept;
    };
    narrow((repo) => !repo.linked);
    narrow((repo) => sameName(path.basename(repo.root), baseOf(source.root)));
    narrow((repo) => repo.root === home || repo.root.startsWith(home.endsWith(path.sep) ? home : `${home}${path.sep}`));
    if (choices.length === 1) mapping.push({ from: source.root, to: choices[0]!.root, by: "repo" });
    else ambiguous.push({ from: source.root, choices: choices.map((repo) => repo.root).sort() });
  }
  return { mapping, ambiguous };
}
