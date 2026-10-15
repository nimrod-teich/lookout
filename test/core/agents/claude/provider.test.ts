import { describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "../../../../src/core/agents/claude/provider";
import { activityOf, agentsOf, applyLine, contextWindowOf, emptyTranscript, pulseOf, summarizeTool, titleOf, type TranscriptState } from "../../../../src/core/agents/claude/transcript";
import { appendEntries, FakeProc, sessionId, tempConfigDir, transcriptPath, writeSession } from "../../helpers";

function setup() {
  const configDir = tempConfigDir();
  const proc = new FakeProc();
  return { configDir, proc, provider: new ClaudeProvider(configDir, proc) };
}

describe("transcript", () => {
  it("prefers a user rename over the generated title over the last prompt", () => {
    const state = emptyTranscript();
    applyLine(state, JSON.stringify({ type: "last-prompt", lastPrompt: "fix the\n  build" }));
    expect(titleOf(state)).toBe("fix the build");
    applyLine(state, JSON.stringify({ type: "ai-title", aiTitle: "Build fix" }));
    expect(titleOf(state)).toBe("Build fix");
    applyLine(state, JSON.stringify({ type: "custom-title", customTitle: "My tab" }));
    applyLine(state, JSON.stringify({ type: "ai-title", aiTitle: "Build fix v2" }));
    expect(titleOf(state)).toBe("My tab");
  });

  it("falls back when a rename is cleared", () => {
    const state: TranscriptState = { ...emptyTranscript(), customTitle: "My tab", aiTitle: "Build fix" };
    applyLine(state, JSON.stringify({ type: "custom-title", customTitle: "" }));
    expect(titleOf(state)).toBe("Build fix");
  });

  it("follows the main chain's cwd and ignores subagents and bad lines", () => {
    const state = emptyTranscript();
    applyLine(state, JSON.stringify({ type: "user", cwd: "/work/app" }));
    applyLine(state, JSON.stringify({ type: "assistant", cwd: "/work/other", isSidechain: true }));
    applyLine(state, "{not json");
    applyLine(state, "null");
    applyLine(state, "");
    expect(state.cwd).toBe("/work/app");
  });
});

describe("transcript activity", () => {
  const ts = "2026-10-15T10:00:00.000Z";
  const assistant = (block: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "assistant", timestamp: ts, message: { model: "claude-fable-5-1", content: [block], usage: { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 500, output_tokens: 7 } }, ...extra });
  const result = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  const prompt = (text: string) => JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } });

  it("tracks tool calls until their results arrive", () => {
    const state = emptyTranscript();
    applyLine(state, assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test\n# more", description: undefined } }));
    expect(activityOf(state)).toBe("Bash · npm test");
    applyLine(state, assistant({ type: "tool_use", id: "t2", name: "Agent", input: { description: "Review the diff", prompt: "..." } }));
    applyLine(state, assistant({ type: "tool_use", id: "t3", name: "Read", input: { file_path: "/work/app/src/index.ts" } }));
    expect(activityOf(state)).toBe("Bash · npm test +2");
    expect(agentsOf(state)).toBe(1);
    applyLine(state, result("t1"));
    expect(activityOf(state)).toBe("Agent · Review the diff +1");
    applyLine(state, result("t2"));
    applyLine(state, result("t3"));
    expect(activityOf(state)).toBeUndefined();
    expect(agentsOf(state)).toBe(0);
  });

  it("summarizes each tool by what it works on", () => {
    expect(summarizeTool("Bash", { command: "ls", description: "List files" })).toBe("List files");
    expect(summarizeTool("Edit", { file_path: "C:\\work\\app\\src\\a.ts" })).toBe("a.ts");
    expect(summarizeTool("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(summarizeTool("Skill", { skill: "code-review" })).toBe("code-review");
    expect(summarizeTool("WebFetch", { url: "https://example.com/x" })).toBe("https://example.com/x");
    expect(summarizeTool("WebSearch", { query: "vitest fake timers" })).toBe("vitest fake timers");
    expect(summarizeTool("Bash", { command: "x".repeat(100) })).toBe(`${"x".repeat(59)}…`);
    expect(summarizeTool("TaskStop", { task_id: "b1" })).toBeUndefined();
    expect(summarizeTool("Bash", "not an object")).toBeUndefined();
  });

  it("clears the tools in flight on a new prompt or an interrupt", () => {
    const state = emptyTranscript();
    applyLine(state, assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 100" } }));
    applyLine(state, prompt("[Request interrupted by user for tool use]"));
    expect(activityOf(state)).toBeUndefined();

    applyLine(state, assistant({ type: "tool_use", id: "t2", name: "Bash", input: { command: "sleep 100" } }));
    applyLine(state, JSON.stringify({ type: "user", message: { content: "[Request interrupted by user]" } }));
    expect(activityOf(state)).toBeUndefined();

    applyLine(state, assistant({ type: "tool_use", id: "t3", name: "Bash", input: { command: "sleep 100" } }));
    applyLine(state, JSON.stringify({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "<system-reminder>" }] } }));
    expect(activityOf(state)).toBe("Bash · sleep 100");
    applyLine(state, prompt("next task please"));
    expect(activityOf(state)).toBeUndefined();
  });

  it("keeps the last reply, the model and the context size, ignoring subagents", () => {
    const state = emptyTranscript();
    applyLine(state, assistant({ type: "thinking", thinking: "hmm" }));
    applyLine(state, assistant({ type: "text", text: "\n\nDone. The build passes.\nDetails below." }));
    expect(state).toMatchObject({ lastReply: "Done. The build passes.", model: "claude-fable-5-1", contextTokens: 100_510 });
    applyLine(state, assistant({ type: "text", text: "sidechain text" }, { isSidechain: true }));
    applyLine(state, JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "" }] } }));
    expect(state).toMatchObject({ lastReply: "Done. The build passes.", model: "claude-fable-5-1" });
  });
});

describe("pulse and context window", () => {
  it("counts tool calls per minute over the last 15 minutes, dropping older and future ones", () => {
    const state = emptyTranscript();
    const now = Date.parse("2026-10-15T10:15:00Z");
    const call = (minutesAgo: number) =>
      applyLine(state, JSON.stringify({ type: "assistant", timestamp: new Date(now - minutesAgo * 60_000).toISOString(), message: { content: [{ type: "tool_use", id: `t${Math.random()}`, name: "Bash", input: {} }] } }));
    call(20);
    call(14.5);
    call(14.2);
    call(7);
    call(0.5);
    call(-1);
    applyLine(state, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "no-time", name: "Bash", input: {} }] } }));
    const pulse = pulseOf(state, now);
    expect(pulse).toHaveLength(15);
    expect(pulse[0]).toBe(2);
    expect(pulse[8]).toBe(1);
    expect(pulse[14]).toBe(1);
    expect(pulse.reduce((a, b) => a + b)).toBe(4);
  });

  it("infers Claude's context window from the model id and the usage", () => {
    expect(contextWindowOf("claude-fable-5-1[1m]", 1000)).toBe(1_000_000);
    expect(contextWindowOf("claude-opus-5-5", 150_000)).toBe(200_000);
    expect(contextWindowOf("claude-opus-5-5", 500_000)).toBe(1_000_000);
    expect(contextWindowOf(undefined, 500_000)).toBeUndefined();
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
    expect(byPid.get(11)).toMatchObject({ agent: "claude-code", panel: true, since: 2_000, agents: 0, remote: false });
    expect(byPid.get(11)?.activity).toBeUndefined();
    expect(byPid.get(14)?.panel).toBe(false);
  });

  it("marks a session under Remote Control", () => {
    const { configDir, proc, provider } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), bridgeSessionId: "cse_01ABC" });
    expect(provider.poll(0)[0]?.remote).toBe(true);
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

  it("reports the activity of a working session only", () => {
    const { configDir, proc, provider } = setup();
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, status: "busy" });
    appendEntries(transcriptPath(configDir, "/work/app", id), [
      { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "Plan the work" } }], usage: { input_tokens: 5 } } },
    ]);
    expect(provider.poll(0)[0]).toMatchObject({ activity: "Agent · Plan the work", agents: 1, model: "claude-opus-5-5", contextTokens: 5, contextWindow: 200_000 });
    expect(provider.poll(0)[0]?.pulse).toHaveLength(15);

    writeSession(configDir, proc, { pid: 11, sessionId: id, status: "idle" });
    const idle = provider.poll(0)[0];
    expect(idle?.activity).toBeUndefined();
    expect(idle?.agents).toBe(0);
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

describe("ClaudeProvider.watch", () => {
  it("reports a change when a session file is written", async () => {
    const { configDir, proc, provider } = setup();
    let changes = 0;
    const watcher = provider.watch(() => changes++);
    expect(watcher).toBeDefined();
    try {
      await new Promise((r) => setTimeout(r, 50));
      writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "busy" });
      await vi.waitFor(() => expect(changes).toBeGreaterThan(0), { timeout: 5000 });
    } finally {
      watcher?.dispose();
    }
  });

  it("returns nothing when the sessions directory does not exist", () => {
    expect(new ClaudeProvider("/nonexistent/lookout", new FakeProc()).watch(() => {})).toBeUndefined();
  });
});
