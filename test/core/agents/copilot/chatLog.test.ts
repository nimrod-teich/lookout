import { describe, expect, it } from "vitest";
import { applyChatLine, type ChatLog } from "../../../../src/core/agents/copilot/chatLog";

function replay(...changes: unknown[]): ChatLog["root"] {
  const log: ChatLog = {};
  for (const change of changes) applyChatLine(log, typeof change === "string" ? change : JSON.stringify(change));
  return log.root;
}

describe("a VS Code chat session's log", () => {
  it("starts from the whole session and applies each change in order", () => {
    const root = replay(
      { kind: 0, v: { sessionId: "s1", requests: [{ message: { text: "run the tests" }, modelState: { value: 0 } }] } },
      { kind: 1, k: ["requests", 0, "modelState"], v: { value: 4 } },
      { kind: 2, k: ["requests", 0, "response"], v: [{ kind: "toolInvocationSerialized", toolId: "run_in_terminal" }] },
      { kind: 2, k: ["requests", 0, "response"], v: [{ kind: "text", value: "done" }] },
      { kind: 1, k: ["customTitle"], v: "Run the tests" },
    );
    expect(root).toEqual({
      sessionId: "s1",
      customTitle: "Run the tests",
      requests: [{ message: { text: "run the tests" }, modelState: { value: 4 }, response: [{ kind: "toolInvocationSerialized", toolId: "run_in_terminal" }, { kind: "text", value: "done" }] }],
    });
  });

  it("cuts an array before appending when told where, and makes the containers a path needs", () => {
    const root = replay(
      { kind: 0, v: { requests: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
      { kind: 2, k: ["requests"], i: 1, v: [{ id: 9 }] },
      { kind: 1, k: ["inputState", "mode", "id"], v: "agent" },
      { kind: 2, k: ["requests", 1, "response"], v: [{ kind: "text" }] },
    );
    expect(root).toEqual({ requests: [{ id: 1 }, { id: 9, response: [{ kind: "text" }] }], inputState: { mode: { id: "agent" } } });
  });

  it("skips what is not a change, and changes before the session", () => {
    expect(replay({ kind: 1, k: ["customTitle"], v: "early" }, "not json", "", { kind: 0, v: { requests: [] } }, { kind: 3, k: ["requests"] }, { kind: 1, k: [], v: 1 })).toEqual({ requests: [] });
  });
});
