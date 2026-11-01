import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { STOPPED, WorktreeWorker } from "../../src/core/worktreeWorker";
import { REBUILDABLE } from "../../src/core/worktrees";
import { buildWorktreeThread } from "../readerBundle";
import { gitFixture, gitIn, tempConfigDir } from "./helpers";

describe("WorktreeWorker", () => {
  it("checks, removes and restores in the worktree thread, saying how far it got", async () => {
    const { root, repo, tree } = gitFixture();
    const top = tree("one");
    gitIn(repo, "worktree", "add", "-q", "--detach", top, "origin/main");
    const worker = new WorktreeWorker(buildWorktreeThread(tempConfigDir()));
    try {
      const seen: number[] = [];
      const survey = await worker.survey({ folders: [root], repos: [], inUse: [], rebuildable: REBUILDABLE, quietMs: 0 }, (progress) => seen.push(progress.done));
      expect(survey.worktrees.map((check) => [check.path, check.tier])).toEqual([[top, "safe"]]);
      expect(seen).toContain(1);
      const done = await worker.remove([{ repo, path: top, shownAs: "safe" }], { inUse: [], rebuildable: REBUILDABLE, quietMs: 0 });
      expect(done.removals).toMatchObject([{ path: top, ok: true }]);
      expect(fs.existsSync(top)).toBe(false);
      const head = gitIn(repo, "rev-parse", "origin/main");
      expect(await worker.restore({ repo, path: top, head, removedAt: Date.now() })).toEqual({ ok: true });
      expect(fs.existsSync(path.join(top, "a.txt"))).toBe(true);
    } finally {
      worker.dispose();
    }
  });

  it("stops what it was doing on request, rejecting it as stopped, and answers the next ask from a new thread", async () => {
    const { root, repo, tree } = gitFixture();
    const top = tree("one");
    gitIn(repo, "worktree", "add", "-q", "--detach", top, "origin/main");
    const worker = new WorktreeWorker(buildWorktreeThread(tempConfigDir()));
    try {
      const input = { folders: [root], repos: [], inUse: [], rebuildable: REBUILDABLE, quietMs: 0 };
      const stopped = worker.survey(input);
      worker.stop();
      await expect(stopped).rejects.toThrow(STOPPED);
      const survey = await worker.survey(input);
      expect(survey.worktrees.map((check) => check.path)).toEqual([top]);
    } finally {
      worker.dispose();
    }
  });

  it("rejects what it was asked when the thread cannot start, and is ready again after", async () => {
    const worker = new WorktreeWorker(path.join(tempConfigDir(), "missing.js"));
    await expect(worker.restore({ repo: "/r", path: "/w", removedAt: 0 })).rejects.toThrow();
    worker.dispose();
  });
});
