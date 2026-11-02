import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { within } from "./folders";

/**
 * Ignored files and folders that tools build again, so a worktree holding
 * them loses nothing when it goes: dependencies, build output, caches.
 * `*.ext` matches by extension; anything else by its own name.
 */
export const REBUILDABLE = [
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  "next-env.d.ts",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".vite",
  ".cache",
  "coverage",
  ".nyc_output",
  "target",
  ".gradle",
  ".terraform",
  ".terraform.lock.hcl",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "*.pyc",
  "*.tsbuildinfo",
  "*.vsix",
  ".DS_Store",
];

/** A linked worktree as `git worktree list --porcelain` gives it. */
export interface GitWorktree {
  path: string;
  head?: string;
  /** The branch checked out, short; none on a detached head. */
  branch?: string;
  /** Locked, with git's reason when one was given ("" when none was). */
  locked?: string;
  /** Git says its folder is gone. */
  prunable: boolean;
}

/**
 * - `safe`: nothing in it is lost when it goes: no change, no untracked file,
 *   no ignored file but rebuildable ones, and every commit on a remote or its
 *   change already on the default branch.
 * - `review`: it can go and its commits stay in its branch, but it may still
 *   be wanted: commits on no remote, ignored files a tool does not build again.
 * - `keep`: in use, or holding work only it has.
 * - `gone`: git still lists it, but its folder is gone.
 */
export type WorktreeTier = "safe" | "review" | "keep" | "gone";

export interface WorktreeCheck {
  /** The repository's main checkout. */
  repo: string;
  path: string;
  branch?: string;
  head?: string;
  tier: WorktreeTier;
  /** Why, in a few words: "already on origin/main", "2 commits on no remote". */
  reason: string;
  /** Its change is on the default branch: its branch can go with it. */
  landed?: boolean;
  /** Ignored files that go with it and that no tool builds again, the first few. */
  ignored?: string[];
  /** Bytes the disk gets back when it goes: its files and git's record of it. */
  ownBytes: number;
  /** Bytes of files linked from elsewhere too (a package store), which stay. */
  sharedBytes: number;
  /** Epoch ms of its HEAD commit. */
  headAt?: number;
}

/** Where a worktree is used, or marked, outside git: a running session, a window's folder, a process, a starred session. */
export interface InUse {
  dir: string;
  /** "a session is running in it", "open in a VS Code window". */
  why: string;
  /** Holds a worktree for review rather than keeping it: a starred session worked in it. */
  soft?: boolean;
}

/** Variables that point git at another repository, index or object store than the folder it is run in. */
const GIT_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX"];

/**
 * The environment git runs in here: never redirected to another repository
 * (VS Code started from a git hook carries `GIT_DIR`, and a branch deleted
 * there would be another repository's), never prompting, never taking the
 * index lock a read does not need, and in English for the messages shown.
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const name of GIT_REDIRECTS) delete out[name];
  return out;
}

const GIT_ENV = gitEnv();

interface Ran {
  code: number;
  out: string;
  err: string;
}

/** Runs git in `cwd`; never rejects: a git that is missing or fails answers with a code. */
export function git(cwd: string, args: readonly string[], timeoutMs = 60_000): Promise<Ran> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn("git", ["-C", cwd, "-c", "core.quotePath=false", ...args], { env: GIT_ENV, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, out: "", err: String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

/**
 * The patch ids of what `git <args>` prints (a diff, or a log with patches),
 * by commit: a bare diff gets one, under git's all-zero id. The callers ask
 * for no colour and no external diff tool, whatever the user's git config
 * says, so patch-id reads git's own diff.
 */
function patchIds(cwd: string, args: readonly string[]): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const ids = new Map<string, string>();
    let producer;
    let consumer;
    try {
      producer = spawn("git", ["-C", cwd, ...args], { env: GIT_ENV, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      consumer = spawn("git", ["-C", cwd, "patch-id", "--stable"], { env: GIT_ENV, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      producer?.kill();
      resolve(ids);
      return;
    }
    producer.stdout.pipe(consumer.stdin);
    // patch-id may stop reading early; the producer's broken pipe is not an error here.
    consumer.stdin.on("error", () => undefined);
    producer.on("error", () => consumer.stdin.end());
    let rest = "";
    consumer.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const [id, commit] = line.split(" ");
        if (id && commit) ids.set(commit, id);
      }
    });
    consumer.on("error", () => resolve(ids));
    consumer.on("close", () => resolve(ids));
  });
}

/** Parses `git worktree list --porcelain`, the main checkout (the first) left out. */
export function parseWorktreeList(text: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  for (const block of text.split(/\n\n+/).slice(1)) {
    const item: GitWorktree = { path: "", prunable: false };
    for (const line of block.split("\n")) {
      const space = line.indexOf(" ");
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? "" : line.slice(space + 1);
      if (key === "worktree") item.path = value;
      else if (key === "HEAD") item.head = value;
      else if (key === "branch") item.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "locked") item.locked = value;
      else if (key === "prunable") item.prunable = true;
    }
    if (item.path) out.push(item);
  }
  return out;
}

/** A folder as the file system names it, through links and short names; as written when it is gone. */
export function real(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The repository's linked worktrees; none when git cannot list them. */
export async function listWorktrees(repo: string): Promise<GitWorktree[]> {
  const ran = await git(repo, ["worktree", "list", "--porcelain"]);
  return ran.code === 0 ? parseWorktreeList(ran.out).map((item) => ({ ...item, path: real(item.path) })) : [];
}

/** The branch the repository's work lands on: the remote's default, else `main` or `master`, remote first. */
export async function defaultBranch(repo: string): Promise<string | undefined> {
  const head = await git(repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.out.trim()) return head.out.trim();
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if ((await git(repo, ["rev-parse", "-q", "--verify", `${ref}^{commit}`])).code === 0) return ref;
  }
  return undefined;
}

/** Main checkouts of git repositories in each folder and up to `depth` levels below it, the folders themselves included. */
export function findRepos(folders: readonly string[], depth = 2): string[] {
  const found = new Set<string>();
  const look = (dir: string, left: number) => {
    let entries: fs.Dirent[];
    try {
      if (fs.statSync(path.join(dir, ".git")).isDirectory()) {
        found.add(dir);
        return;
      }
    } catch {
      // Not a main checkout; look below.
    }
    if (left <= 0) return;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      look(path.join(dir, entry.name), left - 1);
    }
  };
  for (const folder of folders) look(real(folder), depth);
  return [...found].sort();
}

/** The main checkout of the repository `dir` is in, a worktree's or its own; undefined outside one. */
export function mainCheckoutOf(dir: string): string | undefined {
  if (!path.isAbsolute(dir)) return undefined;
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const dotGit = path.join(at, ".git");
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return at;
      const gitDir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
      if (!gitDir) return undefined;
      const own = path.resolve(at, gitDir);
      const common = path.resolve(own, fs.readFileSync(path.join(own, "commondir"), "utf8").trim());
      return path.basename(common) === ".git" ? path.dirname(common) : undefined;
    } catch {
      // Not here; look further up.
    }
    if (path.dirname(at) === at) return undefined;
  }
}

/** One status line's path ends a rebuildable name: `node_modules/`, `a/b/.terraform/`, `x.pyc`. */
export function isRebuildable(entry: string, names: ReadonlySet<string>): boolean {
  const name = entry.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (names.has(name)) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && names.has(`*${name.slice(dot)}`);
}

interface Status {
  changed: number;
  untracked: number;
  /** Ignored entries, folders collapsed (`dir/`). */
  ignored: string[];
}

/** `git status` of a worktree, ignored files included, without taking git's index lock. */
async function statusOf(dir: string): Promise<Status | undefined> {
  const ran = await git(dir, ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=normal"]);
  if (ran.code !== 0) return undefined;
  const status: Status = { changed: 0, untracked: 0, ignored: [] };
  const entries = ran.out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    if (xy === "??") status.untracked++;
    else if (xy === "!!") status.ignored.push(entry.slice(3));
    else {
      status.changed++;
      // A rename or copy is followed by the path it came from.
      if (xy.includes("R") || xy.includes("C")) i++;
    }
  }
  return status;
}

/** Commits of HEAD not on any remote, or not on any branch, tag or remote (for a detached head). */
async function countOutside(dir: string, refs: readonly string[]): Promise<number | undefined> {
  const ran = await git(dir, ["rev-list", "--count", "HEAD", "--not", ...refs]);
  const n = Number(ran.out.trim());
  return ran.code === 0 && Number.isFinite(n) ? n : undefined;
}

/** Commits of the default branch read at once for a repository's worktrees; a longer range since a merge base is read on its own. */
const RECENT = 2000;

/**
 * The patch ids of the default branch's commits since a merge base, shared by
 * a repository's worktrees: its newest commits are read once, and each
 * worktree's range is looked up in them by commit; a range reaching further
 * back is read whole.
 */
export class MainPatchIds {
  private recent: Promise<Map<string, string>> | undefined;
  private readonly ranges = new Map<string, Promise<Set<string>>>();

  constructor(
    private readonly repo: string,
    private readonly ref: string,
    private readonly window = RECENT,
  ) {}

  async since(mergeBase: string): Promise<Set<string>> {
    const listed = await git(this.repo, ["rev-list", "--no-merges", `${mergeBase}..${this.ref}`]);
    const commits = listed.code === 0 ? listed.out.split("\n").filter(Boolean) : undefined;
    if (commits && commits.length <= this.window) {
      this.recent ??= patchIds(this.repo, ["log", "-p", "--no-color", "--no-ext-diff", "--no-merges", `--max-count=${this.window}`, "--format=commit %H", this.ref]);
      const recent = await this.recent;
      const ids = commits.map((commit) => recent.get(commit));
      // Every commit of the range was read, or the whole branch was, so one with no patch id is an empty commit, which changes nothing.
      // A commit left out can only make a landed change look unlanded, never the other way.
      if (recent.size < this.window || ids.every((id) => id !== undefined)) return new Set(ids.filter((id): id is string => id !== undefined));
    }
    let range = this.ranges.get(mergeBase);
    if (!range) {
      range = patchIds(this.repo, ["log", "-p", "--no-color", "--no-ext-diff", "--no-merges", "--format=commit %H", `${mergeBase}..${this.ref}`]).then((ids) => new Set(ids.values()));
      this.ranges.set(mergeBase, range);
    }
    return range;
  }
}

/**
 * Whether the worktree's change is already on the default branch: HEAD is on
 * it, or HEAD changes nothing since where the two parted, or that whole
 * change is one commit of the default branch's since then, which is how a
 * squash merge lands it. A merge whose result differs (a conflict, a later
 * commit in the pull request) is not recognised, and the worktree stays for
 * review.
 */
export async function hasLanded(dir: string, defaultRef: string, onMain: MainPatchIds): Promise<boolean> {
  const base = await git(dir, ["merge-base", defaultRef, "HEAD"]);
  if (base.code !== 0) return false;
  const mergeBase = base.out.trim();
  const head = (await git(dir, ["rev-parse", "HEAD"])).out.trim();
  if (mergeBase === head) return true;
  const changed = await git(dir, ["diff", "--quiet", mergeBase, "HEAD"]);
  if (changed.code === 0) return true;
  const own = [...(await patchIds(dir, ["diff", "--no-color", "--no-ext-diff", mergeBase, "HEAD"])).values()];
  if (own.length === 0) return false;
  const ids = await onMain.since(mergeBase);
  return own.every((id) => ids.has(id));
}

export interface Measured {
  ownBytes: number;
  sharedBytes: number;
}

/**
 * What a folder holds on disk, symbolic links not followed. A file linked
 * more times than the folder holds it is shared with something that stays (a
 * package store's hard links), so its bytes are not given back; one whose
 * every link is inside is.
 */
export function measure(dirs: readonly string[]): Measured {
  let ownBytes = 0;
  let sharedBytes = 0;
  const linked = new Map<string, { nlink: number; bytes: number; seen: number }>();
  const stack = [...dirs];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      // Blocks where the platform counts them (a sparse or small file takes less, or more, than its size); its size elsewhere.
      const bytes = typeof st.blocks === "number" && Number.isFinite(st.blocks) ? st.blocks * 512 : st.size;
      if (st.nlink > 1 && st.ino) {
        const key = `${st.dev}:${st.ino}`;
        const known = linked.get(key);
        if (known) known.seen++;
        else linked.set(key, { nlink: st.nlink, bytes, seen: 1 });
      } else {
        ownBytes += bytes;
      }
    }
  }
  for (const file of linked.values()) {
    if (file.seen >= file.nlink) ownBytes += file.bytes;
    else sharedBytes += file.bytes;
  }
  return { ownBytes, sharedBytes };
}

/** The worktree's own folder in the repository's git directory, which goes with it. */
function recordDirOf(top: string): string | undefined {
  try {
    const gitDir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(top, ".git"), "utf8"))?.[1]?.trim();
    return gitDir ? path.resolve(top, gitDir) : undefined;
  } catch {
    return undefined;
  }
}

export interface CheckContext {
  defaultRef?: string;
  /** Running sessions, windows' folders, processes' folders, starred sessions. */
  inUse: readonly InUse[];
  /** Every worktree and main checkout known, to find one inside another. */
  allTops: readonly string[];
  rebuildable: ReadonlySet<string>;
  /** Patch ids of the default branch's commits, shared by a repository's worktrees; made for `defaultRef` when not given. */
  mainIds?: MainPatchIds;
  /** Skip the walk that sizes it. */
  noMeasure?: boolean;
  /** Git work in it this recently holds it for review: another session may be at it from a folder of its own. 24 hours when not given. */
  quietMs?: number;
}

/** A worktree with git work in it this recently may still be worked on, by a session Lookout cannot place in it. */
export const QUIET_MS = 24 * 60 * 60_000;

/** When git last did something in a worktree: its HEAD commit, or its reflog (a commit, checkout, reset or rebase there). */
function lastWorkAt(top: string, headAt: number | undefined): number | undefined {
  const record = recordDirOf(top);
  let reflogAt: number | undefined;
  try {
    reflogAt = record ? fs.statSync(path.join(record, "logs", "HEAD")).mtimeMs : undefined;
  } catch {
    reflogAt = undefined;
  }
  return Math.max(headAt ?? 0, reflogAt ?? 0) || undefined;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** How one worktree stands: its tier, why, and what it takes on disk. */
export async function checkWorktree(repo: string, item: GitWorktree, ctx: CheckContext): Promise<WorktreeCheck> {
  const base = { repo, path: item.path, branch: item.branch, head: item.head, ownBytes: 0, sharedBytes: 0 };
  if (item.prunable || !fs.existsSync(item.path)) return { ...base, tier: "gone", reason: "its folder is gone" };
  const sized = (check: Omit<WorktreeCheck, "ownBytes" | "sharedBytes">): WorktreeCheck => {
    if (ctx.noMeasure) return { ...check, ownBytes: 0, sharedBytes: 0 };
    const record = recordDirOf(item.path);
    return { ...check, ...measure(record ? [item.path, record] : [item.path]) };
  };
  const headAt = Number((await git(item.path, ["log", "-1", "--format=%ct"])).out.trim()) * 1000 || undefined;
  const keep = (reason: string) => sized({ ...base, headAt, tier: "keep", reason });

  // Something working in it or below; a window on a folder that holds many worktrees uses none of them.
  const used = ctx.inUse.find((use) => !use.soft && within(use.dir, [item.path]));
  if (used) return keep(used.why);
  if (item.locked !== undefined) return keep(item.locked ? `locked: ${item.locked}` : "locked");
  const inner = ctx.allTops.find((top) => top !== item.path && within(top, [item.path]));
  if (inner) return keep(`holds another checkout (${path.basename(inner)})`);
  const status = await statusOf(item.path);
  if (!status) return keep("git cannot read it");
  if (status.changed) return keep(`${plural(status.changed, "changed file")}`);
  if (status.untracked) return keep(`${plural(status.untracked, "untracked file")}`);

  const ignored = status.ignored.filter((entry) => !isRebuildable(entry, ctx.rebuildable));
  const landed = ctx.defaultRef ? await hasLanded(item.path, ctx.defaultRef, ctx.mainIds ?? new MainPatchIds(repo, ctx.defaultRef)) : false;
  const onNoRemote = await countOutside(item.path, ["--remotes"]);
  const onNoRef = item.branch ? 0 : await countOutside(item.path, ["--branches", "--tags", "--remotes"]);
  const marked = ctx.inUse.find((use) => use.soft && within(use.dir, [item.path]));
  const workedAt = lastWorkAt(item.path, headAt);
  const recent = workedAt !== undefined && Date.now() - workedAt < (ctx.quietMs ?? QUIET_MS);
  const withIgnored = ignored.length ? { ignored: ignored.slice(0, 5) } : {};

  if (!landed && onNoRef === undefined) return keep("git cannot read its commits");
  // A detached head's own commits are on no branch: they go with the worktree.
  if (!landed && onNoRef) return keep(`${plural(onNoRef, "commit")} on no branch`);
  const shortRef = ctx.defaultRef?.replace(/^refs\/remotes\//, "");
  const why = landed ? `already on ${shortRef}` : onNoRemote === 0 ? "every commit is on a remote" : undefined;
  if (why && !ignored.length && !marked && !recent) return sized({ ...base, headAt, tier: "safe", reason: why, landed });
  const reasons = [
    ...(why ? [] : [onNoRemote === undefined ? "its commits could not be read" : `${plural(onNoRemote, "commit")} on no remote, kept in its branch`]),
    ...(ignored.length ? [`${plural(ignored.length, "ignored file")} no tool builds again`] : []),
    ...(marked ? [marked.why] : []),
    ...(recent ? ["worked on in the last day"] : []),
  ];
  return sized({ ...base, headAt, tier: "review", reason: reasons.join("; "), landed, ...withIgnored });
}

/** A repository the check looked at. */
export interface RepoInfo {
  repo: string;
  defaultRef?: string;
  /** Epoch ms of its last fetch: what "on a remote" is as of. */
  fetchedAt?: number;
}

export interface SurveyInput {
  /** Folders to look for repositories in, two levels deep. */
  folders: readonly string[];
  /** Repositories known otherwise, those sessions ran in. */
  repos: readonly string[];
  inUse: readonly InUse[];
  rebuildable: readonly string[];
  /** Git work in a worktree this recently holds it for review; 24 hours when not given. */
  quietMs?: number;
}

export interface Survey {
  repos: RepoInfo[];
  worktrees: WorktreeCheck[];
  /** Epoch ms the check finished. */
  at: number;
}

export interface SurveyProgress {
  done: number;
  total: number;
  /** While removing: the bytes given back so far. */
  freedBytes?: number;
  /** The worktree being looked at. */
  current?: string;
}

function fetchedAt(repo: string): number | undefined {
  try {
    return fs.statSync(path.join(repo, ".git", "FETCH_HEAD")).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Runs `work` over the items, `width` at a time, in order of start. */
async function inTurn<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return out;
}

/** Every linked worktree of the repositories found, each with how it stands and what it takes on disk. */
export async function survey(input: SurveyInput, onProgress?: (progress: SurveyProgress) => void): Promise<Survey> {
  const repos = [...new Set([...findRepos(input.folders), ...input.repos.map(real)])].sort();
  const inUse = input.inUse.map((use) => ({ ...use, dir: real(use.dir) }));
  const lists = await inTurn(repos, 4, async (repo) => ({ info: { repo, defaultRef: await defaultBranch(repo), fetchedAt: fetchedAt(repo) }, items: await listWorktrees(repo) }));
  const allTops = [...repos, ...lists.flatMap((list) => list.items.map((item) => item.path))];
  const rebuildable = new Set(input.rebuildable);
  const jobs = lists.flatMap((list) => list.items.map((item) => ({ info: list.info, item })));
  const mainIds = new Map<string, MainPatchIds>();
  let done = 0;
  onProgress?.({ done, total: jobs.length });
  const worktrees = await inTurn(jobs, 4, async ({ info, item }) => {
    let ids = mainIds.get(info.repo);
    if (!ids && info.defaultRef) mainIds.set(info.repo, (ids = new MainPatchIds(info.repo, info.defaultRef)));
    onProgress?.({ done, total: jobs.length, current: item.path });
    const check = await checkWorktree(info.repo, item, { defaultRef: info.defaultRef, inUse, allTops, rebuildable, mainIds: ids, quietMs: input.quietMs });
    onProgress?.({ done: ++done, total: jobs.length });
    return check;
  });
  return { repos: lists.map((list) => list.info), worktrees, at: Date.now() };
}

/** The folders processes on this machine run in, where the platform tells: a build, a server or a shell in a worktree. */
export async function processFolders(): Promise<string[]> {
  if (process.platform === "linux") {
    const out: string[] = [];
    let pids: string[];
    try {
      pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
    } catch {
      return [];
    }
    for (const pid of pids) {
      try {
        out.push(fs.readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // Gone, or another user's.
      }
    }
    return out;
  }
  if (process.platform === "darwin") {
    const ran = await new Promise<string>((resolve) => {
      let out = "";
      try {
        const child = spawn("lsof", ["-a", "-d", "cwd", "-Fn"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
        child.on("error", () => resolve(""));
        child.on("close", () => resolve(out));
      } catch {
        resolve("");
      }
    });
    return ran.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
  }
  return [];
}

/** What removing a worktree did. */
export interface Removal {
  repo: string;
  path: string;
  branch?: string;
  head?: string;
  ok: boolean;
  /** Why it was not removed, or what went wrong. */
  error?: string;
  /** Bytes given back, as the check measured them. */
  freedBytes: number;
  /** Its branch went with it: its change was on the default branch. */
  branchDeleted?: boolean;
  /** It had been a record only; its folder was already gone. */
  record?: boolean;
  /** How it stands now, when the second look refused it: the tier and reason the page should show instead. */
  now?: Pick<WorktreeCheck, "tier" | "reason" | "landed" | "ignored">;
}

export interface RemoveAsk {
  repo: string;
  path: string;
  /** The tier the page showed: a worktree shown as safe goes only while it still is; one shown for review, while it is not kept. */
  shownAs: WorktreeTier;
  /** What the check measured it to give back: sizing it again would walk its folders a second time. */
  bytes?: number;
}

/**
 * What a batch of removals reads once per repository rather than once per
 * worktree: its default branch, and that branch's patch ids, which take
 * seconds to read in a repository with a long history. The default branch
 * does not move during a removal: only worktrees and their own branches go.
 */
export class RemovalShared {
  private readonly repos = new Map<string, Promise<{ defaultRef?: string; mainIds?: MainPatchIds }>>();

  of(repo: string): Promise<{ defaultRef?: string; mainIds?: MainPatchIds }> {
    let found = this.repos.get(repo);
    if (!found) {
      found = defaultBranch(repo).then((defaultRef) => (defaultRef ? { defaultRef, mainIds: new MainPatchIds(repo, defaultRef) } : {}));
      this.repos.set(repo, found);
    }
    return found;
  }
}

/** Repositories worked on at once by a removal; each one's worktrees go in turn, so git never races itself in one repository. */
const REMOVAL_LANES = 4;

/**
 * Removes the worktrees asked for, each after its second look, saying how
 * far it got and how much has come back so far. The answers are in the
 * order asked.
 */
export async function removeWorktrees(asks: readonly RemoveAsk[], input: Omit<SurveyInput, "folders" | "repos">, onProgress?: (progress: SurveyProgress) => void): Promise<Removal[]> {
  const shared = new RemovalShared();
  const byRepo = new Map<string, number[]>();
  asks.forEach((ask, i) => byRepo.set(ask.repo, [...(byRepo.get(ask.repo) ?? []), i]));
  const out: Removal[] = new Array(asks.length);
  let done = 0;
  let freedBytes = 0;
  onProgress?.({ done, total: asks.length, freedBytes });
  await inTurn([...byRepo.values()], REMOVAL_LANES, async (indexes) => {
    for (const i of indexes) {
      const ask = asks[i]!;
      onProgress?.({ done, total: asks.length, current: ask.path, freedBytes });
      const removal = await removeWorktree(ask, input, shared);
      out[i] = removal;
      freedBytes += removal.freedBytes;
      onProgress?.({ done: ++done, total: asks.length, freedBytes });
    }
  });
  return out;
}

/**
 * Removes one worktree after looking at it again, since things change
 * between the check and the click: it goes only while it is still what the
 * page showed (safe, or for review when picked from there), never when it is
 * kept now. Git's own removal is used, which refuses changed or untracked
 * files and a lock. Its branch goes too when its change is on the default
 * branch.
 */
export async function removeWorktree(ask: RemoveAsk, input: Omit<SurveyInput, "folders" | "repos">, shared: RemovalShared = new RemovalShared()): Promise<Removal> {
  const base = { repo: ask.repo, path: ask.path, ok: false, freedBytes: 0 };
  const items = await listWorktrees(ask.repo);
  const wanted = real(ask.path);
  const item = items.find((candidate) => candidate.path === wanted);
  if (!item) return { ...base, error: "git no longer lists it" };
  const known = { ...base, branch: item.branch, head: item.head };
  const allTops = [real(ask.repo), ...items.map((candidate) => candidate.path)];
  const inUse = input.inUse.map((use) => ({ ...use, dir: real(use.dir) }));
  const { defaultRef, mainIds } = await shared.of(ask.repo);
  const now = await checkWorktree(ask.repo, item, { defaultRef, inUse, allTops, rebuildable: new Set(input.rebuildable), noMeasure: true, mainIds, quietMs: input.quietMs });
  if (now.tier === "gone") {
    const ran = await git(ask.repo, ["worktree", "remove", item.path]);
    return ran.code === 0 ? { ...known, ok: true, record: true } : { ...known, error: firstLine(ran.err) ?? "git refused" };
  }
  const stands = { tier: now.tier, reason: now.reason, ...(now.landed ? { landed: true } : {}), ...(now.ignored ? { ignored: now.ignored } : {}) };
  if (now.tier === "keep") return { ...known, error: `kept now: ${now.reason}`, now: stands };
  if (now.tier === "review" && ask.shownAs === "safe") return { ...known, error: `changed since the check: ${now.reason}`, now: stands };
  const ran = await git(ask.repo, ["worktree", "remove", item.path]);
  if (ran.code !== 0) return { ...known, error: firstLine(ran.err) ?? "git refused" };
  const removed: Removal = { ...known, ok: true, freedBytes: ask.bytes ?? 0 };
  if (now.landed && item.branch) removed.branchDeleted = (await git(ask.repo, ["branch", "-D", item.branch])).code === 0;
  return removed;
}

function firstLine(text: string): string | undefined {
  return text.split("\n").map((line) => line.replace(/^(fatal|error):\s*/, "").trim()).find(Boolean);
}

/** A removed worktree, as kept for putting it back. */
export interface RemovedRecord {
  repo: string;
  path: string;
  branch?: string;
  head?: string;
  branchDeleted?: boolean;
  /** Epoch ms. */
  removedAt: number;
}

/**
 * Puts a removed worktree back where it was, on its branch, made again at
 * the commit it was on when the branch went with it: its committed files
 * return, its ignored ones (dependencies, build output) do not. Refused when
 * something is in its place, or the commit is gone from the repository.
 */
export async function restoreWorktree(record: RemovedRecord): Promise<{ ok: boolean; error?: string }> {
  if (fs.existsSync(record.path)) return { ok: false, error: "something is in its place" };
  const hasBranch = record.branch ? (await git(record.repo, ["rev-parse", "-q", "--verify", `refs/heads/${record.branch}`])).code === 0 : false;
  if (!hasBranch && !record.head) return { ok: false, error: "its commit is not known" };
  if (!hasBranch && (await git(record.repo, ["cat-file", "-e", `${record.head}^{commit}`])).code !== 0) return { ok: false, error: "its commit is gone from the repository" };
  const args = hasBranch ? ["worktree", "add", record.path, record.branch!] : record.branch ? ["worktree", "add", "-b", record.branch, record.path, record.head!] : ["worktree", "add", "--detach", record.path, record.head!];
  const ran = await git(record.repo, args);
  return ran.code === 0 ? { ok: true } : { ok: false, error: firstLine(ran.err) ?? "git refused" };
}

/** Free bytes on each file system the folders are on, keyed by device. */
export function freeSpace(dirs: readonly string[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const dir of dirs) {
    try {
      const dev = fs.statSync(dir).dev;
      if (out.has(dev)) continue;
      const st = fs.statfsSync(dir);
      out.set(dev, st.bavail * st.bsize);
    } catch {
      // Gone, or the platform cannot tell.
    }
  }
  return out;
}
