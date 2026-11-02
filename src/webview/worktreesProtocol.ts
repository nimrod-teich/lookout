/** How a worktree stands, as the page groups them (see `WorktreeTier` in core/worktrees). */
export type WorktreeTierView = "safe" | "review" | "keep" | "gone";

/** One worktree, as the page lists it. */
export interface WorktreeRow {
  /** Its folder: the row's key, and what a removal names. */
  path: string;
  /** Its repository's main checkout. */
  repo: string;
  /** The folder's own name. */
  name: string;
  branch?: string;
  tier: WorktreeTierView;
  reason: string;
  /** Bytes the disk gets back when it goes. */
  ownBytes: number;
  /** Bytes of files linked from elsewhere too, which stay. */
  sharedBytes: number;
  /** Epoch ms of its last commit. */
  headAt?: number;
  /** Ignored files that go with it and no tool builds again, the first few. */
  ignored?: string[];
  /** Its branch goes with it: its change is on the default branch. */
  landed?: boolean;
  /** The folder that holds it, when that is not `<repo>/.claude/worktrees`; the home folder as `~`. */
  where?: string;
}

/** A repository the check looked at. */
export interface RepoRow {
  repo: string;
  name: string;
  /** The branch "already on" means, e.g. `origin/main`. */
  defaultRef?: string;
  /** Epoch ms of its last fetch, what "on a remote" is as of. */
  fetchedAt?: number;
}

/** What the last removal did. */
export interface RemovalSummary {
  /** Worktrees removed, records cleared. */
  removed: number;
  records: number;
  freedBytes: number;
  branchesDeleted: number;
  /** How much the file systems' free space grew meanwhile; other writers count too. */
  freeSpaceGrew?: number;
  failed: { path: string; name: string; error: string }[];
  /** Epoch ms it finished. */
  at: number;
}

/** A worktree removed from this page, which can be put back. */
export interface RemovedRow {
  path: string;
  repo: string;
  name: string;
  branch?: string;
  branchDeleted?: boolean;
  removedAt: number;
}

export interface WorktreesState {
  /** What runs now: a check, a removal, a restore, or nothing. */
  busy?: "check" | "remove" | "restore";
  progress?: WorkProgress;
  /** The last check, when there was one. */
  checkedAt?: number;
  repos: RepoRow[];
  rows: WorktreeRow[];
  summary?: RemovalSummary;
  removed: RemovedRow[];
  /** What went wrong with the last check, removal or restore. */
  error?: string;
  /** What the last restore did, in a sentence. */
  notice?: string;
  /** Why the last check could not run: git missing, Apple's stand-in, or too old. */
  gitProblem?: string;
}

/** How far a check, a removal or a restore got. */
export interface WorkProgress {
  done: number;
  total: number;
  /** The worktree being worked on. */
  current?: string;
  /** While removing: the bytes given back so far. */
  freedBytes?: number;
}

/** Extension → page: the whole state, or, while work runs, only how far it got. */
export type ToWorktrees = { type: "state"; state: WorktreesState } | { type: "progress"; progress: WorkProgress };

/** Page → extension. */
export type FromWorktrees =
  | { type: "ready" }
  | { type: "check" }
  /** Stop the check under way; the rows stay from the one before. */
  | { type: "stop" }
  | { type: "remove"; paths: string[] }
  | { type: "restore"; path: string }
  | { type: "reveal"; path: string }
  /** The worktree settings, or with `about: "git"` VS Code's git.path. */
  | { type: "settings"; about?: "git" }
  /** Take the last removal's summary off the page. */
  | { type: "dismiss" };
