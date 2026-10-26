import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remoteSettingsFile } from "../../src/core/agents/claude/retention";
import { JumpMailbox } from "../../src/core/jumpMailbox";
import { NOTE_MAX, SessionRecords } from "../../src/core/sessionRecords";
import { loadSqlite } from "../../src/core/sqlite";
import { activate } from "../../src/extension";
import { buildReader } from "../readerBundle";
import { settle } from "./helpers";
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

/** The extension's context; `extension`: where it is installed, by default a folder without the reading thread's bundle. */
function context(extension = "/ext") {
  return {
    subscriptions,
    globalStorageUri: { fsPath: path.join(configDir, "global-storage") },
    extensionUri: { fsPath: extension },
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

/**
 * Waits until the board places the session in one of this window's terminals:
 * on platforms that list processes in the background, that takes until the
 * list arrives, and a turn that ends before then leaves no finished mark.
 */
async function placedInTerminal(): Promise<void> {
  boardStates();
  await vi.waitFor(() => {
    const last = statesBoard!.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { sessions: { host: string }[] } | undefined;
    expect(last?.sessions.map((session) => session.host)).toEqual(["terminal"]);
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
  // A reading thread may still be letting go of the store's file: Windows refuses the removal until it has, so it is tried again for a moment.
  fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      await placedInTerminal();

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

  it("turns Claude Code off and on again from its setting: its sessions and usage leave and come back, and nothing runs to refresh them", async () => {
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization: { five_hour: { utilization: 18 }, seven_day: { utilization: 31 } } } }),
    );
    writeTranscript();
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    activate(context());
    await vi.waitFor(() => expect(boardStates()).toBe("working 1"), WAIT);
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▱▱▱▱▱▱▱▱ 18%"), WAIT);

    stub.config["lookout.agents.claude"] = false;
    stub.configChange.fire({ affectsConfiguration: () => true });
    await vi.waitFor(() => expect(boardStates()).toBe(""), WAIT);
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse)"), WAIT);
    await stub.commands.get("lookout.refreshUsage")!();
    expect(infoMessages().at(-1)).toBe("Lookout can't fetch usage: Claude Code is turned off (lookout.agents.claude).");

    stub.config["lookout.agents.claude"] = true;
    stub.configChange.fire({ affectsConfiguration: () => true });
    await vi.waitFor(() => expect(boardStates()).toBe("working 1"), WAIT);
    await vi.waitFor(() => expect(statusText()).toBe("$(lookout-lighthouse) ▰▰▱▱▱▱▱▱▱▱ 18%"), WAIT);
  }, 90_000);

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
     * get_usage with 18% (or `payload`), counts its runs, writes `debugLog`
     * to the debug log it is given, and, when told to, rewrites the cache in
     * the config directory it was given with 44%.
     */
    function fakeClaude(rewritesCache: boolean, { debugLog = "", payload = { rate_limits: { five_hour: { utilization: 18 } } } }: { debugLog?: string; payload?: object } = {}): () => number {
      const ext = path.join(configDir, "claude-ext");
      const dir = path.join(ext, "resources", "native-binaries", `${process.platform}-${process.arch}`);
      fs.mkdirSync(dir, { recursive: true });
      const runs = path.join(configDir, "runs");
      const script = path.join(configDir, "fake-claude.js");
      fs.writeFileSync(
        script,
        `const fs = require("fs"), path = require("path");
        fs.appendFileSync(${JSON.stringify(runs)}, "x");
        const debugFile = process.argv[process.argv.indexOf("--debug-file") + 1];
        if (process.argv.includes("--debug-file")) fs.writeFileSync(debugFile, ${JSON.stringify(debugLog)});
        process.stdin.resume();
        process.stdin.on("end", () => {
          if (${rewritesCache}) {
            const utilization = { five_hour: { utilization: 44 }, seven_day: { utilization: 31 } };
            fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now(), utilization } }));
          }
          const answer = { type: "control_response", response: { subtype: "success", request_id: "lookout-usage", response: ${JSON.stringify(payload)} } };
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

    it("waits as long as the usage endpoint's 429 asks, the user's refresh too, and says why there are no numbers", async () => {
      const runs = fakeClaude(false, {
        debugLog: "t [DEBUG] fetchUtilization: 429 remembered for this bearer; not asking again for 900s\n",
        payload: { subscription_type: "max", rate_limits_available: true, rate_limits: null },
      });
      activate(context());
      // No numbers: the automatic refresh runs at once, and meets the 429.
      await vi.waitFor(() => expect(tooltip()).toContain("Too many usage checks; next at "), WAIT);
      expect(runs()).toBe(1);
      // Every window on the host sees the hold: it is on file with the refreshes.
      const ledger = path.join(configDir, "global-storage", "usage", "refresh");
      const holdFile = fs.readdirSync(ledger).find((name) => name.startsWith("hold-"))!;
      const wait = Number(fs.readFileSync(path.join(ledger, holdFile), "utf8")) - Date.now();
      expect(wait).toBeGreaterThan(890_000);
      expect(wait).toBeLessThanOrEqual(900_000);
      await stub.commands.get("lookout.refreshUsage")!();
      expect(infoMessages().at(-1)).toMatch(/^Lookout: Anthropic's usage endpoint asked for no more checks before (\w{3} )?\d\d:\d\d\.$/);
      expect(runs()).toBe(1);
    }, 60_000);

    it("says when plan limits do not apply to Claude Code's sign-in", async () => {
      const runs = fakeClaude(false, { payload: { subscription_type: null, rate_limits_available: false, rate_limits: null } });
      activate(context());
      // The hover is Markdown, with the text's hyphen escaped.
      await vi.waitFor(() => expect(tooltip().replace(/\\/g, "")).toContain("No plan limits for this sign-in"), WAIT);
      expect(runs()).toBe(1);
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

  describe("Claude Code's retention of transcripts", () => {
    const settings = () => path.join(configDir, "settings.json");
    const warnings = () => stub.ops.filter(([target, action]) => target === "window" && action === "warning").map(([, , text]) => String(text));
    const changed = () => stub.configChange.fire({ affectsConfiguration: (section: string) => section === "lookout" || section === "lookout.retention.days" });

    it("leaves Claude Code's settings alone while the setting is 0", async () => {
      writeTranscript();
      activate(context());
      await settle();
      expect(fs.existsSync(settings())).toBe(false);
      expect(infoMessages()).toEqual([]);
      expect(warnings()).toEqual([]);
    }, 60_000);

    it("writes the setting's days into Claude Code's user settings file, every other key kept and a copy beside it, and again only when the setting changes", async () => {
      stub.config["lookout.retention.days"] = 3650;
      fs.writeFileSync(settings(), JSON.stringify({ model: "opus" }));
      activate(context());
      await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(settings(), "utf8"))).toEqual({ model: "opus", cleanupPeriodDays: 3650 }), WAIT);
      expect(fs.readdirSync(configDir).filter((name) => name.startsWith("settings.json.") && name.endsWith(".before-lookout"))).toHaveLength(1);
      expect(infoMessages().at(-1)).toMatch(/wrote cleanupPeriodDays 3650 into .*settings\.json, with the file as it was at .*\. Claude Code keeps transcripts 3650 days from its next start\./);
      const told = infoMessages().length;
      // The same value again, on any settings change: nothing more.
      changed();
      await settle();
      expect(infoMessages()).toHaveLength(told);
      // Another value: written.
      stub.config["lookout.retention.days"] = 90;
      changed();
      await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(settings(), "utf8"))).toEqual({ model: "opus", cleanupPeriodDays: 90 }), WAIT);
      expect(infoMessages()).toHaveLength(told + 1);
      // Back to 0: the file is left as it is.
      stub.config["lookout.retention.days"] = 0;
      changed();
      await settle();
      expect(JSON.parse(fs.readFileSync(settings(), "utf8"))).toEqual({ model: "opus", cleanupPeriodDays: 90 });
      expect(infoMessages()).toHaveLength(told + 1);
    }, 60_000);

    it("creates the file when there is none, and says when a folder's file sets its own", async () => {
      const folder = path.join(configDir, "proj");
      fs.mkdirSync(path.join(folder, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(folder, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 7 }));
      workspace.workspaceFolders = [{ uri: { fsPath: folder } }];
      try {
        stub.config["lookout.retention.days"] = 365;
        activate(context());
        await vi.waitFor(() => expect(fs.existsSync(settings())).toBe(true), WAIT);
        expect(JSON.parse(fs.readFileSync(settings(), "utf8"))).toEqual({ cleanupPeriodDays: 365 });
        expect(infoMessages().at(-1)).toMatch(/wrote cleanupPeriodDays 365 into .*settings\.json\. Claude Code keeps transcripts 365 days from its next start\. .*proj.*settings\.json sets its own for this window's folders\./);
      } finally {
        workspace.workspaceFolders = undefined;
      }
    }, 60_000);

    it("says when the file cannot be written, and when managed settings win", async () => {
      stub.config["lookout.retention.days"] = 3650;
      fs.writeFileSync(settings(), "{ not json");
      activate(context());
      await vi.waitFor(() => expect(warnings().at(-1)).toMatch(/did not write cleanupPeriodDays 3650: .*settings\.json does not parse as JSON\. Add it to the file yourself\./), WAIT);
      expect(fs.readFileSync(settings(), "utf8")).toBe("{ not json");
      // The cached server-managed settings set it: those win, so nothing is written.
      fs.writeFileSync(settings(), JSON.stringify({ model: "opus" }));
      fs.writeFileSync(remoteSettingsFile(configDir), JSON.stringify({ cleanupPeriodDays: 14 }));
      changed();
      await settle();
      stub.config["lookout.retention.days"] = 3651;
      changed();
      await vi.waitFor(() => expect(warnings().at(-1)).toMatch(/did not write cleanupPeriodDays 3651: managed settings at .* set it/), WAIT);
      expect(JSON.parse(fs.readFileSync(settings(), "utf8"))).toEqual({ model: "opus" });
    }, 60_000);
  });

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
      // The retention line under Earlier has tests of its own.
      stub.config["lookout.retention.hint"] = false;
      writePast("/work/app", HERE, "main", "tune the deploy script");
      writePast("/work/other", ELSEWHERE, "fix-x", "deploy the other service");
    });

    afterEach(() => {
      workspace.workspaceFolders = undefined;
    });

    it("keeps the tool output in the search while the setting is on, and lets it go once it is off", async () => {
      // HERE's transcript gains a command that failed, and its error.
      const file = path.join(configDir, "projects", "-work-app", `${HERE}.jsonl`);
      const at = new Date().toISOString();
      fs.appendFileSync(
        file,
        [
          { type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run migrate -- --env staging" } }] } },
          { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: 'ERROR: relation "billing_events" does not exist' }] } },
        ]
          .map((entry) => JSON.stringify(entry) + "\n")
          .join(""),
      );
      activate(context());
      const { boardView, listed } = openBoard();
      await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
      const found = () => boardView.posted.filter((m) => (m as { type: string }).type === "search").at(-1) as { results: { id: string; hits: { role: string }[] }[] };
      const search = () => boardView.receive({ type: "search", query: "billing_events", zone: 0 });
      // Off, the default: the error is not in the search.
      search();
      await settle();
      search();
      expect(found().results).toEqual([]);
      // On: the conversations are read again for their tool output, and the error finds its session, as a tool match.
      stub.config["lookout.search.toolOutput"] = true;
      stub.configChange.fire({ affectsConfiguration: () => true });
      await vi.waitFor(() => {
        search();
        expect(found().results.map((r) => [r.id, r.hits.map((h) => h.role)])).toEqual([[HERE, ["tool"]]]);
      }, WAIT);
      // Off again: it goes at once.
      stub.config["lookout.search.toolOutput"] = false;
      stub.configChange.fire({ affectsConfiguration: () => true });
      await vi.waitFor(() => {
        search();
        expect(found().results).toEqual([]);
      }, WAIT);
    }, 60_000);

    it("lists this window's folders, then every project once asked, keeps the choice, and searches what it lists", async () => {
      activate(context());
      const { boardView, listed } = openBoard();
      await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
      // With the store as the index, every earlier session is listed and searched: no limit.
      expect(listed()?.earlier).toEqual({ scope: "folders", limit: Number.MAX_SAFE_INTEGER, capped: false });
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

    it("reads the conversations in a thread of its own, and sends a search's results again as they are read", async () => {
      const extension = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-ext-"));
      try {
        buildReader(extension);
        activate(context(extension));
        const { boardView, listed } = openBoard();
        await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
        const answers = () => boardView.posted.filter((m) => (m as { type: string }).type === "search") as { results: { id: string; count: number }[]; pending: number; follows?: boolean }[];
        boardView.receive({ type: "search", query: "deploy" });
        expect(answers()[0]).toMatchObject({ query: "deploy", follows: true });
        await vi.waitFor(() => expect(answers().at(-1)).toMatchObject({ pending: 0, results: [{ id: HERE, count: 1 }] }), WAIT);
      } finally {
        fs.rmSync(extension, { recursive: true, force: true });
      }
    }, 60_000);

    it("searches in the extension host again, a little at a time, when the reading thread breaks", async () => {
      const extension = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-ext-"));
      try {
        // A bundle that does not load: the thread fails on its first read.
        fs.mkdirSync(path.join(extension, "dist"));
        fs.writeFileSync(path.join(extension, "dist", "reader.js"), 'throw new Error("broken bundle");');
        activate(context(extension));
        const { boardView, listed } = openBoard();
        await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
        const answers = () => boardView.posted.filter((m) => (m as { type: string }).type === "search") as { results: { id: string; count: number }[]; pending: number; follows?: boolean }[];
        boardView.receive({ type: "search", query: "deploy" });
        expect(answers()[0]).toMatchObject({ follows: true });
        // Told the thread broke, the board gets an answer read here, and asks again by itself from then on.
        await vi.waitFor(() => expect(answers().at(-1)).toMatchObject({ pending: 0, results: [{ id: HERE, count: 1 }] }), WAIT);
        expect(answers().at(-1)?.follows).toBeUndefined();
        boardView.receive({ type: "search", query: "tune" });
        expect(answers().at(-1)).toMatchObject({ query: "tune", results: [{ id: HERE, count: 1 }] });
      } finally {
        fs.rmSync(extension, { recursive: true, force: true });
      }
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

    it("keeps a thread of notes on an earlier session, shows the newest on the card, finds each in a search, and takes them away one by one", async () => {
      const recordsDir = path.join(configDir, "global-storage", "sessions");
      // A note written in another window, on a session this window's folders do not hold.
      new SessionRecords(recordsDir).addNote(ELSEWHERE, "the other service's deploy, kept for its runbook", { agent: "claude-code", title: "deploy the other service", cwd: "/work/other" });
      activate(context());
      const { boardView, listed } = openBoard();
      await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
      const card = () => (listed()?.past as { id: string; note?: string; noteCount?: number }[] | undefined)?.find((p) => p.id === HERE);
      expect(card()?.note).toBeUndefined();
      const notePanels = () => stub.panels.filter((panel) => panel.viewType === "lookout.note");
      const notePanel = () => notePanels().at(-1)!;
      const thread = () => (notePanel().posted.filter((m) => (m as { type: string }).type === "notes").at(-1) as { notes: { id: string; text: string }[]; max: number } | undefined)?.notes;
      // The note button opens the notes' page, empty; a note keeps its lines.
      boardView.receive({ type: "note", id: HERE });
      await vi.waitFor(() => expect(notePanel()?.posted.at(-1)).toMatchObject({ type: "notes", session: { id: HERE, title: "tune the deploy script", live: false }, notes: [], max: NOTE_MAX }), WAIT);
      expect(notePanel().title).toBe("Notes: tune the deploy script");
      notePanel().receive({ type: "add", id: HERE, text: "  has the deploy  recipe \n\nsecond line  " });
      await vi.waitFor(() => expect(card()).toMatchObject({ note: "has the deploy  recipe\n\nsecond line", noteCount: 1 }), WAIT);
      notePanel().receive({ type: "add", id: HERE, text: "the staging run went fine" });
      await vi.waitFor(() => expect(card()).toMatchObject({ note: "the staging run went fine", noteCount: 2 }), WAIT);
      // Kept for the machine: one file per noted session under the extension's storage, the thread in it.
      expect(fs.readdirSync(recordsDir)).toHaveLength(2);
      // A blank note adds nothing, and says so.
      notePanel().receive({ type: "add", id: HERE, text: " \n " });
      await vi.waitFor(() => expect(notePanel().posted.at(-1)).toEqual({ type: "failed", id: HERE }), WAIT);
      expect(card()?.noteCount).toBe(2);
      // A session the board was not shown gets no page.
      boardView.receive({ type: "note", id: "nope" });
      expect(notePanels()).toHaveLength(1);
      // The search finds a note by its words, before the session's messages; has:note lists every note of every noted session, newest first.
      boardView.receive({ type: "search", query: "deploy recipe", zone: 0 });
      const found = () => boardView.posted.filter((m) => (m as { type: string }).type === "search").at(-1) as { query: string; results: { id: string; count: number; hits: { role: string; snippet: string }[] }[] };
      expect(found().query).toBe("deploy recipe");
      expect(found().results.map((r) => [r.id, r.count, r.hits.map((h) => h.role)])).toEqual([[HERE, 1, ["note"]]]);
      boardView.receive({ type: "search", query: "has:note", zone: 0 });
      expect(
        found()
          .results.map((r) => [r.id, r.count, r.hits.map((hit) => hit.snippet)])
          .sort(),
      ).toEqual([
        [HERE, 0, ["the staging run went fine", "has the deploy  recipe\n\nsecond line"]],
        [ELSEWHERE, 0, ["the other service's deploy, kept for its runbook"]],
      ]);
      // The command opens the search page on them.
      await stub.commands.get("lookout.showNotes")!();
      expect(stub.panels.find((panel) => panel.viewType === "lookout.search")?.posted.at(-1)).toEqual({ type: "query", query: "has:note" });
      // The page again, the same tab, with the thread as it is; each note goes on its own, the record with the last.
      boardView.receive({ type: "note", id: HERE });
      expect(notePanels()).toHaveLength(1);
      const [first, second] = thread()!;
      notePanel().receive({ type: "remove", id: HERE, noteId: first!.id });
      await vi.waitFor(() => expect(card()).toMatchObject({ note: "the staging run went fine", noteCount: 1 }), WAIT);
      notePanel().receive({ type: "edit", id: HERE, noteId: second!.id, text: "  " });
      await vi.waitFor(() => expect(card()?.note).toBeUndefined(), WAIT);
      expect(fs.readdirSync(recordsDir)).toHaveLength(1);
      // A note written in another window shows on the card here, through the watch on the records, and on the open page.
      new SessionRecords(recordsDir).addNote(HERE, "written elsewhere", { agent: "claude-code", title: "tune the deploy script", cwd: "/work/app" });
      await vi.waitFor(() => expect(card()?.note).toBe("written elsewhere"), WAIT);
      await vi.waitFor(() => expect(thread()?.map((note) => note.text)).toEqual(["written elsewhere"]), WAIT);
    }, 60_000);

    describe.skipIf(loadSqlite() === undefined)("kept past the purge", () => {
      const transcriptOf = (id: string) => path.join(configDir, "projects", "-work-app", `${id}.jsonl`);

      it("keeps a conversation after the agent deletes its transcript: under Purged, readable and searchable, until forgotten", async () => {
        activate(context());
        const { boardView, listed } = openBoard();
        await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
        const found = () => boardView.posted.filter((m) => (m as { type: string }).type === "search").at(-1) as { results: { id: string; count: number; hits: { role: string }[] }[] };
        const purged = () => (boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { purged?: { id: string; title: string; resumable: boolean; purged?: boolean }[] } | undefined)?.purged;
        // A search reads the conversation, into the store on the way.
        boardView.receive({ type: "search", query: "deploy", zone: 0 });
        expect(found().results.map((r) => [r.id, r.count])).toEqual([[HERE, 1]]);
        boardView.receive({ type: "search", query: "" });
        expect(fs.existsSync(path.join(configDir, "global-storage", "history.sqlite"))).toBe(true);
        // The agent deletes the transcript: the session leaves Earlier for Purged.
        fs.unlinkSync(transcriptOf(HERE));
        await vi.waitFor(() => expect(purged()?.map((p) => [p.id, p.title, p.resumable, p.purged])).toEqual([[HERE, "tune the deploy script", false, true]]), WAIT);
        expect(listed()?.past).toEqual([]);
        // Its conversation can be read, from the store; the tab offers no way to the session, and a try says why.
        boardView.receive({ type: "openHit", query: "", id: HERE });
        const findings = stub.panels.find((panel) => panel.viewType === "lookout.findings")!;
        const tab = findings.posted.at(-1) as { session: { id: string; title: string; openable?: boolean }; messages: { text: string }[] };
        expect(tab).toMatchObject({ session: { id: HERE, title: "tune the deploy script", openable: false }, messages: [{ text: "tune the deploy script" }] });
        findings.receive({ type: "jump", id: HERE });
        await vi.waitFor(() => expect(infoMessages().at(-1)).toMatch(/cannot be resumed/), WAIT);
        // And searched.
        boardView.receive({ type: "search", query: "deploy", zone: 0 });
        expect(found().results.map((r) => [r.id, r.count, r.hits.map((hit) => hit.role)])).toEqual([[HERE, 1, ["you"]]]);
        // A note can be written on it, from its page.
        boardView.receive({ type: "note", id: HERE });
        const notePanel = () => stub.panels.filter((panel) => panel.viewType === "lookout.note").at(-1)!;
        await vi.waitFor(() => expect(notePanel()?.posted.at(-1)).toMatchObject({ type: "notes", session: { id: HERE } }), WAIT);
        notePanel().receive({ type: "add", id: HERE, text: "gone, but had the deploy steps" });
        await vi.waitFor(() => expect((purged() as { note?: string }[] | undefined)?.[0]?.note).toBe("gone, but had the deploy steps"), WAIT);
        // Forgotten, after a confirmation, since the copy is the only one left: gone from Purged and from the search; the note stays.
        stub.notificationAnswer = undefined;
        boardView.receive({ type: "forget", id: HERE });
        await settle();
        expect(purged()?.map((p) => p.id)).toEqual([HERE]);
        stub.notificationAnswer = "Forget";
        boardView.receive({ type: "forget", id: HERE });
        await vi.waitFor(() => expect(purged()).toEqual([]), WAIT);
        boardView.receive({ type: "search", query: "deploy", zone: 0 });
        expect(found().results.map((r) => [r.id, r.hits.map((hit) => hit.role)])).toEqual([[HERE, ["note"]]]);
        // Nothing more to forget.
        await stub.commands.get("lookout.forgetPurged")!();
        expect(infoMessages().at(-1)).toBe("Lookout keeps no purged conversation.");
      }, 60_000);

      it("keeps a transcript on request, as a copy that follows the file, and puts it back once the agent deleted it", async () => {
        activate(context());
        const { boardView, listed } = openBoard();
        await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
        const card = { webviewSection: "card", sessionId: HERE };
        const vaultDir = path.join(configDir, "global-storage", "vault");
        const keptFiles = () => (fs.existsSync(vaultDir) ? fs.readdirSync(vaultDir).filter((name) => name.endsWith(".jsonl")) : []);
        const kept = () => (listed()?.past[0] as { kept?: boolean } | undefined)?.kept;
        // Kept from the card's menu: the card says so, and a copy sits under Lookout's storage.
        await stub.commands.get("lookout.card.keep")!(card);
        await vi.waitFor(() => expect(kept()).toBe(true), WAIT);
        expect(keptFiles()).toHaveLength(1);
        // The agent appends, then deletes the transcript: the session goes under Purged, kept.
        const file = transcriptOf(HERE);
        fs.appendFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "all done" }] } }) + "\n");
        fs.unlinkSync(file);
        const purged = () => (boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { purged?: { id: string; kept?: boolean }[] } | undefined)?.purged;
        await vi.waitFor(() => expect(purged()?.map((p) => [p.id, p.kept])).toEqual([[HERE, true]]), WAIT);
        // Restored: the file is back where it was, with what the agent appended, and the session leaves Purged for Earlier.
        boardView.receive({ type: "restore", id: HERE });
        await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
        expect(purged()).toEqual([]);
        expect(fs.readFileSync(file, "utf8")).toContain("all done");
        expect(infoMessages().at(-1)).toMatch(/put the transcript of "tune the deploy script" back/);
        // Stopped keeping: the copy goes, and the card no longer says kept.
        await stub.commands.get("lookout.card.unkeep")!(card);
        await vi.waitFor(() => expect(kept()).toBeUndefined(), WAIT);
        expect(keptFiles()).toHaveLength(0);
        // A session the board does not know keeps nothing, and with nothing kept the folder command says so.
        await stub.commands.get("lookout.card.keep")!({ ...card, sessionId: "nope" });
        expect(keptFiles()).toHaveLength(0);
        await stub.commands.get("lookout.openKeptTranscripts")!();
        expect(infoMessages().at(-1)).toMatch(/keeps no transcript yet/);
      }, 60_000);

      it("keeps every starred session's transcript when the setting asks", async () => {
        stub.config["lookout.keepTranscripts.favourites"] = true;
        savedGlobal["lookout.favourites"] = [HERE];
        activate(context());
        const { listed } = openBoard();
        await vi.waitFor(() => expect((listed()?.past[0] as { kept?: boolean } | undefined)?.kept).toBe(true), WAIT);
        expect(fs.readdirSync(path.join(configDir, "global-storage", "vault")).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
      }, 60_000);

      it("shows nothing under Purged when keeping is off, and lets the conversation go a sweep later rather than at once", async () => {
        stub.config["lookout.history.keep"] = false;
        activate(context());
        const { boardView, listed } = openBoard();
        await vi.waitFor(() => expect(listed()?.past.map((p) => p.id)).toEqual([HERE]), WAIT);
        const purged = () => (boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { purged?: unknown[] } | undefined)?.purged;
        boardView.receive({ type: "search", query: "deploy", zone: 0 });
        boardView.receive({ type: "search", query: "" });
        fs.unlinkSync(transcriptOf(HERE));
        await vi.waitFor(() => expect(listed()?.past).toEqual([]), WAIT);
        await settle();
        expect(purged()).toEqual([]);
        // Out of sight, and out of the search, while it is kept a moment longer in case the transcript comes back.
        boardView.receive({ type: "search", query: "deploy", zone: 0 });
        const found = boardView.posted.filter((m) => (m as { type: string }).type === "search").at(-1) as { results: unknown[] };
        expect(found.results).toEqual([]);
      }, 60_000);
    });

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

  it("keeps the order the user drags the cards into, the stars' new order, and the sort chosen from the menu", async () => {
    writeTranscript();
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    savedGlobal["lookout.favourites"] = ["f1", "f2", SESSION];
    activate(context());
    const board = stub.webviewProviders.get("lookout.board") as { resolveWebviewView(view: unknown): void };
    const boardView = createWebviewView();
    board.resolveWebviewView(boardView);
    const last = () => boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { sort?: { by: string; order: string[] }; group?: string; favourites?: { ids: string[] } } | undefined;
    await vi.waitFor(() => expect(last()?.sort).toEqual({ by: "time", order: [] }), WAIT);
    boardView.receive({ type: "order", ids: [SESSION, "other", 7] });
    expect(savedGlobal["lookout.sort"]).toEqual({ by: "custom", order: [SESSION, "other"] });
    expect(last()?.sort).toEqual({ by: "custom", order: [SESSION, "other"] });
    // The stars it names first, the rest behind; an id that is not a star is left out.
    boardView.receive({ type: "favouriteOrder", ids: [SESSION, "nope", "f2"] });
    expect(savedGlobal["lookout.favourites"]).toEqual([SESSION, "f2", "f1"]);
    await vi.waitFor(() => expect(last()?.favourites?.ids).toEqual([SESSION, "f2", "f1"]), WAIT);
    // The menu lists every order, the current one checked; a pick keeps the user's own order for later.
    let offered: string[] = [];
    stub.quickPick = (items) => {
      offered = (items as { label: string }[]).map((item) => item.label);
      return (items as { key: string }[]).find((item) => item.key === "name");
    };
    await stub.commands.get("lookout.sortSessions")!();
    expect(offered).toEqual(["Longest in its state first", "Latest change first", "Name", "Project", "Most tokens first", "Most expensive first", "$(check) Your order"]);
    expect(savedGlobal["lookout.sort"]).toEqual({ by: "name", order: [SESSION, "other"] });
    expect(last()?.sort?.by).toBe("name");
    // Dismissed: nothing changes.
    stub.quickPick = () => undefined;
    await stub.commands.get("lookout.sortSessions")!();
    expect(savedGlobal["lookout.sort"]).toEqual({ by: "name", order: [SESSION, "other"] });
    // The board's own chip: a pick keeps your order too; an unknown order is ignored.
    boardView.receive({ type: "sort", by: "project" });
    expect(savedGlobal["lookout.sort"]).toEqual({ by: "project", order: [SESSION, "other"] });
    await vi.waitFor(() => expect(last()?.sort?.by).toBe("project"), WAIT);
    boardView.receive({ type: "sort", by: "size" });
    expect(savedGlobal["lookout.sort"]).toEqual({ by: "project", order: [SESSION, "other"] });
    // The group chip and its command: the grouping is kept and sent back; an unknown one is ignored.
    expect(last()?.group).toBe("state");
    boardView.receive({ type: "group", by: "project" });
    expect(savedGlobal["lookout.group"]).toBe("project");
    await vi.waitFor(() => expect(last()?.group).toBe("project"), WAIT);
    boardView.receive({ type: "group", by: "size" });
    expect(savedGlobal["lookout.group"]).toBe("project");
    stub.quickPick = (items) => {
      offered = (items as { label: string }[]).map((item) => item.label);
      return (items as { key: string }[]).find((item) => item.key === "model");
    };
    await stub.commands.get("lookout.groupSessions")!();
    expect(offered).toEqual(["State", "$(check) Project", "Branch", "Model", "Agent", "Window"]);
    expect(savedGlobal["lookout.group"]).toBe("model");
  }, 60_000);

  it("acts on a card from its context menu as its buttons do, and on no session it does not run", async () => {
    writeTranscript();
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    activate(context());
    await vi.waitFor(() => expect(boardStates()).toBe("idle 1"), WAIT);
    const card = { webview: "lookout.board", webviewSection: "card", sessionId: SESSION };
    await stub.commands.get("lookout.card.park")!(card);
    expect(savedGlobal["lookout.parking"]).toEqual({ parked: [SESSION], kept: [] });
    await stub.commands.get("lookout.card.unpark")!(card);
    expect(savedGlobal["lookout.parking"]).toEqual({ parked: [], kept: [SESSION] });
    await stub.commands.get("lookout.card.star")!(card);
    expect(savedGlobal["lookout.favourites"]).toEqual([SESSION]);
    await stub.commands.get("lookout.card.unstar")!(card);
    expect(savedGlobal["lookout.favourites"]).toEqual([]);
    // Not running, or no card at all: nothing happens.
    await stub.commands.get("lookout.card.star")!({ ...card, sessionId: "gone" });
    await stub.commands.get("lookout.card.star")!();
    expect(savedGlobal["lookout.favourites"]).toEqual([]);
  }, 60_000);

  it("notes a running session from its card menu, says so in its view, and takes the note away", async () => {
    writeTranscript();
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    activate(context());
    const board = stub.webviewProviders.get("lookout.board") as { resolveWebviewView(view: unknown): void };
    const boardView = createWebviewView();
    board.resolveWebviewView(boardView);
    const shown = () => (boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { sessions?: { id: string; note?: string }[] } | undefined)?.sessions?.[0];
    await vi.waitFor(() => expect(shown()).toMatchObject({ id: SESSION }), WAIT);
    const shownNotes = () => shown() as { note?: string; noteCount?: number } | undefined;
    const card = { webviewSection: "card", sessionId: SESSION };
    const notePanels = () => stub.panels.filter((panel) => panel.viewType === "lookout.note");
    const notePanel = () => notePanels().at(-1)!;
    const thread = () => (notePanel().posted.filter((m) => (m as { type: string }).type === "notes").at(-1) as { notes: { id: string; text: string; at: number; editedAt?: number }[] } | undefined)?.notes;
    // Add Note… opens the notes' page on the session, which says it is running and has none yet; a note added there lands on the card.
    await stub.commands.get("lookout.card.addNote")!(card);
    await vi.waitFor(() => expect(notePanel()?.posted.at(-1)).toMatchObject({ type: "notes", session: { id: SESSION, title: "Empty tab", live: true }, notes: [] }), WAIT);
    expect(notePanel().title).toBe("Notes: Empty tab");
    notePanel().receive({ type: "add", id: SESSION, text: "kept for the migration" });
    await vi.waitFor(() => expect(shownNotes()).toMatchObject({ note: "kept for the migration", noteCount: 1 }), WAIT);
    expect(thread()?.map((note) => note.text)).toEqual(["kept for the migration"]);
    // The record names the session as the board does.
    const records = new SessionRecords(path.join(configDir, "global-storage", "sessions"));
    expect(records.get(SESSION)).toMatchObject({ agent: "claude-code", title: "Empty tab", cwd: "/work/app", notes: [{ text: "kept for the migration" }] });
    // A second note joins the thread, each with its own time; the card shows the newest and how many there are.
    notePanel().receive({ type: "add", id: SESSION, text: "the rollback is in the second message" });
    await vi.waitFor(() => expect(shownNotes()).toMatchObject({ note: "the rollback is in the second message", noteCount: 2 }), WAIT);
    const [first, second] = thread()!;
    expect(first!.at).toBeLessThanOrEqual(second!.at);
    // Show Notes brings the same page forward.
    await stub.commands.get("lookout.card.showNotes")!(card);
    expect(notePanels()).toHaveLength(1);
    // One note changed, marked as changed; one taken away; the last taken away leaves the card without notes.
    notePanel().receive({ type: "edit", id: SESSION, noteId: first!.id, text: "kept for the migration, done" });
    await vi.waitFor(() => expect(thread()?.[0]).toMatchObject({ text: "kept for the migration, done", editedAt: expect.any(Number) }), WAIT);
    notePanel().receive({ type: "remove", id: SESSION, noteId: second!.id });
    await vi.waitFor(() => expect(shownNotes()).toMatchObject({ note: "kept for the migration, done", noteCount: 1 }), WAIT);
    notePanel().receive({ type: "remove", id: SESSION, noteId: first!.id });
    await vi.waitFor(() => expect(shownNotes()?.note).toBeUndefined(), WAIT);
    // A change to a note that is not there says so, and changes nothing.
    notePanel().receive({ type: "edit", id: SESSION, noteId: "nope", text: "x" });
    await vi.waitFor(() => expect(notePanel().posted.at(-1)).toEqual({ type: "failed", id: SESSION }), WAIT);
    // Not running, or no card at all: nothing happens.
    await stub.commands.get("lookout.card.addNote")!({ ...card, sessionId: "gone" });
    await stub.commands.get("lookout.card.addNote")!();
    expect(notePanels()).toHaveLength(1);
  }, 60_000);

  it("parks a session from its card, brings it back, and lets it leave Parked when it works again", async () => {
    writeTranscript();
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    activate(context());
    const board = stub.webviewProviders.get("lookout.board") as { resolveWebviewView(view: unknown): void };
    const boardView = createWebviewView();
    board.resolveWebviewView(boardView);
    const shown = () => (boardView.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { sessions?: { id: string; state: string; parked?: boolean }[] } | undefined)?.sessions?.[0];
    await vi.waitFor(() => expect(shown()).toMatchObject({ id: SESSION, state: "idle" }), WAIT);
    expect(shown()?.parked).toBeUndefined();
    boardView.receive({ type: "park", id: SESSION });
    await vi.waitFor(() => expect(shown()?.parked).toBe(true), WAIT);
    expect(savedGlobal["lookout.parking"]).toEqual({ parked: [SESSION], kept: [] });
    boardView.receive({ type: "park", id: SESSION });
    await vi.waitFor(() => expect(shown()?.parked).toBeUndefined(), WAIT);
    expect(savedGlobal["lookout.parking"]).toEqual({ parked: [], kept: [SESSION] });
    boardView.receive({ type: "park", id: SESSION });
    await vi.waitFor(() => expect(shown()?.parked).toBe(true), WAIT);
    // It works again: out of Parked, and parked no more.
    writeSession({ status: "busy", statusUpdatedAt: Date.now() });
    await vi.waitFor(() => expect(shown()).toMatchObject({ state: "working" }), WAIT);
    expect(shown()?.parked).toBeUndefined();
    expect(savedGlobal["lookout.parking"]).toEqual({ parked: [], kept: [] });
    // An unknown id parks nothing.
    boardView.receive({ type: "park", id: "nope" });
    expect(savedGlobal["lookout.parking"]).toEqual({ parked: [], kept: [] });
  }, 60_000);

  it("parks a session idle longer than lookout.parkAfterHours on its own, and drops its finished mark", async () => {
    saved["lookout.done"] = [SESSION];
    writeTranscript();
    writeSession({ status: "idle", statusUpdatedAt: Date.now() - 25 * 3_600_000 });
    stub.config["lookout.parkAfterHours"] = 0;
    activate(context());
    await vi.waitFor(() => expect(boardStates()).toBe("done 1"), WAIT);
    stub.config["lookout.parkAfterHours"] = 24;
    stub.configChange.fire({ affectsConfiguration: () => true });
    await vi.waitFor(() => expect(boardStates()).toBe("idle 1"), WAIT);
    const last = statesBoard!.posted.filter((m) => (m as { type: string }).type === "sessions").at(-1) as { sessions: { parked?: boolean }[] };
    expect(last.sessions[0]?.parked).toBe(true);
    expect(saved["lookout.done"]).toEqual([]);
  }, 60_000);

  it("publishes its finished marks to the other windows, and clears one another window marks seen", async () => {
    saved["lookout.done"] = [SESSION];
    // Something sent: once seen, the session stays on the board, idle.
    writeTranscript();
    writeSession({ status: "idle", statusUpdatedAt: Date.now() });
    activate(context());
    await vi.waitFor(() => expect(boardStates()).toBe("done 1"), WAIT);
    const windows = path.join(configDir, "global-storage", "windows");
    const record = () => JSON.parse(fs.readFileSync(path.join(windows, `${process.pid}.json`), "utf8")) as { done?: string[] };
    expect(record().done).toEqual([SESSION]);
    new JumpMailbox(windows).sendSeen(process.pid, { ids: [SESSION], fromPid: 4242 }, Date.now());
    await vi.waitFor(() => expect(boardStates()).toBe("idle 1"), WAIT);
    expect(record().done).toBeUndefined();
    expect(saved["lookout.done"]).toEqual([]);
  }, 60_000);

  it("shows another window's finished session as finished, and sends its check and mark all seen to that window", async () => {
    // The other window, as in the jump test: the test runner's parent, with a shell of its terminals running the session.
    const other = process.ppid;
    const shell = spawn(process.execPath, ["-e", 'const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const sessionPid = await new Promise<number>((resolve) => shell.stdout!.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
      const windows = path.join(configDir, "global-storage", "windows");
      fs.mkdirSync(windows, { recursive: true });
      const publish = (done: string[]) => fs.writeFileSync(path.join(windows, `${other}.json`), JSON.stringify({ pid: other, label: "api", terminals: [shell.pid], ...(done.length ? { done } : {}) }));
      publish([SESSION]);
      writeTranscript();
      const record = { pid: sessionPid, sessionId: SESSION, cwd: "/work/app", startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status: "idle", statusUpdatedAt: Date.now() };
      fs.writeFileSync(path.join(configDir, "sessions", `${sessionPid}.json`), JSON.stringify(record));
      activate(context());
      try {
        await vi.waitFor(() => expect(boardStates()).toBe("done 1"), WAIT);
        // This window keeps no mark of its own for it: the other window does.
        expect(saved["lookout.done"] ?? []).toEqual([]);
        const mail = new JumpMailbox(windows);
        statesBoard!.receive({ type: "seen", id: SESSION });
        expect(mail.takeSeen(other, Date.now())).toEqual([expect.objectContaining({ ids: [SESSION], fromPid: process.pid })]);
        await stub.commands.get("lookout.markAllSeen")!();
        expect(mail.takeSeen(other, Date.now())).toEqual([expect.objectContaining({ ids: [SESSION], fromPid: process.pid })]);
        // The other window takes the mark away: the session is idle here too.
        publish([]);
        await vi.waitFor(() => expect(boardStates()).toBe("idle 1"), WAIT);
      } finally {
        process.kill(sessionPid);
      }
    } finally {
      shell.kill();
    }
  }, 60_000);
});
