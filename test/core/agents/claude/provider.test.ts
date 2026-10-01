import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "../../../../src/core/agents/claude/provider";
import { applyLine, titleOf, type TranscriptState } from "../../../../src/core/agents/claude/transcript";
import { appendEntries, FakeProc, sessionId, tempConfigDir, transcriptPath, writeSession } from "../../helpers";

function setup() {
  const configDir = tempConfigDir();
  const proc = new FakeProc();
  return { configDir, proc, provider: new ClaudeProvider(configDir, proc) };
}

describe("transcript", () => {
  it("prefers a user rename over the generated title over the last prompt", () => {
    const state: TranscriptState = {};
    applyLine(state, JSON.stringify({ type: "last-prompt", lastPrompt: "fix the\n  build" }));
    expect(titleOf(state)).toBe("fix the build");
    applyLine(state, JSON.stringify({ type: "ai-title", aiTitle: "Build fix" }));
    expect(titleOf(state)).toBe("Build fix");
    applyLine(state, JSON.stringify({ type: "custom-title", customTitle: "My tab" }));
    applyLine(state, JSON.stringify({ type: "ai-title", aiTitle: "Build fix v2" }));
    expect(titleOf(state)).toBe("My tab");
  });

  it("falls back when a rename is cleared", () => {
    const state: TranscriptState = { customTitle: "My tab", aiTitle: "Build fix" };
    applyLine(state, JSON.stringify({ type: "custom-title", customTitle: "" }));
    expect(titleOf(state)).toBe("Build fix");
  });

  it("follows the main chain's cwd and ignores subagents and bad lines", () => {
    const state: TranscriptState = {};
    applyLine(state, JSON.stringify({ type: "user", cwd: "/work/app" }));
    applyLine(state, JSON.stringify({ type: "assistant", cwd: "/work/other", isSidechain: true }));
    applyLine(state, "{not json");
    applyLine(state, "null");
    applyLine(state, "");
    expect(state.cwd).toBe("/work/app");
  });
});

describe("ClaudeProvider", () => {
  it("identifies itself", () => {
    const { provider } = setup();
    expect([provider.id, provider.label]).toEqual(["claude-code", "Claude Code"]);
  });

  it("maps Claude Code's status to the agent-neutral status", () => {
    const { configDir, proc, provider } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "busy" });
    writeSession(configDir, proc, { pid: 12, sessionId: sessionId(2), status: "waiting", waitingFor: "permission prompt" });
    writeSession(configDir, proc, { pid: 13, sessionId: sessionId(3), status: "idle" });
    writeSession(configDir, proc, { pid: 14, sessionId: sessionId(4), status: "shell", entrypoint: "cli" });
    writeSession(configDir, proc, { pid: 15, sessionId: sessionId(5), status: undefined });

    const byPid = new Map(provider.poll(0).map((s) => [s.pid, s]));
    expect([11, 12, 13, 14, 15].map((pid) => byPid.get(pid)?.status)).toEqual(["working", "waiting", "idle", "idle", "unknown"]);
    expect(byPid.get(12)?.needs).toBe("permission prompt");
    expect(byPid.get(11)?.needs).toBeUndefined();
    expect(byPid.get(11)).toMatchObject({ agent: "claude-code", panel: true, since: 2_000 });
    expect(byPid.get(14)?.panel).toBe(false);
  });

  it("prefers the specific reason a session waits", () => {
    const { configDir, proc, provider } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "waiting", waitingFor: "permission prompt", needs: "choose: allow or deny Bash" });
    expect(provider.poll(0)[0]?.needs).toBe("choose: allow or deny Bash");
  });

  it("takes title and current directory from the transcript as it grows", () => {
    const { configDir, proc, provider } = setup();
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, cwd: "/work/app" });
    expect(provider.poll(0)[0]).toMatchObject({ cwd: "/work/app" });
    expect(provider.poll(0)[0]?.title).toBeUndefined();

    const transcript = transcriptPath(configDir, "/work/app", id);
    appendEntries(transcript, [
      { type: "user", cwd: "/work/app" },
      { type: "ai-title", aiTitle: "Wire the cache" },
    ]);
    // The lookup for a missing transcript is rate limited.
    expect(provider.poll(1_000)[0]?.title).toBeUndefined();
    expect(provider.poll(6_000)[0]).toMatchObject({ title: "Wire the cache", cwd: "/work/app" });

    appendEntries(transcript, [{ type: "assistant", cwd: "/work/svc/.claude/worktrees/hotfix" }]);
    expect(provider.poll(7_000)[0]?.cwd).toBe("/work/svc/.claude/worktrees/hotfix");
  });

  it("finds a transcript stored under another project directory", () => {
    const { configDir, proc, provider } = setup();
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, cwd: "/work/app" });
    appendEntries(transcriptPath(configDir, "/somewhere/else", id), [{ type: "custom-title", customTitle: "Resumed" }]);
    expect(provider.poll(0)[0]?.title).toBe("Resumed");
  });

  it("drops a session when its process exits", () => {
    const { configDir, proc, provider } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1) });
    expect(provider.poll(0)).toHaveLength(1);
    proc.procs.delete(11);
    expect(provider.poll(0)).toEqual([]);
  });
});
