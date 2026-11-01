import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The branch checked out where `dir` is, read from git's own files: the
 * nearest `.git` above it, a directory or, in a worktree, a file naming the
 * worktree's git directory. Undefined on a detached head or outside a repo.
 */
export function branchAt(dir: string): string | undefined {
  for (let at = dir; ; at = path.dirname(at)) {
    const dotGit = path.join(at, ".git");
    let gitDir: string | undefined;
    try {
      gitDir = fs.statSync(dotGit).isDirectory() ? dotGit : /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
    } catch {
      // Not here; look further up.
    }
    if (gitDir !== undefined) {
      try {
        const head = fs.readFileSync(path.resolve(at, gitDir, "HEAD"), "utf8");
        return /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim();
      } catch {
        return undefined;
      }
    }
    if (path.dirname(at) === at) return undefined;
  }
}

/** A linked worktree: its own top folder and the main checkout of the repository it belongs to. */
export interface WorktreeAt {
  top: string;
  /** The main checkout's folder, or a bare repository's own. */
  main: string;
}

/**
 * The linked worktree `dir` is in, wherever it lives, read from git's own
 * files: the nearest `.git` above it is a file naming the worktree's git
 * directory, whose `commondir` leads to the repository's. Undefined in a main
 * checkout, a submodule or outside a repo, and for a relative path, which
 * would be read against this process's own folder.
 */
export function worktreeAt(dir: string): WorktreeAt | undefined {
  if (!path.isAbsolute(dir)) return undefined;
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const dotGit = path.join(at, ".git");
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return undefined;
    if (st?.isFile()) {
      try {
        const gitDir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (!gitDir) return undefined;
        const ownDir = path.resolve(at, gitDir);
        const common = path.resolve(ownDir, fs.readFileSync(path.join(ownDir, "commondir"), "utf8").trim());
        return { top: at, main: path.basename(common) === ".git" ? path.dirname(common) : common };
      } catch {
        // No commondir: a submodule, or a worktree git has forgotten.
        return undefined;
      }
    }
    if (path.dirname(at) === at) return undefined;
  }
}
