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
