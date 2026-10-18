import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { activityOf, applyCopilotLine, emptyCopilot, factsOf, openPermission, type CopilotState } from "../../../../src/core/agents/copilot/events";
import { copilotHome, lockPids, parseWorkspace, readOpenSessions } from "../../../../src/core/agents/copilot/paths";
import { ANSWERED, ASKING, FIXTURES, lines, tempCopilotHome } from "./fixtures";

function read(file: string, count?: number): CopilotState {
  const state = emptyCopilot();
  for (const line of lines(file).slice(0, count)) applyCopilotLine(state, line);
  return state;
}

const answered = path.join(FIXTURES, "session-state", ANSWERED, "events.jsonl");
const asking = path.join(FIXTURES, "session-state", ASKING, "events.jsonl");
const edited = path.join(FIXTURES, "extra", "edited.jsonl");

describe("a Copilot session's events", () => {
  it("give its folder, prompt, reply, model, effort, context and tokens", () => {
    const state = read(answered);
    expect(state).toMatchObject({ cwd: "/work/a", firstPrompt: "What is 2+2? Answer with one word and run no commands.", model: "mai-code-1.1-flash", effort: "medium", contextTokens: 14_775, contextWindow: 128_000 });
    expect(state.lastReply?.text).toBe("Four");
    expect(state.tokens).toEqual({ input: 14_775, output: 5, cacheRead: 7_552, cacheWrite: 0 });
    expect(openPermission(state)).toBeUndefined();
  });

  it("hold an approval prompt open until it is answered, quoting the command and Copilot's intention", () => {
    expect(openPermission(read(asking))).toMatchObject({ at: Date.parse("2026-10-18T13:12:43.613Z"), reason: { kind: "permission", ask: "touch approval-test.txt", raw: "Create approval-test.txt" } });
    // Before the request: the command is running, as far as the events say.
    expect(activityOf(read(asking, 17))).toBe("bash · touch approval-test.txt");
    const done = read(edited);
    expect(openPermission(done)).toBeUndefined();
    expect(done.tools.size).toBe(0);
  });

  it("quote a file Copilot asks to write", () => {
    const state = read(edited, lines(edited).findIndex((line) => line.includes('"kind":"write"')) + 1);
    expect(openPermission(state)?.reason).toMatchObject({ kind: "permission", ask: "/work/b/notes.md", raw: "Create file" });
  });

  it("hold the messages and the paths its tools named, for the search", () => {
    const facts = lines(edited).map(factsOf).filter(Boolean);
    expect(facts.filter((f) => f!.message).map((f) => [f!.message!.role, f!.message!.text])).toEqual([
      ["you", "Run the shell command: touch approval-test.txt"],
      ["agent", "Created `approval-test.txt`."],
      ["you", "Create a file notes.md containing the line hello, using your file tools rather than the shell."],
      ["agent", "Created `notes.md` with the line `hello`."],
    ]);
    expect(facts.flatMap((f) => f!.paths ?? [])).toEqual(["approval-test.txt", "notes.md"]);
  });
});

describe("Copilot's files", () => {
  it("are under COPILOT_HOME, or the setting, or ~/.copilot", () => {
    // Joined by the platform's path module: backslashes, and a drive before an absolute path, on Windows.
    expect(copilotHome(undefined, {}, "/home/u")).toBe(path.join("/home/u", ".copilot"));
    expect(copilotHome("", { COPILOT_HOME: "/data/copilot" }, "/home/u")).toBe(path.resolve("/data/copilot"));
    expect(copilotHome("~/c", { COPILOT_HOME: "/data/copilot" }, "/home/u")).toBe(path.join("/home/u", "c"));
  });

  it("read a workspace's flat fields, quoted or not", () => {
    expect(parseWorkspace('id: 1\ncwd: "/work/my app"\nclient_name: github/cli\nname: Fix "it"\ncreated_at: 2026-10-18T13:10:58.584Z\n')).toEqual({ id: "1", cwd: "/work/my app", clientName: "github/cli", name: 'Fix "it"', createdAt: Date.parse("2026-10-18T13:10:58.584Z"), updatedAt: undefined });
  });

  it("name the processes holding a session, and Copilot's working flags", () => {
    const home = tempCopilotHome({ [ANSWERED]: false, [ASKING]: true });
    expect(lockPids(path.join(home, "session-state", ASKING))).toEqual([4002]);
    expect([...readOpenSessions(path.join(home, "open-sessions-state.json"))]).toEqual([
      [ANSWERED, { working: false, refreshedAt: Date.parse("2026-10-18T13:13:18.400Z") }],
      [ASKING, { working: true, refreshedAt: Date.parse("2026-10-18T13:13:18.400Z") }],
    ]);
    expect(readOpenSessions(path.join(home, "missing.json")).size).toBe(0);
  });

  it("are anonymised copies of real sessions", () => {
    const text = [answered, asking, edited].map((f) => lines(f).join("\n")).join("\n");
    expect(text).not.toMatch(/\/home\/bob|Jerusalem/);
  });
});
