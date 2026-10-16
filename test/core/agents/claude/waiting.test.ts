import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "../../../../src/core/agents/claude/provider";
import { applyLine, emptyTranscript } from "../../../../src/core/agents/claude/transcript";
import { planFileTitle, questionOf, reasonOf, toolLabel } from "../../../../src/core/agents/claude/waiting";
import { FakeProc, sessionId, tempConfigDir, transcriptPath, writeSession } from "../../helpers";

// Session files and transcript slices recorded from Claude Code 2.1.301 while
// it waited on each kind of prompt, anonymised (test/fixtures/claude).
const FIXTURES = path.join(__dirname, "../../../fixtures/claude");
const PID = 4242;

function fixture(kind: "sessions" | "transcripts", name: string): string {
  return fs.readFileSync(path.join(FIXTURES, kind, `${name}.${kind === "sessions" ? "json" : "jsonl"}`), "utf8");
}

/** A config dir holding one recorded session: its session file, its transcript, and the plan files. */
function recorded(session: string, transcript?: string, edit: (lines: string[]) => string[] = (lines) => lines) {
  const configDir = tempConfigDir();
  const proc = new FakeProc();
  const file = JSON.parse(fixture("sessions", session)) as { sessionId: string; cwd: string; procStart: string };
  fs.writeFileSync(path.join(configDir, "sessions", `${PID}.json`), JSON.stringify(file));
  proc.procs.set(PID, { ppid: 1000, startTicks: file.procStart });
  if (transcript) fs.writeFileSync(transcriptPath(configDir, file.cwd, file.sessionId), `${edit(fixture("transcripts", transcript).trimEnd().split("\n")).join("\n")}\n`);
  fs.cpSync(path.join(FIXTURES, "plans"), path.join(configDir, "plans"), { recursive: true });
  return { configDir, proc, provider: new ClaudeProvider(configDir, proc) };
}

function pollOne(provider: ClaudeProvider) {
  const sessions = provider.poll(Date.now());
  expect(sessions).toHaveLength(1);
  return sessions[0]!;
}

describe("why a recorded session waits", () => {
  it("names the tool and its whole command for a permission prompt", () => {
    const session = pollOne(recorded("permission", "permission").provider);
    expect(session.status).toBe("waiting");
    expect(session.reason).toEqual({ kind: "permission", ask: "Bash: ls -la /tmp", raw: "permission prompt" });
  });

  it("quotes the question and its answers while AskUserQuestion is open", () => {
    const session = pollOne(recorded("question", "question").provider);
    expect(session.reason).toEqual({ kind: "question", ask: "Which color do you prefer?", options: ["Red", "Blue"], raw: "input needed" });
  });

  it("names the plan to approve, from the plan in the tool call", () => {
    const session = pollOne(recorded("plan", "plan").provider);
    expect(session.reason).toEqual({ kind: "plan", ask: "Add a changes file", raw: "permission prompt" });
  });

  it("reads the plan's title from its file when the tool call carries no plan", () => {
    // Older versions wrote the call with no input; the plan was only in its file.
    const empty = (lines: string[]) =>
      lines.map((line) => {
        if (!line.includes('"name":"ExitPlanMode"')) return line;
        const entry = JSON.parse(line) as { message: { content: { name?: string; input?: unknown }[] } };
        for (const block of entry.message.content) if (block.name === "ExitPlanMode") block.input = {};
        return JSON.stringify(entry);
      });
    expect(pollOne(recorded("plan", "plan", empty).provider).reason).toEqual({ kind: "plan", ask: "Add a changes file", raw: "permission prompt" });
    const unnamed = (lines: string[]) => empty(lines).map((line) => line.replace(/plan-how-to-add-jolly-meadow/g, "no-such-plan"));
    expect(pollOne(recorded("plan", "plan", unnamed).provider).reason).toEqual({ kind: "plan", ask: "a plan to review", raw: "permission prompt" });
  });

  it("reports any other dialog with the agent's own word for it", () => {
    expect(pollOne(recorded("dialog").provider).reason).toEqual({ kind: "dialog", ask: "dialog open", raw: "dialog open" });
  });

  it("finds the question an idle session's last reply asks", () => {
    const session = pollOne(recorded("idle", "typed").provider);
    expect(session.status).toBe("idle");
    expect(session.reason).toBeUndefined();
    expect(session.question).toEqual({ text: "All done. Want me to delete the scratch file too?", at: Date.parse("2026-10-16T16:55:00.305Z") });
  });
});

describe("reasonOf", () => {
  const ts = "2026-10-16T10:00:00.000Z";
  const call = (id: string, name: string, input: unknown) => JSON.stringify({ type: "assistant", cwd: "/work/app", timestamp: ts, message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

  it("asks about the oldest open call, with paths relative to the session", () => {
    const state = emptyTranscript();
    applyLine(state, call("t1", "Read", { file_path: "/work/app/README.md" }));
    applyLine(state, result("t1"));
    applyLine(state, call("t2", "Edit", { file_path: "/work/app/src/cache.ts", old_string: "a", new_string: "b" }));
    applyLine(state, call("t3", "Bash", { command: "npm test", description: "Run the tests" }));
    expect(reasonOf({ waitingFor: "permission prompt" }, state)).toEqual({ kind: "permission", ask: "Edit: src/cache.ts", raw: "permission prompt" });
    applyLine(state, result("t2"));
    expect(reasonOf({ waitingFor: "permission prompt" }, state).ask).toBe("Bash: npm test");
  });

  it("labels an MCP server's tool, and falls back to the agent's line when no call is open", () => {
    expect(toolLabel("mcp__atlassian__createJiraIssue")).toBe("createJiraIssue (atlassian)");
    expect(toolLabel("Bash")).toBe("Bash");
    const state = emptyTranscript();
    applyLine(state, call("t1", "mcp__atlassian__createJiraIssue", { projectKey: "MAG", summary: "Fix the **cache**" }));
    expect(reasonOf({ waitingFor: "permission prompt" }, state).ask).toBe("createJiraIssue (atlassian): Fix the cache");
    expect(reasonOf({ waitingFor: "permission prompt", needs: "choose: allow or deny the computer-use action" }, emptyTranscript())).toEqual({
      kind: "permission",
      ask: "choose: allow or deny the computer-use action",
      raw: "permission prompt",
    });
    expect(reasonOf({}, emptyTranscript())).toEqual({ kind: "permission", ask: "permission prompt", raw: undefined, tentative: true });
  });

  it("quotes Claude Code's own line for a dialog over whatever tool is open", () => {
    const state = emptyTranscript();
    applyLine(state, call("t1", "Bash", { command: "npm test" }));
    expect(reasonOf({ waitingFor: "permission prompt", needs: "choose: allow or deny the computer-use action" }, state)).toEqual({
      kind: "permission",
      ask: "choose: allow or deny the computer-use action",
      raw: "permission prompt",
    });
  });

  it("names the call a subagent has open when the prompt comes from it", () => {
    const state = emptyTranscript();
    applyLine(state, call("t1", "Agent", { description: "Audit the cache layer", prompt: "…" }));
    const inner = { id: "s1", name: "Bash", ask: "npm run audit" };
    expect(reasonOf({ waitingFor: "permission prompt" }, state, { subagentTool: () => inner })).toEqual({ kind: "permission", ask: 'Bash: npm run audit · in subagent "Audit the cache layer"', raw: "permission prompt" });
    expect(reasonOf({ waitingFor: "permission prompt" }, state, { subagentTool: () => undefined }).ask).toBe("Agent: Audit the cache layer");
  });

  it("files the other waits the way Claude Code does, and only a dialog as a dialog", () => {
    const state = emptyTranscript();
    applyLine(state, call("t1", "Bash", { command: "curl https://example.com" }));
    expect(reasonOf({ waitingFor: "sandbox request" }, state)).toEqual({ kind: "permission", ask: "Bash: curl https://example.com · network access", raw: "sandbox request" });
    expect(reasonOf({ waitingFor: "worker request" }, state)).toEqual({ kind: "permission", ask: "worker request", raw: "worker request" });
    expect(reasonOf({ waitingFor: "goal proposal" }, state)).toEqual({ kind: "permission", ask: "goal proposal", raw: "goal proposal" });
    expect(reasonOf({ waitingFor: "input needed", needs: "MCP input: open link" }, state)).toEqual({ kind: "question", ask: "MCP input: open link", raw: "input needed" });
    expect(reasonOf({ waitingFor: "dialog open" }, state)).toEqual({ kind: "dialog", ask: "dialog open", raw: "dialog open" });
    expect(reasonOf({ waitingFor: "something new" }, state)).toEqual({ kind: "dialog", ask: "something new", raw: "something new" });
    expect(reasonOf({ waitingFor: "permission prompt" }, (() => {
      const plan = emptyTranscript();
      applyLine(plan, call("p1", "EnterPlanMode", {}));
      return plan;
    })())).toEqual({ kind: "plan", ask: "enter plan mode", raw: "permission prompt" });
  });

  it("clips a long command to 160 characters", () => {
    const state = emptyTranscript();
    applyLine(state, call("t1", "Bash", { command: `echo ${"x".repeat(300)}` }));
    const ask = reasonOf({ waitingFor: "permission prompt" }, state).ask;
    expect(ask).toHaveLength(160);
    expect(ask.endsWith("…")).toBe(true);
  });
});

describe("questionOf", () => {
  const text = (body: string, id = "m1", at = "2026-10-16T10:00:00.000Z") => JSON.stringify({ type: "assistant", timestamp: at, message: { id, content: [{ type: "text", text: body }] } });

  it("reads the last reply, joining the text blocks of one message", () => {
    const state = emptyTranscript();
    applyLine(state, text("The tests pass."));
    applyLine(state, text("Shall I push the branch?"));
    expect(questionOf(state)).toEqual({ text: "Shall I push the branch?", at: Date.parse("2026-10-16T10:00:00.000Z") });
    applyLine(state, text("Done.", "m2"));
    expect(questionOf(state)).toBeUndefined();
  });

  it("forgets the question once the turn moves on: a tool call, a prompt, an interrupt", () => {
    const asked = () => {
      const state = emptyTranscript();
      applyLine(state, text("Want me to run it?"));
      return state;
    };
    const tool = asked();
    applyLine(tool, JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }));
    expect(questionOf(tool)).toBeUndefined();
    const prompt = asked();
    applyLine(prompt, JSON.stringify({ type: "user", message: { content: "yes" } }));
    expect(questionOf(prompt)).toBeUndefined();
    const interrupt = asked();
    applyLine(interrupt, JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
    expect(questionOf(interrupt)).toBeUndefined();
    const meta = asked();
    applyLine(meta, JSON.stringify({ type: "user", isMeta: true, message: { content: "<system-reminder>" } }));
    applyLine(meta, JSON.stringify({ type: "system", subtype: "turn_duration", isMeta: true }));
    expect(questionOf(meta)?.text).toBe("Want me to run it?");
  });

  it("ignores subagents' replies", () => {
    const state = emptyTranscript();
    applyLine(state, JSON.stringify({ type: "assistant", isSidechain: true, message: { id: "s1", content: [{ type: "text", text: "Should I keep going?" }] } }));
    expect(questionOf(state)).toBeUndefined();
  });
});

describe("long transcripts and subagents", () => {
  const filler = Array.from({ length: 1200 }, () => ({ type: "progress", data: "x".repeat(1000) }));

  it("keeps the last reply of a transcript read from its last checkpoint", () => {
    // Claude Code writes a checkpoint right after a turn's last reply.
    const configDir = tempConfigDir();
    const proc = new FakeProc();
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, status: "idle" });
    fs.writeFileSync(
      transcriptPath(configDir, "/work/app", id),
      [...filler, { type: "user", cwd: "/work/app", message: { content: "ship it" } }, { type: "assistant", timestamp: "2026-10-16T10:00:00.000Z", message: { id: "m1", content: [{ type: "text", text: "Built. Want me to tag the release?" }] } }, { type: "cost-state", totalCostUSD: 1, modelUsage: {} }]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const session = new ClaudeProvider(configDir, proc).poll(Date.now())[0];
    expect(session?.question).toEqual({ text: "Built. Want me to tag the release?", at: Date.parse("2026-10-16T10:00:00.000Z") });
    expect(session?.lastReply).toBe("Built. Want me to tag the release?");
    expect(session?.spend).toMatchObject({ costUsd: 1, partial: false });
  });

  it("looks into the subagent that wrote last for the call a prompt is about", () => {
    const configDir = tempConfigDir();
    const proc = new FakeProc();
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, status: "waiting", waitingFor: "permission prompt" });
    const transcript = transcriptPath(configDir, "/work/app", id);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "assistant", cwd: "/work/app", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "Audit the cache layer" } }] } })}\n`);
    const subagents = path.join(path.dirname(transcript), id, "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    const write = (name: string, command: string, ago: number) => {
      const file = path.join(subagents, name);
      fs.writeFileSync(file, `${JSON.stringify({ type: "assistant", isSidechain: true, message: { id: `m-${name}`, content: [{ type: "tool_use", id: `t-${name}`, name: "Bash", input: { command } }] } })}\n`);
      const when = new Date(Date.now() - ago);
      fs.utimesSync(file, when, when);
    };
    write("agent-a.jsonl", "npm run audit", 60_000);
    write("agent-b.jsonl", "rm -rf .cache", 5_000);
    expect(new ClaudeProvider(configDir, proc).poll(Date.now())[0]?.reason).toEqual({ kind: "permission", ask: 'Bash: rm -rf .cache · in subagent "Audit the cache layer"', raw: "permission prompt" });
  });

  it("finds the question of a long reply even when the cut lands inside a code block", () => {
    const state = emptyTranscript();
    const code = Array.from({ length: 600 }, (_, i) => `line ${i} of the generated config`).join("\n");
    const text = `Here is the config:\n\n\`\`\`yaml\n${code}\n\`\`\`\n\nWant me to open the PR?`;
    expect(text.length).toBeGreaterThan(16 * 1024);
    applyLine(state, JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text }] } }));
    expect(questionOf(state)?.text).toBe("Want me to open the PR?");
  });
});

describe("planFileTitle", () => {
  it("takes the first heading, else the first line, without Markdown", () => {
    const dir = tempConfigDir();
    const file = path.join(dir, "plan.md");
    fs.writeFileSync(file, "Intro line\n\n## Cache the **specs**\n\n- one\n");
    expect(planFileTitle(file)).toBe("Cache the specs");
    fs.writeFileSync(file, "\n\nJust a `line`\n");
    expect(planFileTitle(file)).toBe("Just a line");
    expect(planFileTitle(path.join(dir, "missing.md"))).toBeUndefined();
  });
});

describe("where the state comes from", () => {
  it("dates the session file, explains a missing state, and does not guess", () => {
    const configDir = tempConfigDir();
    const proc = new FakeProc();
    const provider = new ClaudeProvider(configDir, proc);
    const now = Date.now();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "busy", updatedAt: now - 4_000 });
    writeSession(configDir, proc, { pid: 12, sessionId: sessionId(2), status: undefined, statusUpdatedAt: undefined, startedAt: now - 120_000 });
    writeSession(configDir, proc, { pid: 13, sessionId: sessionId(3), status: undefined, statusUpdatedAt: undefined, startedAt: now - 5_000 });
    const byPid = new Map(provider.poll(now).map((s) => [s.pid, s]));
    expect(byPid.get(11)).toMatchObject({ status: "working", evidence: { source: "session file", at: now - 4_000 } });
    expect(byPid.get(12)).toMatchObject({ status: "unknown", evidence: { source: "session file", note: "it records no state" } });
    expect(byPid.get(13)).toMatchObject({ status: "idle", evidence: { source: "process", at: now - 5_000, note: "no state recorded yet" } });
  });

  it("keeps a torn read's last good record, but calls a file that stays unreadable unknown", () => {
    const configDir = tempConfigDir();
    const proc = new FakeProc();
    const provider = new ClaudeProvider(configDir, proc);
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "busy" });
    expect(provider.poll(Date.now())[0]?.status).toBe("working");
    const file = path.join(configDir, "sessions", "11.json");
    fs.writeFileSync(file, '{"pid":11,"sessionId":"00000000-0000-4000-8000-0000000');
    // Just rewritten: a torn read, retried on the next scan.
    expect(provider.poll(Date.now())[0]).toMatchObject({ status: "working" });
    const settled = new Date(Date.now() - 10_000);
    fs.utimesSync(file, settled, settled);
    expect(provider.poll(Date.now())[0]).toMatchObject({ status: "unknown", evidence: { source: "session file", note: "it cannot be read" } });
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "idle" });
    expect(provider.poll(Date.now())[0]).toMatchObject({ status: "idle", evidence: { source: "session file" } });
  });

  it("dates an unreadable file by its bad write, and recovers when the good bytes come back", () => {
    const configDir = tempConfigDir();
    const proc = new FakeProc();
    const provider = new ClaudeProvider(configDir, proc);
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "busy" });
    const file = path.join(configDir, "sessions", "11.json");
    const good = fs.readFileSync(file, "utf8");
    const goodAt = new Date(Date.now() - 60_000);
    fs.utimesSync(file, goodAt, goodAt);
    provider.poll(Date.now());
    fs.writeFileSync(file, "{broken");
    const badAt = new Date(Date.now() - 10_000);
    fs.utimesSync(file, badAt, badAt);
    expect(provider.poll(Date.now())[0]?.evidence).toEqual({ source: "session file", at: Math.round(badAt.getTime()), note: "it cannot be read" });
    fs.writeFileSync(file, good);
    fs.utimesSync(file, badAt, badAt);
    expect(provider.poll(Date.now())[0]).toMatchObject({ status: "working", evidence: { source: "session file" } });
  });

  it("reports when the transcript was last written, for the quiet mark", () => {
    const configDir = tempConfigDir();
    const proc = new FakeProc();
    const provider = new ClaudeProvider(configDir, proc);
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, status: "busy" });
    const transcript = transcriptPath(configDir, "/work/app", id);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", cwd: "/work/app", message: { content: "go" } })}\n`);
    const quietSince = new Date(Date.now() - 12 * 60_000);
    fs.utimesSync(transcript, quietSince, quietSince);
    expect(provider.poll(Date.now())[0]?.lastWriteAt).toBe(Math.round(quietSince.getTime()));
    // A subagent at work writes its own transcript; the session is not quiet.
    const subagents = path.join(path.dirname(transcript), id, "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    const agentFile = path.join(subagents, "agent-a1.jsonl");
    fs.writeFileSync(agentFile, "{}\n");
    const recently = new Date(Date.now() - 30_000);
    fs.utimesSync(agentFile, recently, recently);
    expect(provider.poll(Date.now())[0]?.lastWriteAt).toBe(Math.round(recently.getTime()));
  });
});
