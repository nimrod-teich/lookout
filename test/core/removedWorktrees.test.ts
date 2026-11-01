import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RemovedWorktrees, RESTORE_DAYS } from "../../src/core/removedWorktrees";
import { tempConfigDir } from "./helpers";

const DAY = 24 * 60 * 60_000;

describe("RemovedWorktrees", () => {
  it("keeps the removals newest first, one per folder, for the days a restore can work, and lets one go", () => {
    const file = path.join(tempConfigDir(), "worktrees", "removed.json");
    const list = new RemovedWorktrees(file);
    expect(list.list()).toEqual([]);
    const now = 100 * DAY;
    expect(list.add([{ repo: "/r", path: "/w/old", removedAt: now - (RESTORE_DAYS + 1) * DAY }], now - (RESTORE_DAYS + 1) * DAY)).toBe(true);
    list.add([{ repo: "/r", path: "/w/a", branch: "feat/a", removedAt: now - DAY }], now);
    list.add([{ repo: "/r", path: "/w/b", removedAt: now }], now);
    // Removed again after a restore: only the newest removal stays.
    list.add([{ repo: "/r", path: "/w/a", branch: "feat/a", head: "abc", removedAt: now }], now);
    expect(list.list(now).map((record) => [record.path, record.head])).toEqual([
      ["/w/a", "abc"],
      ["/w/b", undefined],
    ]);
    // Another window reads the same file.
    expect(new RemovedWorktrees(file).list(now)).toHaveLength(2);
    list.drop("/w/a", now);
    expect(list.list(now).map((record) => record.path)).toEqual(["/w/b"]);
  });

  it("reads a broken or foreign file as empty", () => {
    const file = path.join(tempConfigDir(), "removed.json");
    fs.writeFileSync(file, "{ not json");
    expect(new RemovedWorktrees(file).list()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify([{ path: "/w/x" }, { repo: "/r", path: "/w/y", removedAt: Date.now() }]));
    expect(new RemovedWorktrees(file).list().map((record) => record.path)).toEqual(["/w/y"]);
  });
});
