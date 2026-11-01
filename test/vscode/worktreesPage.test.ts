import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemovedWorktrees } from "../../src/core/removedWorktrees";
import { REBUILDABLE, removeWorktree, restoreWorktree, survey, type SurveyInput } from "../../src/core/worktrees";
import type { WorktreesState } from "../../src/webview/worktreesProtocol";
import { WorktreesPage, type WorktreeRunner } from "../../src/vscode/worktreesPage";
import { commitFile, gitFixture, gitIn } from "../core/helpers";
import { stub } from "./stub-vscode";

/** The worktree thread's work, done here. */
const inProcess: WorktreeRunner = {
  survey: (input, onProgress) => survey(input, onProgress),
  async remove(asks, input) {
    const removals = [];
    for (const ask of asks) removals.push(await removeWorktree(ask, input));
    return { removals };
  },
  restore: (record) => restoreWorktree(record),
};

function setup() {
  const { root, repo, tree } = gitFixture();
  // Landed through a squash merge: safe, and its branch goes with it.
  const landed = tree("landed");
  gitIn(repo, "worktree", "add", "-q", "-b", "feat/landed", landed);
  commitFile(landed, "l.txt", "l\n");
  gitIn(repo, "merge", "-q", "--squash", "feat/landed");
  gitIn(repo, "commit", "-q", "-m", "feat: landed (#1)");
  gitIn(repo, "push", "-q", "origin", "main");
  // Its own commit on no remote: for review.
  const wip = tree("wip");
  gitIn(repo, "worktree", "add", "-q", "-b", "feat/wip", wip);
  commitFile(wip, "w.txt", "w\n");
  // A session runs in it: kept.
  const busy = tree("busy");
  gitIn(repo, "worktree", "add", "-q", "--detach", busy, "origin/main");
  const input: SurveyInput = { folders: [root], repos: [], inUse: [{ dir: busy, why: "a session is running in it" }], rebuildable: REBUILDABLE, quietMs: 0 };
  const removed = new RemovedWorktrees(path.join(root, "storage", "removed.json"));
  const actions = { input: () => input, confirm: vi.fn(async () => true), reveal: vi.fn(), openSettings: vi.fn() };
  const page = new WorktreesPage({ fsPath: "/ext" } as never, inProcess, removed, actions);
  return { repo, landed, wip, busy, page, actions, removed };
}

/** The page's last state, as the panel was sent it. */
function shown(): WorktreesState {
  const posted = stub.panels.at(-1)!.posted.filter((m): m is { type: "state"; state: WorktreesState } => (m as { type?: string }).type === "state");
  return posted.at(-1)!.state;
}

async function settled(page: WorktreesPage): Promise<void> {
  await vi.waitFor(() => expect(page.current.busy).toBeUndefined(), { timeout: 20_000 });
}

describe("WorktreesPage", () => {
  beforeEach(() => stub.reset());

  it("checks the worktrees the first time it opens, in their tiers, and not again on the next", async () => {
    const { page, landed, wip, busy } = setup();
    page.show();
    await settled(page);
    expect(shown().rows.map((row) => [row.name, row.tier, row.reason])).toEqual(
      expect.arrayContaining([
        ["landed", "safe", "already on origin/main"],
        ["wip", "review", "1 commit on no remote, kept in its branch"],
        ["busy", "keep", "a session is running in it"],
      ]),
    );
    expect(shown().rows.map((row) => row.path).sort()).toEqual([busy, landed, wip].sort());
    const checkedAt = page.current.checkedAt;
    page.show();
    expect(page.current.busy).toBeUndefined();
    expect(page.current.checkedAt).toBe(checkedAt);
    page.dispose();
  });

  it("asks before removing, removes what it was asked, never a kept one, and puts one back", async () => {
    const { page, actions, removed, landed, wip, busy } = setup();
    page.show();
    await settled(page);
    const panel = stub.panels.at(-1)!;
    // Declined: nothing goes.
    actions.confirm.mockResolvedValueOnce(false);
    await page.remove([landed]);
    expect(fs.existsSync(landed)).toBe(true);
    panel.receive({ type: "remove", paths: [landed, wip, busy] });
    await vi.waitFor(() => expect(page.current.summary).toBeDefined(), { timeout: 20_000 });
    await settled(page);
    expect(actions.confirm).toHaveBeenLastCalledWith(
      "Remove 2 worktrees?",
      expect.stringMatching(/^Frees about .+\. 1 is for review: what it holds that no tool builds again goes too\. 1 branch whose change is on the default branch goes too\. Each worktree can be put back from this page for 14 days, without its ignored files\.$/),
      "Remove",
    );
    expect(page.current.summary).toMatchObject({ removed: 2, records: 0, branchesDeleted: 1, failed: [] });
    expect(fs.existsSync(landed)).toBe(false);
    expect(fs.existsSync(wip)).toBe(false);
    expect(fs.existsSync(busy)).toBe(true);
    expect(shown().rows.map((row) => row.path)).toEqual([busy]);
    expect(shown().removed.map((row) => [row.name, row.branch, row.branchDeleted]).sort()).toEqual([
      ["landed", "feat/landed", true],
      ["wip", "feat/wip", undefined],
    ]);
    panel.receive({ type: "restore", path: landed });
    await vi.waitFor(() => expect(page.current.notice).toBe("landed is back on feat/landed, without its ignored files: install its dependencies again before you build in it."), { timeout: 20_000 });
    expect(fs.existsSync(path.join(landed, "l.txt"))).toBe(true);
    expect(removed.list().map((record) => record.path)).toEqual([wip]);
    page.dispose();
  });

  it("reveals only a folder it lists", async () => {
    const { page, actions, landed } = setup();
    page.show();
    await settled(page);
    const panel = stub.panels.at(-1)!;
    panel.receive({ type: "reveal", path: "/etc" });
    panel.receive({ type: "reveal", path: landed });
    expect(actions.reveal.mock.calls).toEqual([[landed]]);
    panel.receive({ type: "settings" });
    expect(actions.openSettings).toHaveBeenCalledOnce();
    page.dispose();
  });
});
