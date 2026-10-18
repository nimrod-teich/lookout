import { describe, expect, it } from "vitest";
import { matchRollouts, type LiveProcess, type RolloutInfo } from "../../../../src/core/agents/codex/match";

const T = Date.parse("2026-10-18T12:00:00.000Z");
const MIN = 60_000;

function rollout(id: string, overrides: Partial<RolloutInfo> = {}): RolloutInfo {
  return { file: `/codex/sessions/2026/10/18/rollout-${id}.jsonl`, id, cwd: "/work/app", createdAt: T, mtimeMs: T, originator: "codex-tui", ...overrides };
}

function ids(matched: Map<number, RolloutInfo>): Record<number, string> {
  return Object.fromEntries([...matched].map(([pid, r]) => [pid, r.id]));
}

describe("matchRollouts", () => {
  it("ties a resumed session to the thread its command line names", () => {
    const procs: LiveProcess[] = [{ pid: 1, cwd: "/work/app", startedMs: T + 10 * MIN, resumeId: "old" }];
    const rollouts = [rollout("old", { createdAt: T - 86_400_000, mtimeMs: T + 11 * MIN }), rollout("new", { createdAt: T + 10 * MIN, mtimeMs: T + 12 * MIN })];
    expect(ids(matchRollouts(procs, rollouts))).toEqual({ 1: "old" });
  });

  it("gives each process a rollout of its own folder written while it ran", () => {
    const procs: LiveProcess[] = [
      { pid: 1, cwd: "/work/app", startedMs: T },
      { pid: 2, cwd: "/work/web", startedMs: T },
    ];
    const rollouts = [rollout("web", { cwd: "/work/web", createdAt: T + MIN, mtimeMs: T + 5 * MIN }), rollout("app", { createdAt: T + MIN, mtimeMs: T + 4 * MIN }), rollout("stale", { createdAt: T - 60 * MIN, mtimeMs: T - 30 * MIN })];
    expect(ids(matchRollouts(procs, rollouts))).toEqual({ 1: "app", 2: "web" });
  });

  it("takes the thread switched to last, and leaves a process with no rollout yet unmatched", () => {
    const procs: LiveProcess[] = [{ pid: 1, cwd: "/work/app", startedMs: T }, { pid: 2, cwd: "/work/other", startedMs: T }];
    const rollouts = [rollout("first", { createdAt: T + MIN, mtimeMs: T + 2 * MIN }), rollout("after-new", { createdAt: T + 3 * MIN, mtimeMs: T + 6 * MIN })];
    expect(ids(matchRollouts(procs, rollouts))).toEqual({ 1: "after-new" });
  });

  it("gives each thread to the process that created it: the one of its folder that started last before it", () => {
    const procs: LiveProcess[] = [
      { pid: 1, cwd: "/work/app", startedMs: T },
      { pid: 2, cwd: "/work/app", startedMs: T + 10 * MIN },
    ];
    // The older session wrote last, but its thread was created before the newer process started.
    const rollouts = [rollout("older", { createdAt: T + MIN, mtimeMs: T + 20 * MIN }), rollout("newer", { createdAt: T + 11 * MIN, mtimeMs: T + 15 * MIN })];
    expect(ids(matchRollouts(procs, rollouts))).toEqual({ 1: "older", 2: "newer" });
  });

  it("breaks a tie between two threads written in the same second by which one moved since the last look", () => {
    const procs: LiveProcess[] = [{ pid: 1, cwd: "/work/app", startedMs: T }];
    const a = rollout("a", { file: "/a", createdAt: T + MIN, mtimeMs: T + 5 * MIN + 100 });
    const b = rollout("b", { file: "/b", createdAt: T + 2 * MIN, mtimeMs: T + 5 * MIN + 300 });
    expect(ids(matchRollouts(procs, [a, b], (file) => file === "/a"))).toEqual({ 1: "a" });
    expect(ids(matchRollouts(procs, [a, b], (file) => file === "/b"))).toEqual({ 1: "b" });
    // Neither moved: the newer thread.
    expect(ids(matchRollouts(procs, [a, b]))).toEqual({ 1: "b" });
  });

  it("prefers the terminal program's threads to an editor extension's in the same folder", () => {
    const procs: LiveProcess[] = [{ pid: 1, cwd: "/work/app", startedMs: T }];
    const rollouts = [rollout("panel", { originator: "codex_vscode", createdAt: T + 2 * MIN, mtimeMs: T + 9 * MIN }), rollout("tui", { createdAt: T + MIN, mtimeMs: T + 3 * MIN })];
    expect(ids(matchRollouts(procs, rollouts))).toEqual({ 1: "tui" });
  });

  it("compares no folder where the platform does not tell a process's (Windows), and none written before it started", () => {
    const procs: LiveProcess[] = [{ pid: 1, startedMs: T }];
    const rollouts = [rollout("before", { cwd: "C:\\work\\a", createdAt: T - 9 * MIN, mtimeMs: T - 5 * MIN }), rollout("mine", { cwd: "C:\\work\\b", createdAt: T + MIN, mtimeMs: T + 2 * MIN })];
    expect(ids(matchRollouts(procs, rollouts))).toEqual({ 1: "mine" });
    expect(ids(matchRollouts([{ pid: 2, cwd: "C:\\work\\b\\", startedMs: T }], rollouts))).toEqual({ 2: "mine" });
  });

  it("leaves a session with nothing sent yet unmatched, though others of its folder have threads (checked live)", () => {
    // Three sessions started 7 s apart in one folder; the third sits at a prompt and has no thread yet.
    const procs: LiveProcess[] = [
      { pid: 1, cwd: "/work/app", startedMs: T },
      { pid: 2, cwd: "/work/app", startedMs: T + 7_000 },
      { pid: 3, cwd: "/work/app", startedMs: T + 14_000 },
    ];
    const rollouts = [rollout("approval", { createdAt: T + 2_700, mtimeMs: T + 6_000 }), rollout("working", { createdAt: T + 9_000, mtimeMs: T + 60_000 })];
    expect(ids(matchRollouts(procs, rollouts))).toEqual({ 1: "approval", 2: "working" });
  });

  it("gives a process with no thread of its own one it resumed from the picker, never one another process owns", () => {
    const procs: LiveProcess[] = [{ pid: 1, cwd: "/work/app", startedMs: T + 10 * MIN }, { pid: 2, cwd: "/work/app", startedMs: T }];
    const rollouts = [rollout("yesterday", { createdAt: T - 86_400_000, mtimeMs: T + 12 * MIN }), rollout("of-two", { createdAt: T + MIN, mtimeMs: T + 15 * MIN })];
    expect(ids(matchRollouts(procs, rollouts))).toEqual({ 1: "yesterday", 2: "of-two" });
    // Nothing resumed: the newer process stays empty rather than take the other's thread.
    expect(ids(matchRollouts(procs, [rollouts[1]!]))).toEqual({ 2: "of-two" });
  });
});
