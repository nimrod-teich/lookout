import { describe, expect, it } from "vitest";
import type { SessionView } from "../../src/core/types";
import { Answerer } from "../../src/vscode/answer";
import { fakeLog, view } from "./helpers";

const ID = "00000000-0000-4000-8000-000000000001";

function waiting(overrides: Partial<SessionView> = {}): SessionView {
  return view({ id: ID, state: "waiting", host: "terminal", terminalPid: 500, reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt", call: "t1", answer: "yesno" }, ...overrides });
}

function setup(sessions: SessionView[], open = true) {
  const state = { sessions, refreshes: 0 };
  const sent: [number, string][] = [];
  const answerer = new Answerer({
    refresh: () => {
      state.refreshes++;
      return state.sessions;
    },
    send: (pid, keys) => {
      if (!open) return false;
      sent.push([pid, keys]);
      return true;
    },
    log: fakeLog(),
  });
  return { answerer, sent, state };
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
    const { answerer, sent } = setup([waiting()]);
    expect(answerer.answer(ID, "t1", "yes")).toBe("sent");
    // The card is still a moment old: the same prompt shows until Claude Code writes its state.
    expect(answerer.answer(ID, "t1", "yes")).toBe("moved-on");
    expect(answerer.answer(ID, "t1", "no")).toBe("moved-on");
    expect(sent).toEqual([[500, "1"]]);
  });

  it("says so when the terminal is gone", () => {
    const { answerer, sent } = setup([waiting()], false);
    expect(answerer.answer(ID, "t1", "yes")).toBe("no-terminal");
    expect(sent).toEqual([]);
    // Not counted as answered: the prompt can still be answered once the terminal is found.
  });
});
