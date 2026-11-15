import { describe, expect, it } from "vitest";
import { answersOf, keysFor } from "../../src/core/answers";
import type { SessionView } from "../../src/core/types";
import { view } from "../vscode/helpers";

/** A Claude Code session in one of this window's terminals, waiting on a prompt the card can answer. */
function waiting(overrides: Partial<SessionView> = {}): SessionView {
  return view({ state: "waiting", host: "terminal", terminalPid: 500, reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt", call: "t1", answer: "yesno" }, ...overrides });
}

describe("answersOf", () => {
  it("offers yes and no to a permission, and each option of a question", () => {
    expect(answersOf(waiting()).map((answer) => [answer.choice, answer.label])).toEqual([
      ["yes", "Yes"],
      ["no", "No"],
    ]);
    const question = waiting({ reason: { kind: "question", ask: "Which colour?", options: ["Red", "Blue"], raw: "input needed", call: "q1", answer: "options" } });
    expect(answersOf(question).map((answer) => [answer.choice, answer.label])).toEqual([
      [0, "Red"],
      [1, "Blue"],
    ]);
    expect(answersOf(question)[1]!.title).toBe("Answer “Blue”: Lookout presses 2 in its terminal");
    expect(answersOf(waiting())[1]!.title).toContain("presses Esc");
  });

  it("offers the answers of a panel session's prompt while Lookout's hook waits on it, or would once turned on", () => {
    const live = waiting({ host: "panel", terminalPid: undefined, promptHook: "live" });
    expect(answersOf(live).map((answer) => answer.choice)).toEqual(["yes", "no"]);
    expect(answersOf(live)[0]!.title).toBe("Allow it once: Lookout answers it in the panel");
    const off = waiting({ host: "panel", terminalPid: undefined, promptHook: "off", reason: { kind: "question", ask: "Which colour?", options: ["Red", "Blue"], raw: "input needed", call: "q1", answer: "options" } });
    expect(answersOf(off).map((answer) => answer.label)).toEqual(["Red", "Blue"]);
    expect(answersOf(off)[0]!.title).toBe("Answer “Red”: Lookout first asks to answer the panel's prompts from cards");
    // A panel session's prompt the reader cannot vouch for is not offered either.
    expect(answersOf(waiting({ host: "panel", promptHook: "live", reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt" } }))).toEqual([]);
  });

  it("offers nothing where Lookout cannot type: the agent's panel, another window, outside VS Code", () => {
    expect(answersOf(waiting({ host: "panel" }))).toEqual([]);
    expect(answersOf(waiting({ host: "window", windowLabel: "api" }))).toEqual([]);
    expect(answersOf(waiting({ host: "elsewhere" }))).toEqual([]);
    expect(answersOf(waiting({ terminalPid: undefined }))).toEqual([]);
  });

  it("offers nothing for an agent whose keys Lookout does not know, or a prompt the reader cannot vouch for", () => {
    expect(answersOf(waiting({ agent: "codex" }))).toEqual([]);
    expect(answersOf(waiting({ agent: "copilot" }))).toEqual([]);
    expect(answersOf(waiting({ reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt" } }))).toEqual([]);
    expect(answersOf(waiting({ reason: { kind: "permission", ask: "permission prompt", raw: "permission prompt", call: "t1", answer: "yesno", tentative: true } }))).toEqual([]);
    expect(answersOf(waiting({ state: "working" }))).toEqual([]);
    expect(answersOf(waiting({ reason: { kind: "typed", ask: "Shall I go on?" } }))).toEqual([]);
  });
});

describe("keysFor", () => {
  it("types 1 for yes, Esc for no, and an option's number", () => {
    expect(keysFor(waiting(), "t1", "yes")).toBe("1");
    expect(keysFor(waiting(), "t1", "no")).toBe("\u001b");
    const question = waiting({ reason: { kind: "question", ask: "Which colour?", options: ["Red", "Blue"], raw: "input needed", call: "q1", answer: "options" } });
    expect(keysFor(question, "q1", 1)).toBe("2");
  });

  it("types nothing for another call, an answer not on offer, or a session that moved on", () => {
    expect(keysFor(waiting(), "t0", "yes")).toBeUndefined();
    expect(keysFor(waiting(), "t1", 0)).toBeUndefined();
    const question = waiting({ reason: { kind: "question", ask: "Which colour?", options: ["Red", "Blue"], raw: "input needed", call: "q1", answer: "options" } });
    expect(keysFor(question, "q1", 2)).toBeUndefined();
    expect(keysFor(question, "q1", "yes")).toBeUndefined();
    expect(keysFor(waiting({ state: "working", reason: undefined }), "t1", "yes")).toBeUndefined();
  });

  it("types nothing for a panel session: its answer goes through the hook", () => {
    expect(keysFor(waiting({ host: "panel", terminalPid: undefined, promptHook: "live" }), "t1", "yes")).toBeUndefined();
  });
});
