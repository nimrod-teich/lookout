import { beforeEach, describe, expect, it } from "vitest";
import { copilotPanel } from "../../src/vscode/agents/copilotPanel";
import { view } from "./helpers";
import { stub, TabInputText } from "./stub-vscode";

const ADDRESS = "agent-host-copilotcli:/f7b4f52e-06e8-4a0d-9d38-4e01ebedf33e";
const log = { info: () => {}, errorOnce: () => {} } as never;

describe("Copilot's sessions in VS Code's Chat", () => {
  beforeEach(() => {
    stub.reset();
    stub.commands.set("workbench.action.chat.openSessionInEditorGroup", () => undefined);
  });

  it("opens a session in an editor of the active group, by VS Code's address for it, and resumes an earlier one the same way", async () => {
    expect(await copilotPanel.reveal(view({ agent: "copilot", vscodeSession: ADDRESS }), log)).toBe("revealed");
    expect(await copilotPanel.resume("446903d1", log, { id: "446903d1", agent: "copilot", title: "t", project: "p", cwd: "/work/p", resumable: true, modifiedAt: 0, vscodeSession: ADDRESS })).toBe(true);
    const calls = stub.ops.filter((op) => op[1] === "workbench.action.chat.openSessionInEditorGroup").map((op) => String((op[2] as [{ resource: unknown }])[0].resource));
    expect(calls).toEqual([ADDRESS, ADDRESS]);
  });

  it("fails without VS Code's address, or when VS Code cannot open it", async () => {
    expect(await copilotPanel.reveal(view({ agent: "copilot" }), log)).toBe("failed");
    expect(await copilotPanel.resume("446903d1", log)).toBe(false);
    stub.commands.set("workbench.action.chat.openSessionInEditorGroup", () => {
      throw new Error("no such session");
    });
    expect(await copilotPanel.reveal(view({ agent: "copilot", vscodeSession: ADDRESS }), log)).toBe("failed");
    expect(await copilotPanel.rename(view({ agent: "copilot" }), log)).toBe(false);
  });

  it("brings forward the chat tab that carries the session's title, where its approval prompt is, before anything else", async () => {
    stub.commands.set("workbench.action.focusSecondEditorGroup", () => undefined);
    stub.commands.set("workbench.action.openEditorAtIndex", () => undefined);
    stub.groups.push({ viewColumn: 1, tabs: [] } as never);
    const group = { viewColumn: 2, tabs: [] as unknown[] };
    group.tabs = [
      { label: "Run terminal command touch", input: new TabInputText({}), group },
      { label: "Run terminal command touch", input: undefined, group },
    ];
    stub.groups.push(group as never);
    expect(await copilotPanel.reveal(view({ agent: "copilot", title: "Run terminal command touch", vscodeSession: "copilotcli:/2bbb5061" }), log)).toBe("revealed-by-tab");
    expect(stub.ops.filter((op) => op[0] === "commands").map((op) => [op[1], op[2]])).toEqual([
      ["workbench.action.focusSecondEditorGroup", []],
      ["workbench.action.openEditorAtIndex", [1]],
    ]);
  });
});
