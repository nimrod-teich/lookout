import * as fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { settingsFile } from "../../src/core/agents/claude/remoteControl";
import { REMOTE_CONTROL_COMMAND, toggleRemoteControl } from "../../src/vscode/remote";
import { tempConfigDir } from "../core/helpers";
import { Terminals } from "../../src/vscode/terminals";
import { fakeLog, settle, view } from "./helpers";
import { stub } from "./stub-vscode";

const CLAUDE_OPEN = "claude-vscode.editor.open";
const noOptions = { configDir: () => "/nowhere", sessions: () => [] };

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
    const result = await toggleRemoteControl(view({ host: "terminal", terminalPid: 71 }), await terminals(), fakeLog(), noOptions);
    expect(result).toBe("sent");
    expect(stub.ops).toEqual([
      ["terminal:claude", "sendText", [REMOTE_CONTROL_COMMAND, true]],
      ["terminal:claude", "show", true],
    ]);
    expect(messages("info")).toEqual([]);
  });

  it("says that the agent asks before disconnecting when Remote Control is already on", async () => {
    stub.addTerminal("claude", 71);
    expect(await toggleRemoteControl(view({ host: "terminal", terminalPid: 71, remote: true }), await terminals(), fakeLog(), noOptions)).toBe("sent");
    expect(stub.ops[0]).toEqual(["terminal:claude", "sendText", [REMOTE_CONTROL_COMMAND, true]]);
    expect(messages("info")[0]).toContain("Disconnect");
  });

  it("types nothing into a terminal whose session waits on a prompt: the line would answer it", async () => {
    stub.addTerminal("claude", 71);
    const result = await toggleRemoteControl(view({ host: "terminal", terminalPid: 71, state: "waiting", needs: "permission prompt" }), await terminals(), fakeLog(), noOptions);
    expect(result).toBe("refused");
    expect(stub.ops.filter(([target]) => target.startsWith("terminal:"))).toEqual([]);
    expect(messages("info")[0]).toContain("waiting for you");
  });

  it("fails when the session's terminal is gone", async () => {
    expect(await toggleRemoteControl(view({ host: "terminal", terminalPid: 71 }), await terminals(), fakeLog(), noOptions)).toBe("failed");
    expect(messages("warning")[0]).toContain("could not find the terminal");
  });

  it("asks, then switches every Claude tab through the agent's startup setting, and waits for the tab to connect", async () => {
    const dir = tempConfigDir();
    const v = view({ host: "panel" });
    const file = settingsFile(dir);
    // The tab reports itself connected once the setting is on disk.
    const options = { configDir: () => dir, sessions: () => [view({ host: "panel", remote: fs.existsSync(file) }), view({ id: "00000000-0000-4000-8000-000000000002", host: "panel" })] };
    stub.notificationAnswer = "Turn on for all tabs";
    expect(await toggleRemoteControl(v, await terminals(), fakeLog(), options)).toBe("switched");
    expect(messages("warning")[0]).toContain("2 in this window");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ remoteControlAtStartup: true });
    expect(messages("info")).toEqual([`Remote Control is on for "${v.title}" and the other Claude tabs.`]);
    expect(stub.ops.filter(([target]) => target === "commands")).toEqual([]);
  });

  it("turns the tabs off the same way", async () => {
    const dir = tempConfigDir();
    fs.writeFileSync(settingsFile(dir), '{\n  "model": "opus"\n}\n');
    const v = view({ host: "panel", remote: true });
    const options = { configDir: () => dir, sessions: () => [view({ host: "panel", remote: !/false/.test(fs.readFileSync(settingsFile(dir), "utf8")) })] };
    stub.notificationAnswer = "Turn off for all tabs";
    expect(await toggleRemoteControl(v, await terminals(), fakeLog(), options)).toBe("switched");
    expect(JSON.parse(fs.readFileSync(settingsFile(dir), "utf8"))).toEqual({ model: "opus", remoteControlAtStartup: false });
    expect(messages("info")).toEqual(["Remote Control is off for the Claude tabs."]);
  });

  it("writes nothing when the user cancels", async () => {
    const dir = tempConfigDir();
    const options = { configDir: () => dir, sessions: () => [view({ host: "panel" })] };
    expect(await toggleRemoteControl(view({ host: "panel" }), await terminals(), fakeLog(), options)).toBe("refused");
    expect(fs.existsSync(settingsFile(dir))).toBe(false);
    expect(messages("info")).toEqual([]);
  });

  it("says so when the agent has not reacted in time", async () => {
    const dir = tempConfigDir();
    const options = { configDir: () => dir, sessions: () => [view({ host: "panel" })], waitMs: 50 };
    stub.notificationAnswer = "Turn on for all tabs";
    expect(await toggleRemoteControl(view({ host: "panel" }), await terminals(), fakeLog(), options)).toBe("switched");
    expect(messages("warning")[1]).toContain("has not connected");
  });

  it("falls back to the tab's input when the settings cannot be written", async () => {
    const dir = tempConfigDir();
    fs.writeFileSync(settingsFile(dir), "[1]\n");
    const v = view({ host: "panel" });
    const group = stub.addClaudeGroup([v.title]);
    stub.commands.set(CLAUDE_OPEN, () => stub.activate(group.tabs[0]!));
    stub.commands.set("claude-vscode.focus", () => undefined);
    stub.notificationAnswer = "Turn on for all tabs";
    const log = fakeLog();
    expect(await toggleRemoteControl(v, await terminals(), log, { configDir: () => dir, sessions: () => [v] })).toBe("revealed");
    expect(messages("error")[0]).toContain("not a JSON object");
    expect(stub.ops.filter(([target]) => target === "commands").map(([, command]) => command)).toEqual([CLAUDE_OPEN, "claude-vscode.focus"]);
    expect(messages("info")).toEqual(["Type /rc ⏎ to turn Remote Control on."]);
  });

  it("leaves sessions of other windows and of other hosts alone", async () => {
    expect(await toggleRemoteControl(view({ host: "window", windowLabel: "api" }), await terminals(), fakeLog(), noOptions)).toBe("refused");
    expect(await toggleRemoteControl(view({ host: "elsewhere" }), await terminals(), fakeLog(), noOptions)).toBe("refused");
    expect(messages("info")).toEqual([expect.stringContaining('in the window "api"'), expect.stringContaining("outside VS Code")]);
    expect(stub.ops.filter(([target]) => target !== "window")).toEqual([]);
  });
});
