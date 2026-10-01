import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../../src/extension";
import { stub } from "./stub-vscode";

// The whole extension against a real process: a child of this test process
// plays a Claude Code panel session, so the real process table places it in
// "this window" (the test process stands in for the extension host).

const SESSION = "00000000-0000-4000-8000-0000000000aa";
const CLAUDE_OPEN = "claude-vscode.editor.open";
const WAIT = { timeout: 25_000, interval: 100 };

let configDir: string;
let child: ChildProcess;
let subscriptions: { dispose(): void }[];

function writeSession(fields: Record<string, unknown>): void {
  const record = { pid: child.pid, sessionId: SESSION, cwd: "/work/app", startedAt: Date.now(), kind: "interactive", entrypoint: "claude-vscode", ...fields };
  fs.writeFileSync(path.join(configDir, "sessions", `${child.pid}.json`), JSON.stringify(record));
}

function statusText(): string | undefined {
  return stub.ops.filter(([target, action]) => target === "statusBar:lookout.sessions" && action === "set:text").at(-1)?.[2] as string | undefined;
}

function infoMessages(): string[] {
  return stub.ops.filter(([target, action]) => target === "window" && action === "info").map(([, , text]) => String(text));
}

beforeEach(() => {
  stub.reset();
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-e2e-"));
  fs.mkdirSync(path.join(configDir, "sessions"));
  stub.config["lookout.claudeConfigDir"] = configDir;
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  subscriptions = [];
});

afterEach(() => {
  for (const subscription of subscriptions) subscription.dispose();
  child.kill();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("the extension", () => {
  it("shows a session, jumps to its panel, marks its finished turn, and drops it when it exits", async () => {
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    activate({ subscriptions } as never);
    await vi.waitFor(() => expect(statusText()).toMatch(/^\$\(telescope\) [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1$/), WAIT);

    // Jump: the picker offers the session; choosing it calls the Claude command with its id.
    // On platforms that list processes in the background, the session is placed once the list arrives.
    stub.commands.set(CLAUDE_OPEN, () => undefined);
    stub.quickPick = (items) => items[0];
    await vi.waitFor(async () => {
      await stub.commands.get("lookout.jump")!();
      expect(stub.ops.some(([target, command, args]) => target === "commands" && command === CLAUDE_OPEN && (args as unknown[])[0] === SESSION)).toBe(true);
    }, WAIT);

    // The session asks for permission while its tab is not in front: one notification.
    writeSession({ status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(statusText()).toBe("$(telescope) $(bell-dot) 1"), WAIT);
    expect(infoMessages().filter((m) => m.includes("needs you"))).toEqual(['"Untitled session" needs you: permission prompt']);

    // It works again, then finishes unwatched: marked finished, no notification by default.
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(statusText()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1$/), WAIT);
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(statusText()).toBe("$(telescope) $(check) 1"), WAIT);
    expect(infoMessages().some((m) => m.includes("finished"))).toBe(false);

    await stub.commands.get("lookout.markAllSeen")!();
    expect(statusText()).toBe("$(telescope) 1 idle");

    child.kill();
    await vi.waitFor(() => expect(stub.ops.at(-1)).toEqual(["statusBar:lookout.sessions", "hide"]), WAIT);
  }, 90_000);
});
