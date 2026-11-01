import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";
import type { ProcessInfo, ProcessTable } from "../../src/core/proc";

const created: string[] = [];

afterEach(() => {
  // A reading thread may still be letting go of a store's file: Windows refuses the removal until it has, so the removal is tried again for a moment.
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A throwaway Claude Code config directory with empty `sessions/` and `projects/`. */
export function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-test-"));
  created.push(dir);
  fs.mkdirSync(path.join(dir, "sessions"));
  fs.mkdirSync(path.join(dir, "projects"));
  return dir;
}

/** A linked worktree at `top` of the repository at `repo`, written the way git writes one. */
export function linkWorktree(repo: string, top: string, id = path.basename(top)): void {
  const own = path.join(repo, ".git", "worktrees", id);
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "commondir"), "../..\n");
  fs.writeFileSync(path.join(own, "HEAD"), `ref: refs/heads/${id}\n`);
  fs.mkdirSync(top, { recursive: true });
  fs.writeFileSync(path.join(top, ".git"), `gitdir: ${own}\n`);
}

/** Git with an identity for the commits tests make. */
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

export function commitFile(cwd: string, file: string, text: string, message = file): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-q", "-m", message);
}

/** A git repository for the worktree tests, with a bare remote it pushed main to, under a real (link-free) temp folder. */
export function gitFixture(): { root: string; repo: string; tree: (name: string) => string } {
  const root = fs.realpathSync.native(tempConfigDir());
  const remote = path.join(root, "remote.git");
  gitIn(root, "init", "-q", "--bare", remote);
  const repo = path.join(root, "app");
  gitIn(root, "init", "-q", repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n.env\n");
  commitFile(repo, "a.txt", "a\n");
  gitIn(repo, "remote", "add", "origin", remote);
  gitIn(repo, "push", "-q", "origin", "main");
  gitIn(repo, "remote", "set-head", "origin", "main");
  return { root, repo, tree: (name) => path.join(root, "wt", name) };
}

export const DOMAIN = "linux:feedfacefeedfacefeedfacefeedface:pid:[4026531836]";

export class FakeProc implements ProcessTable {
  readonly procs = new Map<number, ProcessInfo>();
  readonly kids = new Map<number, { pid: number; args: string; startedMs?: number }[]>();
  domain: string | undefined = DOMAIN;

  cpu: (pid: number) => number | undefined = () => undefined;
  out: (pid: number) => { size: number; deleted: boolean } | undefined = () => undefined;

  output(pid: number): { size: number; deleted: boolean } | undefined {
    return this.out(pid);
  }

  cpuTicks(pid: number): number | undefined {
    return this.cpu(pid);
  }

  children(pid: number): { pid: number; args: string; startedMs?: number }[] {
    return this.kids.get(pid) ?? [];
  }

  get(pid: number): ProcessInfo | null {
    return this.procs.get(pid) ?? null;
  }

  pidDomain(): string | undefined {
    return this.domain;
  }
}

export interface SessionFixture {
  pid: number;
  sessionId: string;
  cwd?: string;
  [key: string]: unknown;
}

export function sessionId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Writes `sessions/<pid>.json` the way Claude Code does, with a matching live process. */
export function writeSession(configDir: string, proc: FakeProc, fixture: SessionFixture, ppid = 1000): void {
  const record = {
    cwd: "/work/app",
    startedAt: 1_000,
    procStart: `${fixture.pid}00`,
    kind: "interactive",
    entrypoint: "claude-vscode",
    pidDomain: DOMAIN,
    status: "idle",
    statusUpdatedAt: 2_000,
    ...fixture,
  };
  fs.writeFileSync(path.join(configDir, "sessions", `${fixture.pid}.json`), JSON.stringify(record));
  proc.procs.set(fixture.pid, { ppid, startTicks: record.procStart });
}

export function transcriptPath(configDir: string, cwd: string, id: string): string {
  const dir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.jsonl`);
}

export function appendEntries(file: string, entries: unknown[]): void {
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e) + "\n").join(""));
}
