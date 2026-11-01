import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { branchAt, worktreeAt } from "../../src/core/git";
import { applyLine, emptyTranscript } from "../../src/core/agents/claude/transcript";
import { linkWorktree, tempConfigDir } from "./helpers";

describe("branchAt", () => {
  it("reads the branch of the nearest checkout, a worktree's own, and nothing on a detached head or outside a repo", () => {
    const root = tempConfigDir();
    const repo = path.join(root, "app");
    fs.mkdirSync(path.join(repo, ".git", "worktrees", "fix-x"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    expect(branchAt(path.join(repo, "src", "deep"))).toBe("main");
    // A worktree's .git is a file naming its git directory.
    const tree = path.join(repo, ".claude", "worktrees", "fix-x");
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "fix-x")}\n`);
    fs.writeFileSync(path.join(repo, ".git", "worktrees", "fix-x", "HEAD"), "ref: refs/heads/feat/fix-x\n");
    expect(branchAt(tree)).toBe("feat/fix-x");
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    expect(branchAt(repo)).toBeUndefined();
    expect(branchAt(path.join(root, "elsewhere"))).toBeUndefined();
  });
});

describe("worktreeAt", () => {
  it("finds a worktree's repository wherever the worktree lives", () => {
    const root = tempConfigDir();
    const repo = path.join(root, "app");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const beside = path.join(root, "_worktrees", "fix-x");
    linkWorktree(repo, beside);
    fs.mkdirSync(path.join(beside, "src"));
    expect(worktreeAt(path.join(beside, "src"))).toEqual({ top: beside, main: repo });
    // Inside another repository's folder, it is still the repository that made it.
    const other = path.join(root, "web");
    fs.mkdirSync(path.join(other, ".git"), { recursive: true });
    const inside = path.join(other, ".claude", "worktrees", "app-main");
    linkWorktree(repo, inside);
    expect(worktreeAt(inside)).toEqual({ top: inside, main: repo });
    expect(worktreeAt(other)).toBeUndefined();
    // A relative path names no folder of a session's; it is never read against this process's own.
    // (Across Windows drives there is no relative path to it: path.relative gives the absolute one.)
    const relative = path.relative(process.cwd(), beside);
    if (!path.isAbsolute(relative)) expect(worktreeAt(relative)).toBeUndefined();
    expect(worktreeAt(path.join("_worktrees", "fix-x"))).toBeUndefined();
  });

  it("names a bare repository by its own folder, and nothing for a submodule or a forgotten worktree", () => {
    const root = tempConfigDir();
    const bare = path.join(root, "app.git");
    const own = path.join(bare, "worktrees", "main");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "commondir"), "../..\n");
    const top = path.join(root, "main");
    fs.mkdirSync(top);
    fs.writeFileSync(path.join(top, ".git"), `gitdir: ${own}\n`);
    expect(worktreeAt(top)).toEqual({ top, main: bare });
    // A submodule's .git names a module directory, which has no commondir.
    const sub = path.join(root, "app", "vendor", "lib");
    fs.mkdirSync(path.join(root, "app", ".git", "modules", "lib"), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
    expect(worktreeAt(sub)).toBeUndefined();
    // A worktree whose record git pruned.
    const gone = path.join(root, "gone");
    fs.mkdirSync(gone);
    fs.writeFileSync(path.join(gone, ".git"), `gitdir: ${path.join(root, "app", ".git", "worktrees", "gone")}\n`);
    expect(worktreeAt(gone)).toBeUndefined();
  });
});

describe("effort", () => {
  it("takes the reasoning effort of the latest main-chain reply", () => {
    const state = emptyTranscript();
    applyLine(state, JSON.stringify({ type: "assistant", effort: "xhigh", message: { id: "m1", model: "claude-opus-5-5", content: [] } }));
    applyLine(state, JSON.stringify({ type: "assistant", effort: "low", isSidechain: true, message: { id: "m2", model: "claude-opus-5-5", content: [] } }));
    expect(state.effort).toBe("xhigh");
    applyLine(state, JSON.stringify({ type: "assistant", effort: "low", message: { id: "m3", model: "claude-opus-5-5", content: [] } }));
    expect(state.effort).toBe("low");
  });
});
