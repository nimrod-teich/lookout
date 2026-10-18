import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JumpMailbox } from "../../src/core/jumpMailbox";
import { activate } from "../../src/extension";
import { createWebviewView, stub, TabInputWebview, workspace } from "./stub-vscode";

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

/** A conversation for the session, without a title yet: it reads "Empty tab", or "Empty session" in a terminal. */
function writeTranscript(): void {
  const dir = path.join(configDir, "projects", "-work-app");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), JSON.stringify({ type: "user", cwd: "/work/app", message: { content: "run the tests" } }) + "\n");
}

function statusText(): string | undefined {
  return stub.ops.filter(([target, action]) => target === "statusBar:lookout.status" && action === "set:text").at(-1)?.[2] as string | undefined;
}

/** A board opened for `boardStates`, once per test. */
let statesBoard: ReturnType<typeof createWebviewView> | undefined;

/** What the board shows of the sessions, by state, e.g. "working 1" or "waiting 1, done 2"; empty with none. Opens the board on first use. */
function boardStates(view?: ReturnType<typeof createWebviewView>): string {
  if (!view && !statesBoard) {
    statesBoard = createWebviewView();
    (stub.webviewProviders.get("lookout.board") as { resolveWebviewView(view: unknown): void }).resolveWebviewView(statesBoard);
  }
  const last = (view ?? statesBoard)!.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { sessions: { state: string }[] } | undefined;
  const counts = new Map<string, number>();
  for (const session of last?.sessions ?? []) counts.set(session.state, (counts.get(session.state) ?? 0) + 1);
  return ["waiting", "done", "working", "idle", "unknown"].filter((state) => counts.get(state)).map((state) => `${state} ${counts.get(state)}`).join(", ");
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
  statesBoard = undefined;
});

afterEach(() => {
  for (const subscription of subscriptions) subscription.dispose();
  child.kill();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("the extension", () => {
  it("shows a session, jumps to its panel, marks its finished turn, and drops it when it exits", async () => {
    writeTranscript();
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    activate(context());
    const registry = path.join(configDir, "global-storage", "windows", `${process.pid}.json`);
    expect(JSON.parse(fs.readFileSync(registry, "utf8"))).toEqual({ pid: process.pid, label: "stub-workspace", terminals: [] });
    await vi.waitFor(() => expect(boardStates()).toBe("working 1"), WAIT);

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
    await vi.waitFor(() => expect(boardStates()).toBe("waiting 1"), WAIT);
    // No tool call in the transcript to name: announced after two seconds' grace, with the agent's own word.
    await vi.waitFor(() => expect(infoMessages().filter((m) => m.includes("needs you"))).toEqual(['"Empty tab" needs you: Permission prompt']), WAIT);

    // It works again, then finishes unwatched: marked finished, no notification by default.
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(boardStates()).toBe("working 1"), WAIT);
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(boardStates()).toBe("done 1"), WAIT);
    expect(infoMessages().some((m) => m.includes("finished"))).toBe(false);
    expect(saved["lookout.done"]).toEqual([SESSION]);

    // "Next session that needs you" goes to the finished one.
    stub.ops.length = 0;
    await stub.commands.get("lookout.jumpNextAttention")!();
    expect(stub.ops.some(([target, command]) => target === "commands" && command === CLAUDE_OPEN)).toBe(true);
    expect(boardStates()).toBe("idle 1");
    expect(saved["lookout.done"]).toEqual([]);

    // Finish again, then clear with the command.
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(boardStates()).toBe("working 1"), WAIT);
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(boardStates()).toBe("done 1"), WAIT);
    await stub.commands.get("lookout.markAllSeen")!();
    expect(boardStates()).toBe("idle 1");

    child.kill();
    await vi.waitFor(() => expect(boardStates()).toBe(""), WAIT);

    for (const subscription of subscriptions.splice(0)) subscription.dispose();
    expect(fs.existsSync(registry)).toBe(false);
  }, 90_000);

  it("leaves an idle tab with nothing sent off the board and the status bar, and shows it once it works", async () => {
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    activate(context());
    const board = stub.webviewProviders.get("lookout.board") as { resolveWebviewView(view: unknown): void };
    const boardView = createWebviewView();
    board.resolveWebviewView(boardView);
    const sessions = () => (boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { sessions?: { id: string }[] } | undefined)?.sessions;
    await vi.waitFor(() => expect(sessions()).toEqual([]), WAIT);
    // The status bar says nothing of sessions: the lighthouse alone, with no usage cached.
    expect(statusText()).toBe("$(lookout-lighthouse)");
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(boardStates(boardView)).toBe("working 1"), WAIT);
    expect(sessions()?.map((v) => v.id)).toEqual([SESSION]);
  }, 60_000);

  it("opens the conversation of a session it cannot bring forward, and tells no one it cannot", async () => {
    writeTranscript();
    // `claude` in a terminal of no VS Code window: outside VS Code.
    writeSession({ entrypoint: "cli", status: "idle" });
    activate(context());
    const board = stub.webviewProviders.get("lookout.board") as { resolveWebviewView(view: unknown): void };
    const boardView = createWebviewView();
    board.resolveWebviewView(boardView);
    const shown = () => (boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { sessions: { id: string; host: string }[] } | undefined)?.sessions;
    await vi.waitFor(() => expect(shown()).toEqual([expect.objectContaining({ id: SESSION, host: "elsewhere" })]), WAIT);
    boardView.receive({ type: "jump", id: SESSION });
    // The tab offers no Open session: nothing here can bring it forward.
    await vi.waitFor(() => expect(stub.panels.find((panel) => panel.viewType === "lookout.findings")?.posted.at(-1)).toMatchObject({ type: "conversation", session: { id: SESSION, openable: false } }), WAIT);
    expect(infoMessages().filter((text) => text.includes("outside VS Code"))).toEqual([]);
  }, 60_000);

  it("marks a terminal session's turn finished while the user is on a tab, and keeps the mark until its terminal comes forward", async () => {
    // A shell of this window's terminals runs the session.
    const shell = spawn(process.execPath, ["-e", 'const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const sessionPid = await new Promise<number>((resolve) => shell.stdout!.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
      const terminal = stub.addTerminal("claude", shell.pid);
      const transcript = path.join(configDir, "projects", "-work-app", `${SESSION}.jsonl`);
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, JSON.stringify({ type: "user", cwd: "/work/app", message: { content: "run the tests" } }) + "\n");
      const record = (status: string) => fs.writeFileSync(path.join(configDir, "sessions", `${sessionPid}.json`), JSON.stringify({ pid: sessionPid, sessionId: SESSION, cwd: "/work/app", startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status, statusUpdatedAt: Date.now() }));
      record("idle");
      const group = stub.addClaudeGroup(["Other"]);
      stub.activate(group.tabs[0]!);
      activate(context());
      await vi.waitFor(() => expect(boardStates()).toBe("idle 1"), WAIT);

      // The user sends the prompt in its terminal, then goes to a tab while it works.
      stub.activeTerminal = terminal;
      stub.activeTerminalChange.fire(terminal);
      record("busy");
      await vi.waitFor(() => expect(boardStates()).toBe("working 1"), WAIT);
      stub.activate(group.tabs[0]!);
      group.tabs.push({ label: "Notes", input: new TabInputWebview("mainThreadWebview-markdown"), group });
      stub.activate(group.tabs[1]!);
      stub.focusChange.fire();

      // Its terminal is still VS Code's active one: the finished turn is marked all the same, and stays marked
      // through changes of tabs and window focus.
      record("idle");
      await vi.waitFor(() => expect(boardStates()).toBe("done 1"), WAIT);
      stub.focusChange.fire();
      stub.focusChange.fire();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(boardStates()).toBe("done 1");

      // Its terminal comes forward: seen.
      stub.activeTerminalChange.fire(terminal);
      await vi.waitFor(() => expect(boardStates()).toBe("idle 1"), WAIT);
      process.kill(sessionPid);
    } finally {
      shell.kill();
    }
  }, 90_000);

  it("names what a prompt asks even when the transcript lags, and announces a question typed at the end of a turn", async () => {
    const transcript = path.join(configDir, "projects", "-work-app", `${SESSION}.jsonl`);
    const append = (...entries: unknown[]) => fs.appendFileSync(transcript, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    append({ type: "user", cwd: "/work/app", message: { content: "run the tests" } });
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    activate(context());
    await vi.waitFor(() => expect(boardStates()).toBe("working 1"), WAIT);
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
    await vi.waitFor(() => expect(boardStates()).toBe("working 1"), WAIT);
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(infoMessages()).toContain('"Empty tab" asked you a question: Tests pass. Want me to open the PR?'), WAIT);
    expect(boardStates()).toBe("waiting 1");

    // Dismissed from its card: idle, and remembered for a reload.
    const board = stub.webviewProviders.get("lookout.board") as { resolveWebviewView(view: unknown): void };
    const boardView = createWebviewView();
    board.resolveWebviewView(boardView);
    boardView.receive({ type: "dismiss", id: SESSION });
    await vi.waitFor(() => expect(boardStates(boardView)).toBe("idle 1"), WAIT);
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
    await vi.waitFor(() => expect(boardStates()).toBe("working 1"), WAIT);
    await placed();

    append({ type: "assistant", cwd: "/work/app", message: { id: "m1", content: [{ type: "text", text: "Done. The changelog lists the fix." }] } });
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(infoMessages()).toContain('"Empty tab" finished.'), WAIT);

    // A turn that ends on a question is a finished turn too: announced although waiting notifications are off.
    append({ type: "user", cwd: "/work/app", message: { content: "and the release notes" } });
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(boardStates()).toBe("working 1"), WAIT);
    append({ type: "assistant", cwd: "/work/app", timestamp: "2026-10-16T11:00:00.000Z", message: { id: "m2", content: [{ type: "text", text: "Written. Want me to open the PR?" }] } });
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(infoMessages()).toContain('"Empty tab" asked you a question: Written. Want me to open the PR?'), WAIT);
    expect(infoMessages().filter((m) => m.endsWith("finished."))).toHaveLength(1);
    expect(boardStates()).toBe("waiting 1");

    // Typed questions off: the same turn is simply finished.
    stub.config["lookout.state.typedQuestions"] = false;
    stub.configChange.fire({ affectsConfiguration: () => true });
    await vi.waitFor(() => expect(boardStates()).toBe("done 1"), WAIT);
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
      await vi.waitFor(() => expect(runs()).toBe(1), WAIT);
      expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▰▱▱▱▱▱▱▱ 30%");
      // Asked again within three minutes: nothing runs, and nothing is said.
      const said = infoMessages().length;
      await stub.commands.get("lookout.refreshUsage")!();
      expect(infoMessages()).toHaveLength(said);
      expect(runs()).toBe(1);
      expect(tooltip()).not.toContain("failed");
    }, 60_000);

    it("starts no refresh while Claude Code's settings switch nonessential traffic off, and notices when they no longer do", async () => {
      const runs = fakeClaude(true);
      const settings = path.join(configDir, "settings.json");
      fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }));
      const utilization = { five_hour: { utilization: 30 } };
      fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now() - 11 * 60_000, utilization } }));
      activate(context());
      await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▰▱▱▱▱▱▱▱ 30%"), WAIT);
      await stub.commands.get("lookout.refreshUsage")!();
      expect(infoMessages().at(-1)).toBe("Lookout can't fetch usage: refresh disabled by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.");
      expect(runs()).toBe(0);
      fs.writeFileSync(settings, JSON.stringify({ env: {} }));
      await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▰▰▱▱▱▱▱▱ 44%"), WAIT);
      expect(runs()).toBe(1);
    }, 60_000);
  });

  it("answers another window's jump: brings the session forward, comes to the front, and says so", async () => {
    writeTranscript();
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
      writeTranscript();
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

  describe("earlier sessions", () => {
    const HERE = "00000000-0000-4000-8000-0000000000b1";
    const ELSEWHERE = "00000000-0000-4000-8000-0000000000b2";

    function writePast(cwd: string, id: string, branch: string, text: string): void {
      const dir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: "user", cwd, gitBranch: branch, timestamp: new Date().toISOString(), message: { content: text } }) + "\n");
    }

    function openBoard() {
      const board = stub.webviewProviders.get("lookout.board") as { resolveWebviewView(view: unknown): void };
      const boardView = createWebviewView();
      board.resolveWebviewView(boardView);
      const listed = () => boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { past: { id: string; branch?: string; resumable?: boolean }[]; earlier?: { scope: string } } | undefined;
      return { boardView, listed };
    }

    beforeEach(() => {
      workspace.workspaceFolders = [{ uri: { fsPath: "/work/app" } }];
      writePast("/work/app", HERE, "main", "tune the deploy script");
      writePast("/work/other", ELSEWHERE, "fix-x", "deploy the other service");
    });

    afterEach(() => {
      workspace.workspaceFolders = undefined;
    });

    it("lists this window's folders, then every project once asked, keeps the choice, and searches what it lists", async () => {
      activate(context());
      const { boardView, listed } = openBoard();
      await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
      expect(listed()?.earlier).toEqual({ scope: "folders", limit: 500, capped: false });
      boardView.receive({ type: "search", query: "deploy" });
      expect(boardView.posted.at(-1)).toMatchObject({ type: "search", query: "deploy", results: [{ id: HERE, count: 1 }] });

      boardView.receive({ type: "earlierScope", scope: "all" });
      expect(saved["lookout.earlierScope"]).toBe("all");
      await vi.waitFor(() => expect(listed()?.earlier?.scope).toBe("all"), WAIT);
      expect(listed()?.past.map((p) => [p.id, p.branch, p.resumable]).sort()).toEqual([
        [HERE, "main", true],
        [ELSEWHERE, "fix-x", false],
      ]);
      boardView.receive({ type: "search", query: "deploy branch:fix" });
      expect(boardView.posted.at(-1)).toMatchObject({ type: "search", results: [{ id: ELSEWHERE, count: 1 }] });

      // The agent resumes only the sessions of this window's folders; another project's is not opened as an empty tab.
      stub.commands.set(CLAUDE_OPEN, () => undefined);
      const opened = (id: string) => stub.ops.some(([target, command, args]) => target === "commands" && command === CLAUDE_OPEN && (args as unknown[])[0] === id);
      boardView.receive({ type: "resume", id: ELSEWHERE });
      await vi.waitFor(() => expect(infoMessages()).toContain(`"deploy the other service" is from /work/other, not one of this window's folders: the agent resumes it from a window open on that folder.`), WAIT);
      boardView.receive({ type: "resume", id: HERE });
      await vi.waitFor(() => expect(opened(HERE)).toBe(true), WAIT);
      expect(opened(ELSEWHERE)).toBe(false);

      // Its conversation's Open session says the same, also once the scope no longer lists it.
      const refusal = `"deploy the other service" is from /work/other, not one of this window's folders: the agent resumes it from a window open on that folder.`;
      const refusals = () => infoMessages().filter((text) => text === refusal).length;
      boardView.receive({ type: "openHit", query: "", id: ELSEWHERE });
      const panel = stub.panels.at(-1)!;
      panel.receive({ type: "jump", id: ELSEWHERE });
      await vi.waitFor(() => expect(refusals()).toBe(2), WAIT);
      boardView.receive({ type: "earlierScope", scope: "folders" });
      await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
      panel.receive({ type: "jump", id: ELSEWHERE });
      await vi.waitFor(() => expect(refusals()).toBe(3), WAIT);
      expect(opened(ELSEWHERE)).toBe(false);
    }, 60_000);

    it("searches every conversation on the search page, and opens a match in the conversation tab", async () => {
      activate(context());
      const { listed } = openBoard();
      await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
      await stub.commands.get("lookout.search")!();
      const page = stub.panels.find((panel) => panel.viewType === "lookout.search")!;
      expect(page.posted.at(-1)).toEqual({ type: "query", query: "" });
      page.receive({ type: "search", query: "deploy", zone: new Date().getTimezoneOffset() });
      expect(page.posted.at(-1)).toMatchObject({ type: "results", query: "deploy", pending: 0, sessions: [{ id: HERE, title: "tune the deploy script", live: false, count: 1, hits: [{ index: 0, role: "you", snippet: "tune the deploy script" }] }] });
      page.receive({ type: "open", query: "deploy", id: HERE, index: 0 });
      const tab = stub.panels.find((panel) => panel.viewType === "lookout.findings")!;
      expect(tab.posted.at(-1)).toMatchObject({ type: "conversation", session: { id: HERE }, query: "deploy", target: 0 });
    }, 60_000);

    it("stars a session from the board, keeps the star for every window, and lists a starred session from another project", async () => {
      activate(context());
      const { boardView, listed } = openBoard();
      await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
      const favourites = () => (boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { favourites?: { ids: string[]; past: { id: string; resumable: boolean }[] } } | undefined)?.favourites;
      expect(favourites()).toEqual({ ids: [], past: [] });
      boardView.receive({ type: "favourite", id: HERE });
      await vi.waitFor(() => expect(favourites()?.ids).toEqual([HERE]), WAIT);
      expect(savedGlobal["lookout.favourites"]).toEqual([HERE]);
      // Starred in another window: listed here though this window's folders do not hold it.
      savedGlobal["lookout.favourites"] = [ELSEWHERE, HERE];
      boardView.receive({ type: "favourite", id: HERE });
      await vi.waitFor(() => expect(favourites()?.ids).toEqual([ELSEWHERE]), WAIT);
      expect(favourites()?.past.map((p) => [p.id, p.resumable])).toEqual([[ELSEWHERE, false]]);
      expect(listed()?.past.map((p) => p.id)).toEqual([HERE]);
      // Its conversation can be read.
      boardView.receive({ type: "openHit", query: "", id: ELSEWHERE });
      expect(stub.panels.find((panel) => panel.viewType === "lookout.findings")?.posted.at(-1)).toMatchObject({ type: "conversation", session: { id: ELSEWHERE } });
    }, 60_000);

    it("archives an earlier session from the board, takes its star away, lists it under Archived in every window, and brings it back", async () => {
      savedGlobal["lookout.favourites"] = [HERE];
      activate(context());
      const { boardView, listed } = openBoard();
      await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
      const archive = () => (boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { archive?: { id: string; resumable: boolean }[] } | undefined)?.archive;
      expect(archive()).toEqual([]);
      boardView.receive({ type: "archive", id: HERE });
      await vi.waitFor(() => expect(archive()?.map((p) => p.id)).toEqual([HERE]), WAIT);
      expect(listed()?.past).toEqual([]);
      expect(savedGlobal["lookout.archive"]).toEqual([HERE]);
      expect(savedGlobal["lookout.favourites"]).toEqual([]);
      // Archived in another window: listed here though this window's folders do not hold it. HERE comes back to Earlier.
      savedGlobal["lookout.archive"] = [ELSEWHERE, HERE];
      boardView.receive({ type: "archive", id: HERE });
      await vi.waitFor(() => expect(archive()?.map((p) => [p.id, p.resumable])).toEqual([[ELSEWHERE, false]]), WAIT);
      expect(listed()?.past.map((p) => p.id)).toEqual([HERE]);
      // A search finds it.
      boardView.receive({ type: "search", query: "other service", zone: 0 });
      const found = boardView.posted.filter((m) => (m as { type: string }).type === "search").at(-1) as { results: { id: string }[] };
      expect(found.results.map((r) => r.id)).toEqual([ELSEWHERE]);
      // Its conversation can be read.
      boardView.receive({ type: "openHit", query: "", id: ELSEWHERE });
      expect(stub.panels.find((panel) => panel.viewType === "lookout.findings")?.posted.at(-1)).toMatchObject({ type: "conversation", session: { id: ELSEWHERE } });
    }, 60_000);

    it("takes a session out of the archive once it runs again", async () => {
      savedGlobal["lookout.archive"] = [ELSEWHERE, HERE];
      writeSession({ sessionId: HERE });
      activate(context());
      const { boardView } = openBoard();
      await vi.waitFor(() => expect(savedGlobal["lookout.archive"]).toEqual([ELSEWHERE]), WAIT);
      const last = () => boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { sessions: { id: string }[]; archive?: { id: string }[] } | undefined;
      await vi.waitFor(() => expect(last()?.sessions.map((s) => s.id)).toContain(HERE), WAIT);
      expect(last()?.archive?.map((p) => p.id)).toEqual([ELSEWHERE]);
    }, 60_000);

    it("keeps a session whose tab the agent restored after a reload on the board, idle until the tab is opened", async () => {
      stub.addClaudeGroup(["tune the deploy script", "deploy the other service"]);
      activate(context());
      const { boardView, listed } = openBoard();
      const sessions = () => (boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { sessions?: { id: string; state: string; restored?: boolean }[] } | undefined)?.sessions;
      await vi.waitFor(() => expect(sessions()?.map((v) => [v.id, v.state, v.restored])).toEqual([[HERE, "idle", true]]), WAIT);
      // Not listed under Earlier as well; another project's tab opens blank, so it is not shown.
      expect(listed()?.past).toEqual([]);
      // The status bar says nothing of it.
      expect(statusText()).toBe("$(lookout-lighthouse)");
      // A click opens its tab, which starts it.
      stub.commands.set(CLAUDE_OPEN, () => undefined);
      boardView.receive({ type: "jump", id: HERE });
      await vi.waitFor(() => expect(stub.ops.some(([target, command, args]) => target === "commands" && command === CLAUDE_OPEN && (args as unknown[])[0] === HERE)).toBe(true), WAIT);
    }, 60_000);

    it("lists a long history in quick slices, not one slice per poll", async () => {
      for (let i = 0; i < 130; i++) writePast("/work/app", `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`, "main", `task ${i}`);
      activate(context());
      const { listed } = openBoard();
      await vi.waitFor(() => expect(listed()?.past.length).toBeGreaterThanOrEqual(120), WAIT);
      // The window's folder is watched, so the next poll would be five seconds away.
      await vi.waitFor(() => expect(listed()?.past.length).toBe(131), { timeout: 3_000, interval: 50 });
    }, 60_000);

    it("starts with every project after a reload when that was the choice", async () => {
      saved["lookout.earlierScope"] = "all";
      activate(context());
      const { listed } = openBoard();
      await vi.waitFor(() => expect(listed()?.past.map((p) => p.id).sort()).toEqual([HERE, ELSEWHERE]), WAIT);
      expect(listed()?.earlier?.scope).toBe("all");
    }, 60_000);
  });

  it("restores finished marks from the workspace state", async () => {
    saved["lookout.done"] = [SESSION];
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    activate(context());
    await vi.waitFor(() => expect(boardStates()).toBe("done 1"), WAIT);
  }, 60_000);
});
