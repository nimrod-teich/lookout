import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { branchAt } from "../../src/core/git";
import { applyLine, emptyTranscript } from "../../src/core/agents/claude/transcript";
import { tempConfigDir } from "./helpers";

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
