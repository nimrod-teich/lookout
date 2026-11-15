import { describe, expect, it } from "vitest";
import type { SessionView } from "../../src/core/types";
import { Answerer } from "../../src/vscode/answer";
import { fakeLog, view } from "./helpers";

const ID = "00000000-0000-4000-8000-000000000001";

function waiting(overrides: Partial<SessionView> = {}): SessionView {
  return view({ id: ID, state: "waiting", host: "terminal", terminalPid: 500, reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt", call: "t1", answer: "yesno" }, ...overrides });
}

function setup(sessions: SessionView[], open = true, hookWaits = true) {
  const state = { sessions, refreshes: 0, open, hookWaits };
  const sent: [number, string][] = [];
  const replied: [string, string | number][] = [];
  const answerer = new Answerer({
    refresh: () => {
      state.refreshes++;
      return state.sessions;
    },
    send: (pid, keys) => {
      if (!state.open) return false;
      sent.push([pid, keys]);
      return true;
    },
    reply: (v, choice) => {
      if (!state.hookWaits) return false;
      replied.push([v.id, choice]);
      return true;
    },
    log: fakeLog(),
  });
  return { answerer, sent, replied, state };
}

describe("Answerer", () => {
  it("reads the sessions again, then types the answer's key into the session's terminal", () => {
    const { answerer, sent, state } = setup([waiting()]);
    expect(answerer.answer(ID, "t1", "yes")).toBe("sent");
    expect(state.refreshes).toBe(1);
    expect(sent).toEqual([[500, "1"]]);
  });

  it("types nothing once the session no longer shows that prompt", () => {
    // Answered in the terminal meanwhile: the session works again.
    const moved = setup([waiting({ state: "working", reason: undefined })]);
    expect(moved.answerer.answer(ID, "t1", "no")).toBe("moved-on");
    expect(moved.sent).toEqual([]);
    // Another call's prompt now: an Esc meant for the first must not refuse the second.
    const next = setup([waiting({ reason: { kind: "permission", ask: "Bash: rm -rf dist", raw: "permission prompt", call: "t2", answer: "yesno" } })]);
    expect(next.answerer.answer(ID, "t1", "no")).toBe("moved-on");
    expect(next.sent).toEqual([]);
    // Gone.
    const gone = setup([]);
    expect(gone.answerer.answer(ID, "t1", "yes")).toBe("moved-on");
  });

  it("answers a call once, however often it is asked", () => {
    const { answerer, sent, state } = setup([waiting()]);
    expect(answerer.answer(ID, "t1", "yes")).toBe("sent");
    // The card is still a moment old: the same prompt shows until Claude Code writes its state.
    expect(answerer.answer(ID, "t1", "yes")).toBe("already");
    expect(answerer.answer(ID, "t1", "no")).toBe("already");
    expect(sent).toEqual([[500, "1"]]);
    // Refused before reading the sessions again.
    expect(state.refreshes).toBe(1);
  });

  it("says so when the terminal is gone, and answers once it is back", () => {
    const { answerer, sent, state } = setup([waiting()], false);
    expect(answerer.answer(ID, "t1", "yes")).toBe("no-terminal");
    expect(sent).toEqual([]);
    // Not counted as answered: the card offers the answer again.
    state.open = true;
    expect(answerer.answer(ID, "t1", "yes")).toBe("sent");
    expect(sent).toEqual([[500, "1"]]);
  });

  it("hands a panel session's answer to Lookout's hook, and types nothing", () => {
    const { answerer, sent, replied } = setup([waiting({ host: "panel", terminalPid: undefined, promptHook: "live" })]);
    expect(answerer.answer(ID, "t1", "no")).toBe("sent");
    expect(replied).toEqual([[ID, "no"]]);
    expect(sent).toEqual([]);
    expect(answerer.answer(ID, "t1", "no")).toBe("already");
  });

  it("asks to turn the hook on before answering a panel session, and counts nothing as answered", () => {
    const { answerer, replied, state } = setup([waiting({ host: "panel", terminalPid: undefined, promptHook: "off" })]);
    expect(answerer.answer(ID, "t1", "yes")).toBe("hook-off");
    expect(replied).toEqual([]);
    state.sessions = [waiting({ host: "panel", terminalPid: undefined, promptHook: "live" })];
    expect(answerer.answer(ID, "t1", "yes")).toBe("sent");
  });

  it("says the session moved on when no hook waits on its prompt any more: the panel answered first", () => {
    const { answerer, replied } = setup([waiting({ host: "panel", terminalPid: undefined, promptHook: "live" })], true, false);
    expect(answerer.answer(ID, "t1", "yes")).toBe("moved-on");
    expect(replied).toEqual([]);
  });
});
