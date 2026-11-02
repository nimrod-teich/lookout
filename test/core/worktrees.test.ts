import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkWorktree,
  findRepos,
  gitEnv,
  gitProblem,
  isRebuildable,
  listWorktrees,
  lockedFromFile,
  MainPatchIds,
  measure,
  onPath,
  parseGitVersion,
  parseWorktreeList,
  pickGit,
  REBUILDABLE,
  RemovalShared,
  removeWorktree,
  removeWorktrees,
  restoreWorktree,
  survey,
  useGit,
  type CheckContext,
  type InUse,
  type SurveyProgress,
  type WorktreeCheck,
} from "../../src/core/worktrees";
import { commitFile, gitFixture, gitIn, tempConfigDir } from "./helpers";

function context(repo: string, extra: Partial<CheckContext> = {}): CheckContext {
  return { defaultRef: "origin/main", inUse: [], allTops: [repo], rebuildable: new Set(REBUILDABLE), quietMs: 0, ...extra };
}

async function checkOf(repo: string, top: string, extra: Partial<CheckContext> = {}): Promise<WorktreeCheck> {
  const item = (await listWorktrees(repo)).find((candidate) => candidate.path === top);
  if (!item) throw new Error(`git does not list ${top}`);
  return checkWorktree(repo, item, context(repo, extra));
}

describe("parseWorktreeList", () => {
  it("reads each linked worktree, the main checkout left out", () => {
    const text = [
      "worktree /r/app\nHEAD 1111\nbranch refs/heads/main\n",
      "worktree /r/wt/a\nHEAD 2222\nbranch refs/heads/feat/a\nlocked claude session 12\n",
      "worktree /r/wt/b\nHEAD 3333\ndetached\nlocked\n",
      "worktree /tmp/gone\nHEAD 4444\nbranch refs/heads/c\nprunable gitdir file points to non-existent location\n",
    ].join("\n");
    expect(parseWorktreeList(text)).toEqual([
      { path: "/r/wt/a", head: "2222", branch: "feat/a", locked: "claude session 12", prunable: false },
      { path: "/r/wt/b", head: "3333", locked: "", prunable: false },
      { path: "/tmp/gone", head: "4444", branch: "c", prunable: true },
    ]);
  });
});

describe("gitEnv", () => {
  it("never points git at another repository, and never lets it prompt", () => {
    const env = gitEnv({ PATH: "/bin", GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", GIT_INDEX_FILE: "/tmp/i", GIT_AUTHOR_NAME: "me" });
    expect(env).toEqual({ PATH: "/bin", GIT_AUTHOR_NAME: "me", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("isRebuildable", () => {
  it("matches a status line by its last name or its extension", () => {
    const names = new Set(REBUILDABLE);
    expect(isRebuildable("node_modules/", names)).toBe(true);
    expect(isRebuildable("terraform/tenants/a/.terraform/", names)).toBe(true);
    expect(isRebuildable("lib/x.pyc", names)).toBe(true);
    expect(isRebuildable("lookout-0.1.3.vsix", names)).toBe(true);
    expect(isRebuildable(".env", names)).toBe(false);
    expect(isRebuildable("ops/fleet.kubeconfig", names)).toBe(false);
    expect(isRebuildable("notes/", names)).toBe(false);
  });
});

describe("findRepos", () => {
  it("finds main checkouts two levels down, not inside one, node_modules or a hidden folder", () => {
    const root = fs.realpathSync.native(tempConfigDir());
    for (const dir of ["a", "group/b", "group/deep/c", "node_modules/d", ".hidden/e", "a/inner"]) fs.mkdirSync(path.join(root, dir, ".git"), { recursive: true });
    expect(findRepos([root])).toEqual([path.join(root, "a"), path.join(root, "group", "b")]);
    expect(findRepos([path.join(root, "a")])).toEqual([path.join(root, "a")]);
  });
});

describe("measure", () => {
  it("counts a file linked from outside as shared and one linked twice inside as given back", () => {
    const root = fs.realpathSync.native(tempConfigDir());
    const tree = path.join(root, "tree");
    const store = path.join(root, "store");
    fs.mkdirSync(path.join(tree, "sub"), { recursive: true });
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(tree, "own.txt"), "x".repeat(10_000));
    fs.writeFileSync(path.join(store, "pkg.js"), "y".repeat(10_000));
    fs.linkSync(path.join(store, "pkg.js"), path.join(tree, "sub", "pkg.js"));
    fs.writeFileSync(path.join(tree, "twice.bin"), "z".repeat(10_000));
    fs.linkSync(path.join(tree, "twice.bin"), path.join(tree, "sub", "twice.bin"));
    const first = measure([tree]);
    // What the platform reports for each file, said when this fails there.
    const seen = JSON.stringify(
      ["own.txt", "sub/pkg.js", "twice.bin", "sub/twice.bin"].map((file) => {
        const st = fs.lstatSync(path.join(tree, file));
        return { file, nlink: st.nlink, ino: st.ino, blocks: st.blocks, size: st.size };
      }),
    );
    expect(first.sharedBytes, seen).toBeGreaterThan(0);
    // own.txt and the pair inside count once each: twice what the shared file takes.
    expect(first.ownBytes, seen).toBe(2 * first.sharedBytes);
  });

  it.skipIf(process.platform === "win32")("does not follow a symbolic link", () => {
    const root = fs.realpathSync.native(tempConfigDir());
    fs.mkdirSync(path.join(root, "big"));
    fs.writeFileSync(path.join(root, "big", "f"), "x".repeat(100_000));
    fs.mkdirSync(path.join(root, "tree"));
    fs.symlinkSync(path.join(root, "big"), path.join(root, "tree", "node_modules"));
    expect(measure([path.join(root, "tree")]).ownBytes).toBeLessThan(100_000);
  });
});

describe("checkWorktree", () => {
  it("calls a worktree safe once its change is squash-merged, though its branch was never pushed", async () => {
    const { repo, tree } = gitFixture();
    const top = tree("squashed");
    gitIn(repo, "worktree", "add", "-q", "-b", "feat/x", top);
    commitFile(top, "x.txt", "one\n");
    commitFile(top, "x.txt", "one\ntwo\n");
    // The pull request lands as one commit with the branch's whole change.
    gitIn(repo, "merge", "-q", "--squash", "feat/x");
    gitIn(repo, "commit", "-q", "-m", "feat: x (#1)");
    commitFile(repo, "later.txt", "main moved on\n");
    gitIn(repo, "push", "-q", "origin", "main");
    const check = await checkOf(repo, top);
    expect(check).toMatchObject({ tier: "safe", reason: "already on origin/main", landed: true, branch: "feat/x" });
    expect(check.ownBytes).toBeGreaterThan(0);
  });

  it("finds a squash merge further back than the newest commits it reads at once", async () => {
    const { repo, tree } = gitFixture();
    const top = tree("old");
    gitIn(repo, "worktree", "add", "-q", "-b", "feat/old", top);
    commitFile(top, "o.txt", "o\n");
    gitIn(repo, "merge", "-q", "--squash", "feat/old");
    gitIn(repo, "commit", "-q", "-m", "feat: old (#1)");
    for (const n of [1, 2, 3]) commitFile(repo, `later-${n}.txt`, `${n}\n`);
    gitIn(repo, "push", "-q", "origin", "main");
    // Two commits read at once: the squash is the fourth newest, so the range is read whole.
    const narrow = new MainPatchIds(repo, "origin/main", 2);
    expect(await checkOf(repo, top, { mainIds: narrow })).toMatchObject({ tier: "safe", landed: true });
    const wide = new MainPatchIds(repo, "origin/main", 10);
    expect(await checkOf(repo, top, { mainIds: wide })).toMatchObject({ tier: "safe", landed: true });
  });

  it("calls a pushed branch safe, and an unpushed one for review with its commits kept in its branch", async () => {
    const { repo, tree } = gitFixture();
    const pushed = tree("pushed");
    gitIn(repo, "worktree", "add", "-q", "-b", "feat/pushed", pushed);
    commitFile(pushed, "p.txt", "p\n");
    gitIn(pushed, "push", "-q", "origin", "feat/pushed");
    expect(await checkOf(repo, pushed)).toMatchObject({ tier: "safe", reason: "every commit is on a remote", landed: false });
    const local = tree("local");
    gitIn(repo, "worktree", "add", "-q", "-b", "feat/local", local);
    commitFile(local, "l.txt", "l\n");
    commitFile(local, "m.txt", "m\n");
    expect(await checkOf(repo, local)).toMatchObject({ tier: "review", reason: "2 commits on no remote, kept in its branch" });
  });

  it("holds a worktree with git work in the last day for review: a session may be at it from a folder of its own", async () => {
    const { repo, tree } = gitFixture();
    const top = tree("fresh");
    gitIn(repo, "worktree", "add", "-q", "-b", "feat/fresh", top);
    commitFile(top, "f.txt", "f\n");
    gitIn(top, "push", "-q", "origin", "feat/fresh");
    expect(await checkOf(repo, top, { quietMs: undefined })).toMatchObject({ tier: "review", reason: "worked on in the last day" });
    expect(await checkOf(repo, top)).toMatchObject({ tier: "safe", reason: "every commit is on a remote" });
  });

  it("lets rebuildable ignored files go, and holds one no tool builds again for review", async () => {
    const { repo, tree } = gitFixture();
    const top = tree("deps");
    gitIn(repo, "worktree", "add", "-q", "--detach", top, "origin/main");
    fs.mkdirSync(path.join(top, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(top, "node_modules", "pkg", "index.js"), "x");
    expect(await checkOf(repo, top)).toMatchObject({ tier: "safe", reason: "already on origin/main" });
    fs.writeFileSync(path.join(top, ".env"), "TOKEN=1\n");
    expect(await checkOf(repo, top)).toMatchObject({ tier: "review", reason: "1 ignored file no tool builds again", ignored: [".env"] });
  });

  it("keeps a worktree with changes, untracked files, a lock, a running session or another checkout inside", async () => {
    const { repo, tree } = gitFixture();
    const top = tree("busy");
    gitIn(repo, "worktree", "add", "-q", "--detach", top, "origin/main");
    fs.writeFileSync(path.join(top, "a.txt"), "changed\n");
    expect(await checkOf(repo, top)).toMatchObject({ tier: "keep", reason: "1 changed file" });
    gitIn(top, "checkout", "-q", "a.txt");
    fs.writeFileSync(path.join(top, "new.txt"), "new\n");
    expect(await checkOf(repo, top)).toMatchObject({ tier: "keep", reason: "1 untracked file" });
    fs.rmSync(path.join(top, "new.txt"));
    const session: InUse = { dir: path.join(top, "src"), why: "a session is running in it" };
    expect(await checkOf(repo, top, { inUse: [session] })).toMatchObject({ tier: "keep", reason: "a session is running in it" });
    // A window on the folder that holds every worktree uses none of them.
    expect(await checkOf(repo, top, { inUse: [{ dir: path.dirname(top), why: "open in a VS Code window" }] })).toMatchObject({ tier: "safe" });
    expect(await checkOf(repo, top, { allTops: [repo, path.join(top, "nested")] })).toMatchObject({ tier: "keep", reason: "holds another checkout (nested)" });
    gitIn(repo, "worktree", "lock", "--reason", "claude session 12", top);
    expect(await checkOf(repo, top)).toMatchObject({ tier: "keep", reason: "locked: claude session 12" });
  });

  it("keeps a detached head's own commits, holds a starred session's worktree for review, and calls a vanished folder gone", async () => {
    const { repo, tree } = gitFixture();
    const top = tree("detached");
    gitIn(repo, "worktree", "add", "-q", "--detach", top, "origin/main");
    commitFile(top, "d.txt", "d\n");
    expect(await checkOf(repo, top)).toMatchObject({ tier: "keep", reason: "1 commit on no branch" });
    const starred = tree("starred");
    gitIn(repo, "worktree", "add", "-q", "--detach", starred, "origin/main");
    expect(await checkOf(repo, starred, { inUse: [{ dir: starred, why: "a starred session worked in it", soft: true }] })).toMatchObject({ tier: "review", reason: "a starred session worked in it" });
    fs.rmSync(starred, { recursive: true, force: true });
    expect(await checkOf(repo, starred)).toMatchObject({ tier: "gone", reason: "its folder is gone", ownBytes: 0 });
  });
});

describe("survey", () => {
  it("finds the repositories under a folder and checks every worktree, wherever it lives", async () => {
    const { root, repo, tree } = gitFixture();
    gitIn(repo, "worktree", "add", "-q", "--detach", tree("one"), "origin/main");
    const inside = path.join(repo, ".claude", "worktrees", "two");
    gitIn(repo, "worktree", "add", "-q", "-b", "two", inside);
    commitFile(inside, "t.txt", "t\n");
    const seen: number[] = [];
    const result = await survey({ folders: [root], repos: [], inUse: [], rebuildable: REBUILDABLE, quietMs: 0 }, (progress) => seen.push(progress.done));
    expect(result.repos.map((info) => [info.repo, info.defaultRef])).toEqual([[repo, "origin/main"]]);
    expect(result.worktrees.map((check) => [path.basename(check.path), check.tier]).sort()).toEqual([
      ["one", "safe"],
      ["two", "review"],
    ]);
    expect(seen.at(-1)).toBe(2);
  });
});

describe("removeWorktree and restoreWorktree", () => {
  it("removes a safe worktree with its landed branch, then puts both back at the same commit", async () => {
    const { repo, tree } = gitFixture();
    const top = tree("landed");
    gitIn(repo, "worktree", "add", "-q", "-b", "feat/l", top);
    commitFile(top, "l.txt", "l\n");
    const head = gitIn(top, "rev-parse", "HEAD");
    gitIn(repo, "merge", "-q", "--squash", "feat/l");
    gitIn(repo, "commit", "-q", "-m", "feat: l (#2)");
    gitIn(repo, "push", "-q", "origin", "main");
    // It gives back what the check measured: the folders are not walked a second time.
    const removed = await removeWorktree({ repo, path: top, shownAs: "safe", bytes: 4096 }, { inUse: [], rebuildable: REBUILDABLE, quietMs: 0 });
    expect(removed).toMatchObject({ ok: true, branch: "feat/l", head, branchDeleted: true, freedBytes: 4096 });
    expect(fs.existsSync(top)).toBe(false);
    expect(() => gitIn(repo, "rev-parse", "--verify", "refs/heads/feat/l")).toThrow();
    expect(await restoreWorktree({ repo, path: top, branch: "feat/l", head, branchDeleted: true, removedAt: 0 })).toEqual({ ok: true });
    expect(gitIn(top, "rev-parse", "HEAD")).toBe(head);
    expect(gitIn(top, "branch", "--show-current")).toBe("feat/l");
    expect(await restoreWorktree({ repo, path: top, branch: "feat/l", head, removedAt: 0 })).toEqual({ ok: false, error: "something is in its place" });
  });

  it("refuses one that changed since the check, removes one picked for review with its ignored files, and keeps its unlanded branch", async () => {
    const { repo, tree } = gitFixture();
    const top = tree("wip");
    gitIn(repo, "worktree", "add", "-q", "-b", "feat/wip", top);
    commitFile(top, "w.txt", "w\n");
    // Shown as safe, it has commits on no remote now.
    expect(await removeWorktree({ repo, path: top, shownAs: "safe" }, { inUse: [], rebuildable: REBUILDABLE, quietMs: 0 })).toMatchObject({ ok: false, error: "changed since the check: 1 commit on no remote, kept in its branch" });
    fs.writeFileSync(path.join(top, "new.txt"), "n\n");
    expect(await removeWorktree({ repo, path: top, shownAs: "review" }, { inUse: [], rebuildable: REBUILDABLE, quietMs: 0 })).toMatchObject({ ok: false, error: "kept now: 1 untracked file" });
    fs.rmSync(path.join(top, "new.txt"));
    fs.writeFileSync(path.join(top, ".env"), "TOKEN=1\n");
    const removed = await removeWorktree({ repo, path: top, shownAs: "review" }, { inUse: [], rebuildable: REBUILDABLE, quietMs: 0 });
    expect(removed).toMatchObject({ ok: true, branch: "feat/wip" });
    expect(removed.branchDeleted).toBeUndefined();
    expect(fs.existsSync(top)).toBe(false);
    expect(gitIn(repo, "rev-parse", "--verify", "refs/heads/feat/wip")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("clears the record of a worktree whose folder is gone", async () => {
    const { repo, tree } = gitFixture();
    const top = tree("vanished");
    gitIn(repo, "worktree", "add", "-q", "--detach", top, "origin/main");
    fs.rmSync(top, { recursive: true, force: true });
    expect(await removeWorktree({ repo, path: top, shownAs: "gone" }, { inUse: [], rebuildable: REBUILDABLE, quietMs: 0 })).toMatchObject({ ok: true, record: true });
    expect(await listWorktrees(repo)).toEqual([]);
  });
});

describe("removeWorktrees", () => {
  it("removes a batch across repositories, answering in the order asked, with how far it got and what came back so far", async () => {
    const a = gitFixture();
    const b = gitFixture();
    const top = (fixture: ReturnType<typeof gitFixture>, name: string) => {
      const dir = fixture.tree(name);
      gitIn(fixture.repo, "worktree", "add", "-q", "--detach", dir, "origin/main");
      return dir;
    };
    const a1 = top(a, "a1");
    const b1 = top(b, "b1");
    const a2 = top(a, "a2");
    const seen: SurveyProgress[] = [];
    const removals = await removeWorktrees(
      [
        { repo: a.repo, path: a1, shownAs: "safe", bytes: 100 },
        { repo: b.repo, path: b1, shownAs: "safe", bytes: 200 },
        { repo: a.repo, path: a2, shownAs: "safe", bytes: 300 },
      ],
      { inUse: [], rebuildable: REBUILDABLE, quietMs: 0 },
      (progress) => seen.push(progress),
    );
    expect(removals.map((removal) => [removal.path, removal.ok, removal.freedBytes])).toEqual([
      [a1, true, 100],
      [b1, true, 200],
      [a2, true, 300],
    ]);
    for (const dir of [a1, b1, a2]) expect(fs.existsSync(dir)).toBe(false);
    expect(seen[0]).toEqual({ done: 0, total: 3, freedBytes: 0 });
    expect(seen.at(-1)).toEqual({ done: 3, total: 3, freedBytes: 600 });
    const finished = seen.filter((progress) => progress.current === undefined).map((progress) => progress.done);
    expect(finished).toEqual([0, 1, 2, 3]);
    expect(seen.filter((progress) => progress.current).map((progress) => progress.current).sort()).toEqual([a1, a2, b1].sort());
  });

  it("reads a repository's default branch and its patch ids once for the whole batch", async () => {
    const { repo } = gitFixture();
    const shared = new RemovalShared();
    const first = shared.of(repo);
    expect(shared.of(repo)).toBe(first);
    const { defaultRef, mainIds } = await first;
    expect(defaultRef).toBe("origin/main");
    expect(mainIds).toBeInstanceOf(MainPatchIds);
    expect(await removeWorktrees([], { inUse: [], rebuildable: REBUILDABLE, quietMs: 0 })).toEqual([]);
  });
});

describe("which git, and whether it will do", () => {
  // Each entry point sets the git it runs; a test that changes it puts the PATH's back.
  afterEach(() => useGit());

  it("reads the version git prints, wherever it was built", () => {
    expect(parseGitVersion("git version 2.45.1\n")).toEqual([2, 45, 1]);
    expect(parseGitVersion("git version 2.39.3 (Apple Git-145)")).toEqual([2, 39, 3]);
    expect(parseGitVersion("git version 2.47.0.windows.2")).toEqual([2, 47, 0]);
    expect(parseGitVersion("git version 2.7")).toEqual([2, 7, 0]);
    expect(parseGitVersion("command not found")).toBeUndefined();
  });

  it("takes VS Code's git.path when it names a git that exists: a path, or the first of a list", () => {
    const exists = (file: string) => file === "/opt/git/bin/git" || file === "C:\\Git\\bin\\git.exe";
    expect(pickGit("/opt/git/bin/git", exists)).toBe("/opt/git/bin/git");
    expect(pickGit(" /opt/git/bin/git ", exists)).toBe("/opt/git/bin/git");
    expect(pickGit(["/missing/git", 7, "C:\\Git\\bin\\git.exe", "/opt/git/bin/git"], exists)).toBe("C:\\Git\\bin\\git.exe");
    expect(pickGit("/missing/git", exists)).toBeUndefined();
    expect(pickGit(["", "/missing/git"], exists)).toBeUndefined();
    for (const empty of [null, undefined, "", 3, {}]) expect(pickGit(empty, exists)).toBeUndefined();
  });

  it("finds a command on the PATH the way a shell does", () => {
    const dirs = [path.resolve("/a"), path.resolve("/b")];
    const env = { PATH: dirs.join(path.delimiter), PATHEXT: ".EXE;.CMD" };
    const want = path.join(dirs[1]!, process.platform === "win32" ? "git.EXE" : "git");
    expect(onPath("git", env, (file) => file === want)).toBe(want);
    expect(onPath("git", env, () => false)).toBeUndefined();
    expect(onPath("git", {}, () => true)).toBeUndefined();
  });

  it("says nothing of a git that will do", async () => {
    expect(await gitProblem()).toBeUndefined();
  });

  it("says when git cannot run, and the check, a removal and a restore stop there", async () => {
    const missing = path.join(tempConfigDir(), "no-such-git");
    useGit(missing);
    expect(await gitProblem()).toMatch(new RegExp(`^Lookout could not run ${missing.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} \\(spawn .*ENOENT\\)\\. Install git, or point VS Code's git\\.path setting at it, then check again\\.$`));
    const { root, repo, tree } = gitFixture();
    const top = tree("one");
    gitIn(repo, "worktree", "add", "-q", "--detach", top, "origin/main");
    const checked = await survey({ folders: [root], repos: [], inUse: [], rebuildable: REBUILDABLE, quietMs: 0, git: missing });
    expect(checked).toMatchObject({ repos: [], worktrees: [], gitProblem: expect.stringMatching(/^Lookout could not run/) });
    const removals = await removeWorktrees([{ repo, path: top, shownAs: "safe" }], { inUse: [], rebuildable: REBUILDABLE, quietMs: 0, git: missing });
    expect(removals).toMatchObject([{ path: top, ok: false, error: expect.stringMatching(/^Lookout could not run/) }]);
    expect(fs.existsSync(top)).toBe(true);
    const elsewhere = path.join(root, "put-back");
    expect(await restoreWorktree({ repo, path: elsewhere, head: gitIn(repo, "rev-parse", "HEAD"), removedAt: 0 }, missing)).toMatchObject({ ok: false, error: expect.stringMatching(/^Lookout could not run/) });
    expect(fs.existsSync(elsewhere)).toBe(false);
    // The next check with the PATH's git finds the worktree again.
    expect((await survey({ folders: [root], repos: [], inUse: [], rebuildable: REBUILDABLE, quietMs: 0 })).worktrees.map((check) => check.path)).toEqual([top]);
  });

  it.skipIf(process.platform === "win32")("says when git is older than the first that removes a worktree", async () => {
    const old = path.join(tempConfigDir(), "git");
    fs.writeFileSync(old, "#!/bin/sh\necho 'git version 2.7.4'\n", { mode: 0o755 });
    useGit(old);
    expect(await gitProblem()).toBe("git 2.7.4 is older than 2.17, the first that removes a worktree. Update git to clean up worktrees here, then check again.");
    fs.writeFileSync(old, "#!/bin/sh\necho 'git version 2.17.0'\n", { mode: 0o755 });
    expect(await gitProblem()).toBeUndefined();
    fs.writeFileSync(old, "#!/bin/sh\necho 'hello'\n", { mode: 0o755 });
    expect(await gitProblem()).toBe(`${old} did not say which version it is, so Lookout leaves the worktrees alone.`);
  });

  it("asks a Mac whether its git is Apple's stand-in before running it", async () => {
    // Elsewhere than a Mac, xcode-select is not there, which is how a Mac without the Command Line Tools answers too.
    if (process.platform !== "darwin") {
      expect(await gitProblem("darwin", () => "/usr/bin/git")).toBe("This Mac's git is Apple's stand-in until the Command Line Tools are installed: run xcode-select --install, or install git another way, then check again.");
    }
    // A git from elsewhere on the PATH, or one git.path names, is not the stand-in.
    expect(await gitProblem("darwin", () => "/opt/homebrew/bin/git")).toBeUndefined();
    expect(await gitProblem("linux", () => "/usr/bin/git")).toBeUndefined();
  });

  it("reads a lock from git's own file, which older git leaves out of its list", () => {
    const { repo, tree } = gitFixture();
    const reasoned = tree("reasoned");
    const bare = tree("bare");
    const open = tree("open");
    for (const dir of [reasoned, bare, open]) gitIn(repo, "worktree", "add", "-q", "--detach", dir, "origin/main");
    gitIn(repo, "worktree", "lock", "--reason", "a long rehearsal", reasoned);
    gitIn(repo, "worktree", "lock", bare);
    expect(lockedFromFile(reasoned)).toBe("a long rehearsal");
    expect(lockedFromFile(bare)).toBe("");
    expect(lockedFromFile(open)).toBeUndefined();
    expect(lockedFromFile(path.join(repo, "nowhere"))).toBeUndefined();
    expect(lockedFromFile(repo)).toBeUndefined();
  });
});
