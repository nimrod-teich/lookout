import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { activityOf, applyRolloutLine, approvalCall, emptyRollout, execCall, isContext, turnRunning, waitReason, type RolloutState } from "../../../../src/core/agents/codex/rollout";
import { APPROVAL, ASKED_IN_REPLY, FIXTURES, fixtureFile, fixtureLines, IDLE, QUESTION, WORKING } from "./fixtures";

function read(file: string, from = 0): RolloutState {
  const state = emptyRollout();
  for (const line of fixtureLines(file).slice(from)) applyRolloutLine(state, line);
  return state;
}

describe("a Codex rollout", () => {
  it("gives the thread, its folder, model, context and the last reply of a finished turn", () => {
    const state = read(fixtureFile(IDLE));
    expect(state).toMatchObject({ id: IDLE, cwd: "/work/a", originator: "codex-tui", model: "gpt-6.1-sol", contextWindow: 475_000, turnOpen: false, firstPrompt: "What is 2+2? Answer with one word and do not run any commands." });
    expect(state.contextTokens).toBeGreaterThan(14_000);
    expect(state.lastReply).toMatchObject({ text: "Four", final: true });
    expect(state.effort).toBeUndefined();
    expect(turnRunning(state)).toBe(false);
    expect(waitReason(state)).toBeUndefined();
  });

  it("waits for approval while a command that asked to leave the sandbox has no result, quoting the command and Codex's reason", () => {
    const state = read(fixtureFile(APPROVAL));
    expect(turnRunning(state)).toBe(true);
    expect(approvalCall(state)).toMatchObject({ name: "exec", command: "touch approval-test.txt", escalated: true });
    expect(waitReason(state)).toEqual({ kind: "permission", ask: "touch approval-test.txt", raw: "May I create approval-test.txt in the current directory?" });
  });

  it("works while a turn runs, on the command it runs", () => {
    const state = read(fixtureFile(WORKING));
    expect(turnRunning(state)).toBe(true);
    expect(approvalCall(state)).toBeUndefined();
    expect(activityOf(state)).toBe("exec · sleep 25 && echo ok");
    // Approved, and polled in the background: still working, not waiting.
    const polling = read(path.join(FIXTURES, "extra", "polling.jsonl"));
    expect(turnRunning(polling)).toBe(true);
    expect(approvalCall(polling)).toBeUndefined();
    expect(activityOf(polling)).toBe("exec");
  });

  it("keeps a question asked with options open after the turn ends, until the user writes", () => {
    const state = read(fixtureFile(QUESTION));
    expect(turnRunning(state)).toBe(false);
    expect(waitReason(state)).toEqual({ kind: "question", ask: "Which colour do you prefer, red or blue?", options: ["Red", "Blue"] });
    applyRolloutLine(state, JSON.stringify({ timestamp: "2026-10-18T12:20:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Blue" }] } }));
    expect(waitReason(state)).toBeUndefined();
  });

  it("ends a turn that was interrupted, its open calls with it, though the command it left running reports its end later", () => {
    const state = read(path.join(FIXTURES, "extra", "interrupted.jsonl"));
    expect(turnRunning(state)).toBe(false);
    expect(state.openCalls.size).toBe(0);
    // The `sleep` went on in the background; its end comes after the abort and opens no turn.
    expect(state.lastRecord).toBe("event_msg/item_completed");
    expect(state.turnOpen).toBe(false);
  });

  it("leaves a reply that asks something mid-paragraph to Lookout's own reading", () => {
    const state = read(fixtureFile(ASKED_IN_REPLY));
    expect(turnRunning(state)).toBe(false);
    expect(state.lastReply?.text).toMatch(/^May I add `hello`/);
  });

  it("read from the middle, goes by the last record until a turn starts or ends", () => {
    const lines = fixtureLines(fixtureFile(WORKING));
    const start = lines.findIndex((line) => line.includes('"type":"task_started"') && line.includes("12:20"));
    const state = read(fixtureFile(WORKING), start + 1);
    expect(state.turnOpen).toBeUndefined();
    expect(turnRunning(state)).toBe(true);
    expect(turnRunning(read(fixtureFile(IDLE), 14))).toBe(false);
  });

  it("skips Codex's own context messages and lines that do not parse", () => {
    const state = emptyRollout();
    for (const line of ["", "{not json", "null", JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/x</cwd>" }] } })]) applyRolloutLine(state, line);
    expect(state.firstPrompt).toBeUndefined();
    expect(isContext("  <environment_context>")).toBe(true);
    expect(isContext("Fix the build")).toBe(false);
  });

  it("reads the command out of Codex's tool-call code, escapes and all", () => {
    expect(execCall('text(await tools.exec_command({cmd:"echo \\"hi\\" && ls",workdir:"/w"}));')).toEqual({ command: 'echo "hi" && ls', escalated: false, justification: undefined });
    expect(execCall('tools.exec_command({cmd:"rm x",sandbox_permissions:"require_escalated",justification:"May I?"})')).toEqual({ command: "rm x", escalated: true, justification: "May I?" });
    expect(execCall("tools.write_stdin({session_id:1})")).toEqual({ command: undefined, escalated: false, justification: undefined });
  });

  it("are all copies of real sessions, with no home folder, time zone or account id left", () => {
    const text = fs.readdirSync(path.join(FIXTURES, "extra")).map((n) => fs.readFileSync(path.join(FIXTURES, "extra", n), "utf8")).join("");
    expect(text).not.toMatch(/\/home\/bob|Jerusalem/);
    expect(text).not.toMatch(/"creator_(user|account)_id":"(?!<masked>)/);
  });
});
