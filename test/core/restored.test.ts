import { describe, expect, it } from "vitest";
import { restoredTabViews } from "../../src/core/model";
import type { PastView, SessionView } from "../../src/core/types";

const label = (title: string) => (title.length > 25 ? `${title.substring(0, 24)}…` : title);

function past(id: string, title: string, modifiedAt: number, resumable = true): PastView {
  return { id, agent: "claude", title, project: "app", branch: "main", cwd: "/work/app", resumable, modifiedAt };
}

function live(id: string, title: string, host: SessionView["host"] = "panel"): SessionView {
  return { id, agent: "claude", pid: 42, title, state: "idle", project: "app", cwd: "/work/app", host, agents: 0 };
}

describe("restoredTabViews", () => {
  it("shows the session behind each open tab as idle and not started, from its transcript", () => {
    const views = restoredTabViews([past("a", "Tune the deploy script for staging", 1_000)], [], { labels: ["Tune the deploy script f…"], label });
    expect(views).toEqual([
      {
        id: "a",
        agent: "claude",
        pid: 0,
        title: "Tune the deploy script for staging",
        state: "idle",
        since: 1_000,
        lastWriteAt: 1_000,
        evidence: { source: "transcript", at: 1_000, note: "its tab is open; the agent starts the session once the tab is opened" },
        project: "app",
        worktree: undefined,
        branch: "main",
        cwd: "/work/app",
        host: "panel",
        agents: 0,
        restored: true,
      },
    ]);
  });

  it("takes the newest session a label fits, and the next for a second tab with the same label", () => {
    const sessions = [past("new", "fix the build", 3_000), past("old", "fix the build", 1_000)];
    expect(restoredTabViews(sessions, [], { labels: ["fix the build"], label }).map((v) => v.id)).toEqual(["new"]);
    expect(restoredTabViews(sessions, [], { labels: ["fix the build", "fix the build"], label }).map((v) => v.id)).toEqual(["new", "old"]);
  });

  it("leaves the tab of a running session of this panel to it", () => {
    const sessions = [past("old", "fix the build", 1_000)];
    const running = [live("now", "fix the build")];
    expect(restoredTabViews(sessions, running, { labels: ["fix the build"], label })).toEqual([]);
    expect(restoredTabViews(sessions, running, { labels: ["fix the build", "fix the build"], label }).map((v) => v.id)).toEqual(["old"]);
    // A session in a terminal or another window holds no tab here.
    expect(restoredTabViews(sessions, [live("now", "fix the build", "terminal")], { labels: ["fix the build"], label }).map((v) => v.id)).toEqual(["old"]);
  });

  it("skips a running session, one the agent would not resume here, and a tab no session fits", () => {
    const sessions = [past("running", "fix the build", 3_000), past("elsewhere", "deploy", 2_000, false)];
    expect(restoredTabViews(sessions, [live("running", "fix the build", "window")], { labels: ["fix the build", "deploy", "Claude Code"], label })).toEqual([]);
  });
});
