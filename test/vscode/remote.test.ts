import { beforeEach, describe, expect, it } from "vitest";
import { REMOTE_CONTROL_COMMAND, toggleRemoteControl } from "../../src/vscode/remote";
import { Terminals } from "../../src/vscode/terminals";
import { fakeLog, settle, view } from "./helpers";
import { stub } from "./stub-vscode";

const CLAUDE_OPEN = "claude-vscode.editor.open";

async function terminals(): Promise<Terminals> {
  const t = new Terminals();
  await settle();
  return t;
}

function messages(kind: string): string[] {
  return stub.ops.filter(([target, action]) => target === "window" && action === kind).map(([, , text]) => String(text));
}

describe("toggleRemoteControl", () => {
  beforeEach(() => stub.reset());

  it("types the agent's command into the terminal a session runs in, and brings it forward", async () => {
    stub.addTerminal("zsh", 70);
    stub.addTerminal("claude", 71);
    const result = await toggleRemoteControl(view({ host: "terminal", terminalPid: 71 }), await terminals(), fakeLog());
    expect(result).toBe("sent");
    expect(stub.ops).toEqual([
      ["terminal:claude", "sendText", [REMOTE_CONTROL_COMMAND, true]],
      ["terminal:claude", "show", true],
    ]);
    expect(messages("info")).toEqual([]);
  });

  it("says that the agent asks before disconnecting when Remote Control is already on", async () => {
    stub.addTerminal("claude", 71);
    expect(await toggleRemoteControl(view({ host: "terminal", terminalPid: 71, remote: true }), await terminals(), fakeLog())).toBe("sent");
    expect(stub.ops[0]).toEqual(["terminal:claude", "sendText", [REMOTE_CONTROL_COMMAND, true]]);
    expect(messages("info")[0]).toContain("Disconnect");
  });

  it("types nothing into a terminal whose session waits on a prompt: the line would answer it", async () => {
    stub.addTerminal("claude", 71);
    const result = await toggleRemoteControl(view({ host: "terminal", terminalPid: 71, state: "waiting", needs: "permission prompt" }), await terminals(), fakeLog());
    expect(result).toBe("refused");
    expect(stub.ops.filter(([target]) => target.startsWith("terminal:"))).toEqual([]);
    expect(messages("info")[0]).toContain("waiting for you");
  });

  it("fails when the session's terminal is gone", async () => {
    expect(await toggleRemoteControl(view({ host: "terminal", terminalPid: 71 }), await terminals(), fakeLog())).toBe("failed");
    expect(messages("warning")[0]).toContain("could not find the terminal");
  });

  it("brings a panel session's tab to the front and says what to type", async () => {
    stub.commands.set(CLAUDE_OPEN, () => undefined);
    const v = view({ host: "panel", remote: true });
    expect(await toggleRemoteControl(v, await terminals(), fakeLog())).toBe("revealed");
    expect(stub.ops.find(([target, command]) => target === "commands" && command === CLAUDE_OPEN)?.[2]).toEqual([v.id, undefined, undefined, undefined, undefined, { programmatic: "pin-to-panel" }]);
    const info = messages("info")[0];
    expect(info).toContain(REMOTE_CONTROL_COMMAND);
    expect(info).toContain("off");
  });

  it("fails when a panel session's tab cannot be found", async () => {
    expect(await toggleRemoteControl(view({ host: "panel" }), await terminals(), fakeLog())).toBe("failed");
    expect(messages("warning")[0]).toContain("could not find the tab");
  });

  it("leaves sessions of other windows and of other hosts alone", async () => {
    expect(await toggleRemoteControl(view({ host: "window", windowLabel: "api" }), await terminals(), fakeLog())).toBe("refused");
    expect(await toggleRemoteControl(view({ host: "elsewhere" }), await terminals(), fakeLog())).toBe("refused");
    expect(messages("info")).toEqual([expect.stringContaining('in the window "api"'), expect.stringContaining("outside VS Code")]);
    expect(stub.ops.filter(([target]) => target !== "window")).toEqual([]);
  });
});
