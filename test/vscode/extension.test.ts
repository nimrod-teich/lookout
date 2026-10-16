import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JumpMailbox } from "../../src/core/jumpMailbox";
import { scopeOf } from "../../src/core/usageAlerts";
import { activate } from "../../src/extension";
import { createWebviewView, stub } from "./stub-vscode";

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
let savedGlobal: Record<string, unknown>;

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
    globalState: {
      get: (key: string, fallback: unknown) => savedGlobal[key] ?? fallback,
      update: (key: string, value: unknown) => {
        savedGlobal[key] = value;
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

/**
 * Waits until the session is placed in this window's panel: on platforms that
 * list processes in the background, that takes until the list arrives.
 */
async function placed(): Promise<void> {
  stub.commands.set(CLAUDE_OPEN, () => undefined);
  stub.quickPick = (items) => items[0];
  await vi.waitFor(async () => {
    await stub.commands.get("lookout.jump")!();
    expect(stub.ops.some(([target, command, args]) => target === "commands" && command === CLAUDE_OPEN && (args as unknown[])[0] === SESSION)).toBe(true);
  }, WAIT);
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
  savedGlobal = {};
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
    expect(JSON.parse(fs.readFileSync(registry, "utf8"))).toEqual({ pid: process.pid, label: "stub-workspace", terminals: [] });
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
    // No tool call in the transcript to name: announced after two seconds' grace, with the agent's own word.
    await vi.waitFor(() => expect(infoMessages().filter((m) => m.includes("needs you"))).toEqual(['"Empty tab" needs you: Permission prompt']), WAIT);

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

  it("names what a prompt asks even when the transcript lags, and announces a question typed at the end of a turn", async () => {
    const transcript = path.join(configDir, "projects", "-work-app", `${SESSION}.jsonl`);
    const append = (...entries: unknown[]) => fs.appendFileSync(transcript, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    append({ type: "user", cwd: "/work/app", message: { content: "run the tests" } });
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    activate(context());
    await vi.waitFor(() => expect(statusText()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1$/), WAIT);
    await placed();

    // Claude Code records the wait first; the tool call reaches the transcript a moment later.
    writeSession({ status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: Date.now() });
    setTimeout(() => append({ type: "assistant", cwd: "/work/app", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }), 300);
    await vi.waitFor(() => expect(infoMessages().filter((m) => m.includes("needs you"))).toEqual(['"Empty tab" needs you: Permission · Bash: npm test']), WAIT);

    // Allowed; the turn ends on a question.
    append(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "assistant", cwd: "/work/app", timestamp: "2026-10-16T10:00:00.000Z", message: { id: "m2", content: [{ type: "text", text: "Tests pass. Want me to open the PR?" }] } },
    );
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(statusText()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1$/), WAIT);
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(infoMessages()).toContain('"Empty tab" asked you a question: Tests pass. Want me to open the PR?'), WAIT);
    expect(statusText()).toBe("$(lookout-lighthouse) $(bell-dot) 1");

    // Dismissed from its card: idle, and remembered for a reload.
    const board = stub.webviewProviders.get("lookout.board") as { resolveWebviewView(view: unknown): void };
    const boardView = createWebviewView();
    board.resolveWebviewView(boardView);
    boardView.receive({ type: "dismiss", id: SESSION });
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) 1 idle"), WAIT);
    expect(saved["lookout.dismissed"]).toEqual({ [SESSION]: String(Date.parse("2026-10-16T10:00:00.000Z")) });
  }, 90_000);

  it("announces a finished turn after its grace, a question under the finished setting, and follows a change of setting", async () => {
    stub.config["lookout.notifications.waiting"] = false;
    stub.config["lookout.notifications.done"] = true;
    const transcript = path.join(configDir, "projects", "-work-app", `${SESSION}.jsonl`);
    const append = (...entries: unknown[]) => fs.appendFileSync(transcript, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    append({ type: "user", cwd: "/work/app", message: { content: "update the changelog" } });
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    activate(context());
    await vi.waitFor(() => expect(statusText()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1$/), WAIT);
    await placed();

    append({ type: "assistant", cwd: "/work/app", message: { id: "m1", content: [{ type: "text", text: "Done. The changelog lists the fix." }] } });
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(infoMessages()).toContain('"Empty tab" finished.'), WAIT);

    // A turn that ends on a question is a finished turn too: announced although waiting notifications are off.
    append({ type: "user", cwd: "/work/app", message: { content: "and the release notes" } });
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(statusText()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1$/), WAIT);
    append({ type: "assistant", cwd: "/work/app", timestamp: "2026-10-16T11:00:00.000Z", message: { id: "m2", content: [{ type: "text", text: "Written. Want me to open the PR?" }] } });
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(infoMessages()).toContain('"Empty tab" asked you a question: Written. Want me to open the PR?'), WAIT);
    expect(infoMessages().filter((m) => m.endsWith("finished."))).toHaveLength(1);
    expect(statusText()).toBe("$(lookout-lighthouse) $(bell-dot) 1");

    // Typed questions off: the same turn is simply finished.
    stub.config["lookout.state.typedQuestions"] = false;
    stub.configChange.fire({ affectsConfiguration: () => true });
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) $(check) 1"), WAIT);
  }, 90_000);

  it("shows the usage Claude Code cached", async () => {
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { five_hour: { utilization: 18 }, seven_day: { utilization: 31 } } } }),
    );
    activate(context());
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▱▱▱▱▱▱▱▱ 18%"), WAIT);
  }, 60_000);

  it("announces each usage threshold once per window, though every fetch reports the reset a fraction of a second apart", async () => {
    const resets = Date.now() + 2 * 3_600_000;
    const write = (percent: number, fraction: string) => {
      const resetsAt = new Date(resets).toISOString().replace(/\.\d+Z$/, `.${fraction}+00:00`);
      const utilization = { five_hour: { utilization: percent, resets_at: resetsAt }, seven_day: { utilization: 31 } };
      fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization } }));
    };
    const warnings = () => stub.ops.filter(([target, action]) => target === "window" && action === "warning").map(([, , text]) => String(text));
    write(72, "200799");
    activate(context());
    await vi.waitFor(() => expect(warnings()).toEqual([expect.stringMatching(/^Lookout: Your 5-hour limit is at 72%; it resets at (\w{3} )?\d\d:\d\d\.$/)]), WAIT);
    write(75, "731412");
    await vi.waitFor(() => expect(statusText()).toMatch(/ 75% · (1h59m|2h00m)$/), WAIT);
    expect(warnings()).toHaveLength(1);
    write(91, "112233");
    await vi.waitFor(() => expect(warnings()).toHaveLength(2), WAIT);
    expect(warnings()[1]).toMatch(/^Lookout: Your 5-hour limit is at 91%/);
  }, 60_000);

  it("leaves a usage alert for a moment to a window in front, then announces it itself", async () => {
    stub.focused = false;
    // Only the window's own warning: no desktop notification from a test.
    stub.config["lookout.notifications.os"] = false;
    const utilization = { five_hour: { utilization: 72, resets_at: new Date(Date.now() + 3_600_000).toISOString() } };
    fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization } }));
    const warnings = () => stub.ops.filter(([target, action]) => target === "window" && action === "warning");
    const started = Date.now();
    activate(context());
    await vi.waitFor(() => expect(statusText()).toMatch(/ 72% · /), WAIT);
    expect(warnings()).toEqual([]);
    await vi.waitFor(() => expect(warnings()).toHaveLength(1), WAIT);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
  }, 60_000);

  it("greys the usage out once it turns stale with refresh off, with no new reading", async () => {
    stub.config["lookout.usage.refresh"] = "off";
    const utilization = { five_hour: { utilization: 18 } };
    fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now() - 30 * 60_000 + 2_000, utilization } }));
    const color = () => (stub.ops.filter(([target, action]) => target === "statusBar:lookout.status" && action === "set:color").at(-1)?.[2] as { id: string } | undefined)?.id;
    activate(context());
    await vi.waitFor(() => expect(color()).toBe("charts.green"), WAIT);
    await vi.waitFor(() => expect(color()).toBe("disabledForeground"), WAIT);
  }, 60_000);

  it("forecasts from the readings it kept, and not from numbers too old to go by", async () => {
    stub.config["lookout.usage.refresh"] = "off";
    const resetsAt = Date.now() + 3 * 3_600_000;
    const write = (ageMinutes: number) =>
      fs.writeFileSync(
        path.join(configDir, ".claude.json"),
        JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now() - ageMinutes * 60_000, utilization: { five_hour: { utilization: 30, resets_at: new Date(resetsAt).toISOString() } } } }),
      );
    const tooltip = () => (stub.ops.filter(([target, action]) => target === "statusBar:lookout.status" && action === "set:tooltip").at(-1)?.[2] as { value: string } | undefined)?.value ?? "";
    // 10% fifty minutes ago, 30% now: 40 points an hour runs out before the reset in three hours.
    // Readings are kept per source of numbers: this config directory's cache.
    const readings = () => ({ [scopeOf(path.join(configDir, ".claude.json"))]: { session: { resetsAt, samples: [{ at: Date.now() - 50 * 60_000, percent: 10 }] } } });
    savedGlobal["lookout.usageReadings"] = readings();
    write(20);
    activate(context());
    await vi.waitFor(() => expect(tooltip()).toMatch(/5h: 30% · resets in 3h 00m · at this pace 100% at (\w{3} )?\d\d:\d\d, resets (\w{3} )?\d\d:\d\d/), WAIT);
    expect(Object.values(savedGlobal["lookout.usageReadings"] as Record<string, Record<string, { samples: unknown[] }>>)[0]!.session!.samples).toHaveLength(2);
    for (const subscription of subscriptions.splice(0)) subscription.dispose();

    // The same readings, but the numbers are 31 minutes old and nothing refreshes them.
    stub.reset();
    stub.config["lookout.claudeConfigDir"] = configDir;
    stub.config["lookout.usage.refresh"] = "off";
    savedGlobal["lookout.usageReadings"] = readings();
    write(31);
    activate(context());
    await vi.waitFor(() => expect(tooltip()).toContain("stale"), WAIT);
    expect(tooltip()).not.toContain("at this pace");
  }, 60_000);

  describe.skipIf(process.platform === "win32")("with a Claude Code binary to refresh usage", () => {
    /**
     * A stand-in for the binary the Claude Code extension ships: it answers
     * get_usage with 18%, counts its runs, and, when told to, rewrites the
     * cache in the config directory it was given with 44%.
     */
    function fakeClaude(rewritesCache: boolean): () => number {
      const ext = path.join(configDir, "claude-ext");
      const dir = path.join(ext, "resources", "native-binaries", `${process.platform}-${process.arch}`);
      fs.mkdirSync(dir, { recursive: true });
      const runs = path.join(configDir, "runs");
      const script = path.join(configDir, "fake-claude.js");
      fs.writeFileSync(
        script,
        `const fs = require("fs"), path = require("path");
        fs.appendFileSync(${JSON.stringify(runs)}, "x");
        process.stdin.resume();
        process.stdin.on("end", () => {
          if (${rewritesCache}) {
            const utilization = { five_hour: { utilization: 44 }, seven_day: { utilization: 31 } };
            fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization } }));
          }
          const answer = { type: "control_response", response: { subtype: "success", request_id: "lookout-usage", response: { rate_limits: { five_hour: { utilization: 18 } } } } };
          process.stdout.write(JSON.stringify(answer) + "\\n");
          process.exit(0);
        });`,
      );
      fs.writeFileSync(path.join(dir, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
      stub.extension = { extensionPath: ext };
      return () => (fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").length : 0);
    }
    const tooltip = () => (stub.ops.filter(([target, action]) => target === "statusBar:lookout.status" && action === "set:tooltip").at(-1)?.[2] as { value: string } | undefined)?.value ?? "";

    it("fetches into the cache of the config directory it reads, and shows the numbers from that cache", async () => {
      const runs = fakeClaude(true);
      activate(context());
      // No numbers yet: the automatic refresh runs at once; 44% is the cache, 18% only the answer.
      await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▰▰▱▱▱▱▱▱ 44%"), WAIT);
      expect(runs()).toBe(1);
    }, 60_000);

    it("counts a refresh that leaves the cache as it was as failed, and lets the next one wait", async () => {
      const runs = fakeClaude(false);
      const utilization = { five_hour: { utilization: 30 } };
      fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now() - 11 * 60_000, utilization } }));
      activate(context());
      await vi.waitFor(() => expect(tooltip()).toMatch(/Usage the last refresh failed; trying again at \d\d:\d\d/), WAIT);
      expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▰▱▱▱▱▱▱▱ 30%");
      await stub.commands.get("lookout.refreshUsage")!();
      expect(infoMessages().at(-1)).toMatch(/^Lookout fetches usage at most every 3 minutes on this machine; next at \d\d:\d\d\.$/);
      expect(runs()).toBe(1);
    }, 60_000);

    it("starts no refresh while Claude Code's settings switch nonessential traffic off, and notices when they no longer do", async () => {
      const runs = fakeClaude(true);
      const settings = path.join(configDir, "settings.json");
      fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }));
      const utilization = { five_hour: { utilization: 30 } };
      fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now() - 11 * 60_000, utilization } }));
      activate(context());
      await vi.waitFor(() => expect(tooltip()).toContain("Usage refresh disabled by CLAUDE\\_CODE\\_DISABLE\\_NONESSENTIAL\\_TRAFFIC"), WAIT);
      expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▰▱▱▱▱▱▱▱ 30%");
      expect(runs()).toBe(0);
      fs.writeFileSync(settings, JSON.stringify({ env: {} }));
      await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▰▰▱▱▱▱▱▱ 44%"), WAIT);
      expect(runs()).toBe(1);
    }, 60_000);
  });

  it("answers another window's jump: brings the session forward, comes to the front, and says so", async () => {
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    activate(context());
    await placed();
    stub.focused = false;
    stub.commands.set("workbench.action.focusWindow", () => {
      stub.focused = true;
      stub.focusChange.fire();
    });
    stub.ops.length = 0;
    const windows = path.join(configDir, "global-storage", "windows");
    const mail = new JumpMailbox(windows);
    mail.send(process.pid, { sessionId: SESSION, fromPid: 4242 }, Date.now());
    let answer: unknown;
    await vi.waitFor(() => {
      answer ??= mail.takeReplies(4242, Date.now())[0];
      expect(answer).toMatchObject({ sessionId: SESSION, fromPid: process.pid, found: true, raised: true });
    }, WAIT);
    expect(stub.ops.some(([target, command, args]) => target === "commands" && command === CLAUDE_OPEN && (args as unknown[])[0] === SESSION)).toBe(true);
    expect(stub.ops.some(([target, command]) => target === "commands" && command === "workbench.action.focusWindow")).toBe(true);
  }, 60_000);

  it("jumps to a session in another window's terminal through that window, and says when it could not come forward", async () => {
    // The other window: the test runner's parent stands in for its extension host, and a "shell" of
    // its terminals runs the session. It publishes that shell, so this window can place the session.
    const other = process.ppid;
    const shell = spawn(process.execPath, ["-e", 'const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const sessionPid = await new Promise<number>((resolve) => shell.stdout!.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
      const windows = path.join(configDir, "global-storage", "windows");
      fs.mkdirSync(windows, { recursive: true });
      fs.writeFileSync(path.join(windows, `${other}.json`), JSON.stringify({ pid: other, label: "api", terminals: [shell.pid] }));
      const record = { pid: sessionPid, sessionId: SESSION, cwd: "/work/app", startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status: "idle", statusUpdatedAt: Date.now() };
      fs.writeFileSync(path.join(configDir, "sessions", `${sessionPid}.json`), JSON.stringify(record));
      activate(context());
      const mail = new JumpMailbox(windows);
      // The other window answers: shown, but it could not come to the front.
      const answering = setInterval(() => {
        for (const request of mail.takeRequests(other, Date.now())) mail.reply(request.fromPid, { sessionId: request.sessionId, fromPid: other, found: true, raised: false }, Date.now());
      }, 50);
      try {
        // What the jump list offered, for the report when the session is not where it should be.
        let offered: unknown;
        stub.quickPick = (items) => {
          offered = (items as { label: string; description?: string; detail?: string }[]).map(({ label, description, detail }) => ({ label, description, detail }));
          return items[0];
        };
        await vi.waitFor(async () => {
          await stub.commands.get("lookout.jump")!();
          // The key that switches between one application's windows: ⌘` on a Mac.
          const key = process.platform === "darwin" ? "⌘`" : "Alt+Tab";
          expect({ offered, said: infoMessages().at(-1) }).toMatchObject({ said: `Opened "Empty session" in window "api"; switch with ${key}.` });
        }, WAIT);
      } finally {
        clearInterval(answering);
        process.kill(sessionPid);
      }
    } finally {
      shell.kill();
    }
  }, 60_000);

  it("restores finished marks from the workspace state", async () => {
    saved["lookout.done"] = [SESSION];
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    activate(context());
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) $(check) 1"), WAIT);
  }, 60_000);
});
