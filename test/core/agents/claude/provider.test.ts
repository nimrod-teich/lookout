import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "../../../../src/core/agents/claude/provider";
import { inThreadScanner } from "../../../../src/core/agents/lineReaders";
import { BackgroundReads } from "../../../../src/core/background";
import { parseQuery } from "../../../../src/core/terms";
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

  it("shows only the minutes since the session started, so a young session's bars grow from the left", () => {
    const state = emptyTranscript();
    const now = 1_000_000_000;
    state.toolCallTimes = [now - 30_000, now - 90_000];
    expect(pulseOf(state, now, now - 2.5 * 60_000)).toEqual([0, 1, 1]);
    expect(pulseOf(state, now, now - 20 * 60_000)).toHaveLength(15);
    expect(pulseOf(state, now, now + 5_000)).toEqual([1]);
    expect(pulseOf(state, now)).toHaveLength(15);
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
    writeSession(configDir, proc, { pid: 15, sessionId: sessionId(5), status: undefined, startedAt: -120_000 });
    // Just started, nothing recorded yet: idle rather than unknown.
    writeSession(configDir, proc, { pid: 16, sessionId: sessionId(6), status: undefined, startedAt: -5_000 });

    const byPid = new Map(provider.poll(0).map((s) => [s.pid, s]));
    expect([11, 12, 13, 14, 15, 16].map((pid) => byPid.get(pid)?.status)).toEqual(["working", "waiting", "idle", "idle", "unknown", "idle"]);
    expect(byPid.get(12)?.reason).toEqual({ kind: "permission", ask: "permission prompt", raw: "permission prompt", tentative: true });
    expect(byPid.get(11)?.reason).toBeUndefined();
    expect(byPid.get(11)).toMatchObject({ agent: "claude-code", panel: true, since: 2_000, agents: 0 });
    expect(byPid.get(11)?.activity).toBeUndefined();
    expect(byPid.get(14)?.panel).toBe(false);
  });

  it("quotes the agent's own line for a prompt it can't tie to a tool call", () => {
    const { configDir, proc, provider } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "waiting", waitingFor: "permission prompt", needs: "choose: allow or deny the computer-use action" });
    expect(provider.poll(0)[0]?.reason).toEqual({ kind: "permission", ask: "choose: allow or deny the computer-use action", raw: "permission prompt" });
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

  it("keeps a title stamped before the last checkpoint of a large transcript", () => {
    // Claude Code stamps the title once, and again on resume just before a
    // cost checkpoint; reading from the checkpoint alone would miss it.
    const { configDir, proc, provider } = setup();
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, cwd: "/work/app" });
    const filler = Array.from({ length: 1200 }, () => ({ type: "progress", data: "x".repeat(1000) }));
    appendEntries(transcriptPath(configDir, "/work/app", id), [
      { type: "ai-title", aiTitle: "Wire the cache" },
      ...filler,
      { type: "custom-title", customTitle: "Cache rewrite" },
      { type: "cost-state", totalCostUSD: 1, modelUsage: {} },
      { type: "user", cwd: "/work/app" },
    ]);
    expect(provider.poll(0)[0]).toMatchObject({ title: "Cache rewrite", cwd: "/work/app" });
  });

  it("keeps the title of a large transcript without a checkpoint, and lets a later line override it", () => {
    const { configDir, proc, provider } = setup();
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, cwd: "/work/app" });
    const transcript = transcriptPath(configDir, "/work/app", id);
    const filler = Array.from({ length: 1200 }, () => ({ type: "progress", data: "x".repeat(1000) }));
    appendEntries(transcript, [{ type: "custom-title", customTitle: "Renamed" }, { type: "ai-title", aiTitle: "Wire the cache" }, ...filler]);
    expect(provider.poll(0)[0]?.title).toBe("Renamed");
    appendEntries(transcript, [{ type: "custom-title", customTitle: "" }]);
    expect(provider.poll(1_000)[0]?.title).toBe("Wire the cache");
  });

  it("seeds the tasks a large transcript scheduled before its last checkpoint, and drops those of a process the session was resumed from", () => {
    const { configDir, proc, provider } = setup();
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, cwd: "/work/app", startedAt: 1_000 });
    const t = new Date(10_000).toISOString();
    const filler = Array.from({ length: 1200 }, () => ({ type: "progress", data: "x".repeat(1000) }));
    appendEntries(transcriptPath(configDir, "/work/app", id), [
      { type: "assistant", timestamp: t, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "w1", name: "ScheduleWakeup", input: { delaySeconds: 1800, prompt: "Look again" } }] } },
      { type: "user", timestamp: t, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "Next wakeup scheduled for 00:30:10 (in 1800s)." }] } },
      { type: "assistant", timestamp: t, message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "c1", name: "CronCreate", input: { cron: "0 12 * * *", prompt: "Daily check" } }] } },
      { type: "user", timestamp: t, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Scheduled recurring job abcdef12 (Every day at 12:00 PM). Session-only. Auto-expires after 7 days." }] } },
      { type: "assistant", timestamp: t, message: { id: "m3", role: "assistant", content: [{ type: "tool_use", id: "c2", name: "CronCreate", input: { cron: "0 9 * * *", prompt: "Gone" } }] } },
      { type: "user", timestamp: t, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "Scheduled recurring job 99999999 (Every day at 9:00 AM)." }] } },
      { type: "assistant", timestamp: t, message: { id: "m4", role: "assistant", content: [{ type: "tool_use", id: "d1", name: "CronDelete", input: { id: "99999999" } }] } },
      ...filler,
      { type: "cost-state", totalCostUSD: 1, modelUsage: {} },
      { type: "user", cwd: "/work/app" },
    ]);
    const session = provider.poll(20_000)[0]!;
    expect(session.schedules?.map((s) => [s.kind, s.prompt, s.nextAt])).toEqual([
      ["wakeup", "Look again", 10_000 + 1800_000],
      ["cron", "Daily check", session.schedules?.[1]?.nextAt],
    ]);
    // Noon, local time: in any zone that is the better part of a day past the epoch, so the wakeup comes first.
    expect(session.schedules?.[1]?.label).toBe("every day at 12:00");
    // The seed folded nothing but the schedules: the calls it read are no open tools of the session's.
    expect(session.activity).toBeUndefined();
    // Resumed by a process started after those calls: the tasks died with the old one.
    proc.procs.delete(11);
    fs.rmSync(path.join(configDir, "sessions", "11.json"));
    writeSession(configDir, proc, { pid: 12, sessionId: id, cwd: "/work/app", startedAt: 15_000 });
    expect(provider.poll(20_000)[0]?.schedules).toEqual([]);
  });

  it("reports the activity of a working session only", () => {
    const { configDir, proc, provider } = setup();
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, status: "busy", startedAt: -20 * 60_000 });
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

  it("searches the conversations of the live sessions, newest matches first, and forgets a session that ended", () => {
    const { configDir, proc, provider } = setup();
    const first = sessionId(1);
    const second = sessionId(2);
    writeSession(configDir, proc, { pid: 11, sessionId: first, cwd: "/work/app" });
    writeSession(configDir, proc, { pid: 12, sessionId: second, cwd: "/work/app" });
    appendEntries(transcriptPath(configDir, "/work/app", first), [
      { type: "user", timestamp: "2026-10-16T10:00:00Z", message: { content: "Please fix the billing webhook" } },
      { type: "assistant", timestamp: "2026-10-16T10:00:05Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "grep billing" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "billing.ts: webhook handler" }] } },
      { type: "assistant", timestamp: "2026-10-16T10:01:00Z", message: { content: [{ type: "text", text: "The billing webhook now retries twice." }] } },
    ]);
    appendEntries(transcriptPath(configDir, "/work/app", second), [{ type: "user", message: { content: "Rename the changelog" } }]);
    provider.poll(0);
    const { results } = provider.search(parseQuery("Billing webhook"), 5, 1000);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: first, count: 2 });
    expect(results[0]?.hits.map((hit) => [hit.role, hit.snippet])).toEqual([
      ["agent", "The billing webhook now retries twice."],
      ["you", "Please fix the billing webhook"],
    ]);
    expect(results[0]?.hits[0]?.ranges).toEqual([
      [4, 11],
      [12, 19],
    ]);
    expect(results[0]?.hits.map((hit) => hit.index)).toEqual([1, 0]);
    expect(provider.search(parseQuery("   "), 5, 1000)).toEqual({ results: [], pending: 0 });
    expect(provider.history(first)?.map((m) => m.role)).toEqual(["you", "agent"]);
    expect(provider.history(sessionId(9))).toBeUndefined();

    appendEntries(transcriptPath(configDir, "/work/app", second), [{ type: "assistant", message: { content: [{ type: "text", text: "Billing is not my job here" }] } }]);
    expect(provider.search(parseQuery("billing"), 1, 1000).results.map((r) => r.id).sort()).toEqual([first, second]);

    proc.procs.delete(11);
    provider.poll(0);
    expect(provider.search(parseQuery("billing"), 1, 1000).results.map((r) => r.id)).toEqual([second]);
  });

  it("lists the past sessions of the given folders, searches them within a budget, and hands out their conversations", () => {
    const { configDir, proc, provider } = setup();
    const live = sessionId(1);
    const old = sessionId(2);
    const archived = sessionId(3);
    writeSession(configDir, proc, { pid: 11, sessionId: live, cwd: "/work/app" });
    appendEntries(transcriptPath(configDir, "/work/app", live), [{ type: "ai-title", aiTitle: "Running" }]);
    appendEntries(transcriptPath(configDir, "/work/app", old), [
      { type: "ai-title", aiTitle: "Old billing work" },
      { type: "user", message: { content: "Rewrite the billing webhook" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Done: the billing webhook is rewritten." }] } },
    ]);
    appendEntries(transcriptPath(configDir, "/work/app", archived), [{ type: "user", message: { content: "billing, archived" } }]);
    provider.poll(0);
    const past = provider.past({ folders: ["/work/app"], all: false, limit: 500 }, new Set([live, archived]));
    expect(past.capped).toBe(false);
    expect(past.sessions.map((p) => [p.id, p.title, p.cwd, p.agent])).toEqual([[old, "Old billing work", "/work/app", "claude-code"]]);
    // No time to read: both conversations, the live and the past, are reported pending and come back on the next search.
    expect(provider.search(parseQuery("billing"), 3, 0)).toEqual({ results: [], pending: 2 });
    const { results, pending } = provider.search(parseQuery("billing"), 3, 1000);
    expect(pending).toBe(0);
    expect(results.map((r) => [r.id, r.count])).toEqual([[old, 2]]);
    expect(provider.history(old)?.map((m) => m.role)).toEqual(["you", "agent"]);
    expect(provider.history(archived)).toBeUndefined();
    // Gone from the list, gone from memory.
    expect(provider.past({ folders: ["/work/app"], all: false, limit: 500 }, new Set([live, archived, old]))).toEqual({ sessions: [], capped: false, incomplete: false, also: [] });
    expect(provider.history(old)).toBeUndefined();
  });

  it("keeps what it read of a conversation when its session ends and when it is resumed", () => {
    const { configDir, proc, provider } = setup();
    const id = sessionId(1);
    const scope = { folders: ["/work/app"], all: false, limit: 500 };
    writeSession(configDir, proc, { pid: 11, sessionId: id, cwd: "/work/app" });
    appendEntries(transcriptPath(configDir, "/work/app", id), [
      { type: "ai-title", aiTitle: "Billing" },
      { type: "user", message: { content: "Fix the billing webhook" } },
    ]);
    provider.poll(0);
    provider.past(scope, new Set([id]));
    const read = provider.history(id);
    expect(read?.map((m) => m.text)).toEqual(["Fix the billing webhook"]);
    // Ended: an earlier session now, with the messages already read.
    proc.procs.delete(11);
    provider.poll(0);
    expect(provider.past(scope, new Set()).sessions.map((p) => p.id)).toEqual([id]);
    expect(provider.history(id)).toBe(read);
    // Resumed: live again, still the same.
    writeSession(configDir, proc, { pid: 12, sessionId: id, cwd: "/work/app" });
    provider.poll(0);
    provider.past(scope, new Set([id]));
    expect(provider.history(id)).toBe(read);
    expect(provider.search(parseQuery("billing"), 3, 0).results.map((r) => r.id)).toEqual([id]);
  });

  it("reads in the background when given one: a search counts what is not read yet as pending, and finds it once read", async () => {
    const { configDir, proc, provider } = setup();
    const live = sessionId(1);
    const old = sessionId(2);
    writeSession(configDir, proc, { pid: 11, sessionId: live, cwd: "/work/app" });
    appendEntries(transcriptPath(configDir, "/work/app", live), [{ type: "user", message: { content: "Fix the billing webhook" } }]);
    appendEntries(transcriptPath(configDir, "/work/app", old), [
      { type: "ai-title", aiTitle: "Old billing work" },
      { type: "user", message: { content: "The billing export" } },
    ]);
    provider.poll(0);
    provider.past({ folders: ["/work/app"], all: false, limit: 500 }, new Set([live]));
    const onDidRead = vi.fn();
    const background = new BackgroundReads(inThreadScanner(), onDidRead, inThreadScanner);
    // However long a budget it is given, nothing is read here.
    expect(provider.search(parseQuery("billing"), 3, 10_000, undefined, background)).toEqual({ results: [], pending: 2 });
    await vi.waitFor(() => expect(background.pending).toBe(0));
    expect(onDidRead).toHaveBeenCalled();
    const { results, pending } = provider.search(parseQuery("billing"), 3, 0, undefined, background);
    expect(pending).toBe(0);
    expect(results.map((r) => [r.id, r.count]).sort()).toEqual([[live, 1], [old, 1]].sort());
    // The live conversation goes on: what it gained is read in the background too.
    appendEntries(transcriptPath(configDir, "/work/app", live), [{ type: "assistant", message: { content: [{ type: "text", text: "The billing webhook retries now" }] } }]);
    expect(provider.history(live, background)?.map((m) => m.text)).toEqual(["Fix the billing webhook"]);
    await vi.waitFor(() => expect(provider.history(live, background)).toHaveLength(2));
    background.dispose();
  });

  it("reads ahead of any search: every past conversation once, the live ones as they go on", async () => {
    const { configDir, proc, provider } = setup();
    const live = sessionId(1);
    const old = sessionId(2);
    writeSession(configDir, proc, { pid: 11, sessionId: live, cwd: "/work/app" });
    appendEntries(transcriptPath(configDir, "/work/app", live), [{ type: "user", message: { content: "Fix the cache" } }]);
    appendEntries(transcriptPath(configDir, "/work/app", old), [{ type: "user", message: { content: "Old cache work" } }]);
    provider.poll(0);
    provider.past({ folders: ["/work/app"], all: false, limit: 500 }, new Set([live]));
    const background = new BackgroundReads(inThreadScanner(), () => {}, inThreadScanner);
    provider.readAhead(background);
    expect(background.pending).toBe(2);
    await vi.waitFor(() => expect(background.pending).toBe(0));
    expect(provider.search(parseQuery("cache"), 3, 0, undefined, background).results).toHaveLength(2);
    background.dispose();
  });

  it("narrows a search by time, project, branch and the files the tool calls worked on", () => {
    const { configDir, proc, provider } = setup();
    const day = 86_400_000;
    const now = Date.parse("2026-10-16T12:00:00Z");
    const at = (ms: number) => new Date(ms).toISOString();
    const live = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: live, cwd: "/work/api" });
    appendEntries(transcriptPath(configDir, "/work/api", live), [
      { type: "user", cwd: "/work/api", gitBranch: "fix-login", timestamp: at(now - 2 * day), message: { content: "deploy the login fix" } },
      { type: "assistant", cwd: "/work/api", gitBranch: "fix-login", timestamp: at(now - 2 * day), message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/work/api/src/Login.ts" } }] } },
      { type: "user", cwd: "/work/api", timestamp: at(now - 2 * day), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "edited src/billing.ts too" }] } },
      { type: "assistant", cwd: "/work/api", gitBranch: "fix-login", timestamp: at(now - day / 2), message: { content: [{ type: "text", text: "deploy is green" }] } },
    ]);
    const old = sessionId(2);
    appendEntries(transcriptPath(configDir, "/work/web", old), [
      { type: "ai-title", aiTitle: "Web deploy" },
      { type: "user", cwd: "/work/web", gitBranch: "main", timestamp: at(now - 10 * day), message: { content: "deploy the web app" } },
      { type: "assistant", cwd: "/work/web", gitBranch: "main", timestamp: at(now - 10 * day), message: { content: [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "deployTarget", path: "/work/web/infra" } }] } },
    ]);
    provider.poll(now);
    provider.past({ folders: [], all: true, limit: 500 }, new Set([live]));
    const ids = (query: string) => provider.search(parseQuery(query, now), 3, 1_000).results.map((r) => [r.id, r.count]);
    expect(ids("deploy")).toEqual([[live, 2], [old, 1]]);
    expect(ids("deploy since:3d")).toEqual([[live, 2]]);
    expect(ids("deploy since:yesterday")).toEqual([[live, 1]]);
    expect(ids("deploy before:3d")).toEqual([[old, 1]]);
    expect(ids("deploy project:web")).toEqual([[old, 1]]);
    expect(ids("deploy branch:fix")).toEqual([[live, 2]]);
    expect(ids("deploy file:src/login")).toEqual([[live, 2]]);
    expect(ids("deploy file:deploytarget")).toEqual([[old, 1]]);
    // A tool's output is not searched for paths.
    expect(ids("deploy file:billing")).toEqual([]);
    // Operators alone list the sessions they pick, without matches.
    expect(ids("project:api")).toEqual([[live, 0]]);
    expect(ids("branch:main since:1w")).toEqual([]);
    expect(ids("branch:main since:2w")).toEqual([[old, 0]]);
  });

  it("does not read an earlier transcript last written before a search's since:", () => {
    const { configDir, provider } = setup();
    const now = Date.parse("2026-10-16T12:00:00Z");
    const stale = sessionId(1);
    const file = transcriptPath(configDir, "/work/app", stale);
    appendEntries(file, [{ type: "user", cwd: "/work/app", timestamp: "2026-09-01T10:00:00Z", message: { content: "deploy the old thing" } }]);
    const month = new Date(now - 30 * 86_400_000);
    fs.utimesSync(file, month, month);
    provider.past({ folders: ["/work/app"], all: false, limit: 500 }, new Set());
    // With no time to read anything, nothing is left pending either: the file's age rules it out.
    expect(provider.search(parseQuery("deploy since:1w", now), 3, 0)).toEqual({ results: [], pending: 0 });
    expect(provider.search(parseQuery("deploy", now), 3, 0)).toEqual({ results: [], pending: 1 });
    expect(provider.search(parseQuery("deploy since:2026-08-01", now), 3, 1_000).results.map((r) => r.id)).toEqual([stale]);
  });

  it("counts an idle session with background jobs as working, how long they were busy, and flags them when they stall", () => {
    const { configDir, proc, provider } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "idle" });
    let cpu = 100;
    proc.cpu = () => cpu;
    proc.kids.set(11, [
      { pid: 21, args: "/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-x.sh && eval 'make backfill'", startedMs: 5_000 },
      { pid: 23, args: "node /usr/lib/node_modules/@playwright/mcp/cli.js", startedMs: 1_000 },
    ]);
    expect(provider.poll(10_000)[0]).toMatchObject({ status: "working", background: { count: 1, since: 5_000, activeMs: 0 } });
    cpu = 150;
    expect(provider.poll(40_000)[0]?.background).toMatchObject({ activeMs: 30_000, idleMs: undefined });
    // No CPU for 15 minutes: may be stuck.
    expect(provider.poll(40_000 + 15 * 60_000)[0]?.background).toMatchObject({ activeMs: 30_000, idleMs: 15 * 60_000 });
    // Output written counts as busy too: work in a container uses no CPU of its own.
    proc.out = () => ({ size: 10, deleted: false });
    provider.poll(40_000 + 16 * 60_000);
    proc.out = () => ({ size: 20, deleted: false });
    expect(provider.poll(40_000 + 16 * 60_000 + 20_000)[0]?.background).toMatchObject({ activeMs: 50_000, idleMs: undefined });
    // Its output file deleted: Claude Code no longer follows it.
    proc.out = () => ({ size: 20, deleted: true });
    expect(provider.poll(40_000 + 17 * 60_000)[0]?.background).toMatchObject({ orphaned: 1 });
    proc.kids.set(11, [{ pid: 23, args: "node mcp-server.js" }]);
    expect(provider.poll(2_000_000)[0]).toMatchObject({ status: "idle", background: undefined });
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
