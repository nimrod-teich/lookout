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
let saved: Record<string, unknown>;

function context() {
  return {
    subscriptions,
    globalStorageUri: { fsPath: path.join(configDir, "global-storage") },
    extensionUri: { fsPath: "/ext" },
    workspaceState: {
      get: (key: string, fallback: unknown) => saved[key] ?? fallback,
      update: (key: string, value: unknown) => {
        saved[key] = value;
        return Promise.resolve();
      },
    },
  } as never;
}

function writeSession(fields: Record<string, unknown>): void {
  const record = { pid: child.pid, sessionId: SESSION, cwd: "/work/app", startedAt: Date.now(), kind: "interactive", entrypoint: "claude-vscode", ...fields };
  fs.writeFileSync(path.join(configDir, "sessions", `${child.pid}.json`), JSON.stringify(record));
}

function statusText(): string | undefined {
  return stub.ops.filter(([target, action]) => target === "statusBar:lookout.status" && action === "set:text").at(-1)?.[2] as string | undefined;
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
  saved = {};
});

afterEach(() => {
  for (const subscription of subscriptions) subscription.dispose();
  child.kill();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("the extension", () => {
  it("shows a session, jumps to its panel, marks its finished turn, and drops it when it exits", async () => {
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    activate(context());
    const registry = path.join(configDir, "global-storage", "windows", `${process.pid}.json`);
    expect(JSON.parse(fs.readFileSync(registry, "utf8"))).toEqual({ pid: process.pid, label: "stub-workspace" });
    await vi.waitFor(() => expect(statusText()).toMatch(/^\$\(lookout-lighthouse\) [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1$/), WAIT);

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
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) $(bell-dot) 1"), WAIT);
    expect(infoMessages().filter((m) => m.includes("needs you"))).toEqual(['"Untitled session" needs you: permission prompt']);

    // It works again, then finishes unwatched: marked finished, no notification by default.
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(statusText()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1$/), WAIT);
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) $(check) 1"), WAIT);
    expect(infoMessages().some((m) => m.includes("finished"))).toBe(false);
    expect(saved["lookout.done"]).toEqual([SESSION]);

    // "Next session that needs you" goes to the finished one.
    stub.ops.length = 0;
    await stub.commands.get("lookout.jumpNextAttention")!();
    expect(stub.ops.some(([target, command]) => target === "commands" && command === CLAUDE_OPEN)).toBe(true);
    expect(statusText()).toBe("$(lookout-lighthouse) 1 idle");
    expect(saved["lookout.done"]).toEqual([]);

    // Finish again, then clear with the command.
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(statusText()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1$/), WAIT);
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) $(check) 1"), WAIT);
    await stub.commands.get("lookout.markAllSeen")!();
    expect(statusText()).toBe("$(lookout-lighthouse) 1 idle");

    child.kill();
    await vi.waitFor(() => expect(stub.ops.some(([target, action]) => target === "statusBar:lookout.status" && action === "hide")).toBe(true), WAIT);

    for (const subscription of subscriptions.splice(0)) subscription.dispose();
    expect(fs.existsSync(registry)).toBe(false);
  }, 90_000);

  it("shows the usage Claude Code cached", async () => {
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { five_hour: { utilization: 18 }, seven_day: { utilization: 31 } } } }),
    );
    activate(context());
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▱▱▱▱▱▱▱▱ 18%"), WAIT);
  }, 60_000);

  it("restores finished marks from the workspace state", async () => {
    saved["lookout.done"] = [SESSION];
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    activate(context());
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) $(check) 1"), WAIT);
  }, 60_000);
});
