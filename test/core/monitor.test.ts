import { describe, expect, it } from "vitest";
import type { AgentProvider, AgentSession } from "../../src/core/agents/agent";
import { projectOf, sortViews, UNTITLED } from "../../src/core/model";
import { Monitor } from "../../src/core/monitor";
import { FakeProc } from "./helpers";

const HOST = 1000;

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return { agent: "test-agent", id: "s1", pid: 11, status: "idle", cwd: "/work/app", panel: true, ...overrides };
}

function setup(sessions: AgentSession[]) {
  const proc = new FakeProc();
  const provider: AgentProvider = { id: "test-agent", label: "Test Agent", poll: () => sessions };
  return { proc, monitor: new Monitor([provider], proc) };
}

describe("projectOf", () => {
  it("names the repository for a Claude Code worktree", () => {
    expect(projectOf("/work/app/.claude/worktrees/fix-x/src")).toEqual({ project: "app", worktree: "fix-x" });
    expect(projectOf("/work/app")).toEqual({ project: "app" });
    expect(projectOf("/work/app/")).toEqual({ project: "app" });
    expect(projectOf("/")).toEqual({ project: "/" });
  });

  it("reads Windows paths on any platform", () => {
    expect(projectOf("C:\\Users\\dev\\app")).toEqual({ project: "app" });
    expect(projectOf("C:\\Users\\dev\\app\\.claude\\worktrees\\fix-x")).toEqual({ project: "app", worktree: "fix-x" });
  });
});

describe("Monitor", () => {
  it("places a panel session in this window when the extension host is its parent or a further ancestor", () => {
    const { proc, monitor } = setup([session({ id: "direct", pid: 11 }), session({ id: "wrapped", pid: 12 })]);
    proc.procs.set(11, { ppid: HOST }).set(12, { ppid: 50 }).set(50, { ppid: HOST }).set(HOST, { ppid: 1 });
    const views = monitor.poll({ hostPid: HOST, terminalPids: new Set() });
    expect(views.map((v) => [v.id, v.host])).toEqual([
      ["direct", "panel"],
      ["wrapped", "panel"],
    ]);
  });

  it("places a session in the terminal whose shell is among its ancestors", () => {
    const { proc, monitor } = setup([session({ panel: false })]);
    proc.procs.set(11, { ppid: 60 }).set(60, { ppid: 70 }).set(70, { ppid: 1 });
    expect(monitor.poll({ hostPid: HOST, terminalPids: new Set([70, 71]) })[0]).toMatchObject({ host: "terminal", terminalPid: 70 });
  });

  it("places everything else elsewhere", () => {
    const { proc, monitor } = setup([
      session({ id: "other-window", pid: 11 }),
      session({ id: "terminal-agent-under-host", pid: 12, panel: false }),
      session({ id: "unknown-parents", pid: 13 }),
    ]);
    proc.procs.set(11, { ppid: 4242 }).set(12, { ppid: HOST }).set(13, {});
    const views = monitor.poll({ hostPid: HOST, terminalPids: new Set() });
    expect(views.map((v) => v.host)).toEqual(["elsewhere", "elsewhere", "elsewhere"]);
    expect(views[0]?.terminalPid).toBeUndefined();
  });

  it("fills in the view from the agent's session", () => {
    const { monitor } = setup([
      session({ status: "waiting", needs: "permission prompt", since: 5, title: "Wire the cache", cwd: "/work/svc/.claude/worktrees/hotfix" }),
      session({ id: "s2", status: "working", needs: "stale reason" }),
    ]);
    const views = monitor.poll({ hostPid: HOST, terminalPids: new Set() });
    expect(views[0]).toMatchObject({
      id: "s1",
      agent: "test-agent",
      pid: 11,
      title: "Wire the cache",
      state: "waiting",
      since: 5,
      needs: "permission prompt",
      project: "svc",
      worktree: "hotfix",
    });
    expect(views[1]).toMatchObject({ title: UNTITLED, state: "working", project: "app" });
    expect(views[1]?.needs).toBeUndefined();
  });

  it("merges the sessions of several agents", () => {
    const proc = new FakeProc();
    const a: AgentProvider = { id: "a", label: "A", poll: () => [session({ agent: "a", id: "1" })] };
    const b: AgentProvider = { id: "b", label: "B", poll: () => [session({ agent: "b", id: "2" })] };
    expect(new Monitor([a, b], proc).poll({ hostPid: HOST, terminalPids: new Set() }).map((v) => v.agent)).toEqual(["a", "b"]);
  });
});

describe("sortViews", () => {
  it("puts what needs attention first and orders each group by time in state", () => {
    const { monitor } = setup([
      session({ id: "idle" }),
      session({ id: "work-new", status: "working", since: 300 }),
      session({ id: "work-old", status: "working", since: 100 }),
      session({ id: "wait", status: "waiting" }),
      session({ id: "unknown", status: "unknown" }),
    ]);
    const views = monitor.poll({ hostPid: HOST, terminalPids: new Set() });
    views.push({ ...views[0]!, id: "done", state: "done" });
    expect(sortViews(views).map((v) => v.id)).toEqual(["wait", "done", "work-old", "work-new", "unknown", "idle"]);
  });
});
