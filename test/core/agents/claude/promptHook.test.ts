import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  asksFolder,
  decisionFor,
  HOOK_SCRIPT,
  hookCommand,
  hookScriptFile,
  installPromptHook,
  markAlive,
  promptHookInstalled,
  readAsks,
  REFUSED,
  removePromptHook,
  replyToAsk,
  type PanelAsk,
} from "../../../../src/core/agents/claude/promptHook";

let dir: string;
let configDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-hook-"));
  configDir = path.join(dir, "claude");
  fs.mkdirSync(configDir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const settingsFile = () => path.join(configDir, "settings.json");
const settings = () => JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "~/bin/audit.sh" }] };
const posix = process.platform !== "win32";

describe("installPromptHook", () => {
  it("adds one PermissionRequest hook for every tool, keeps every other key and hook, and keeps a copy of the file as it was", () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ model: "opus", hooks: { PermissionRequest: [theirs], Stop: [theirs] } }, null, 4));
    const outcome = installPromptHook(configDir, Date.UTC(2026, 10, 11));
    expect(outcome).toMatchObject({ ok: true, file: settingsFile() });
    const after = settings();
    expect(after.model).toBe("opus");
    const hooks = after.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toEqual([theirs]);
    expect(hooks.PermissionRequest).toEqual([theirs, { matcher: "*", hooks: [{ type: "command", command: hookCommand(configDir), timeout: 86400 }] }]);
    // The file's own indentation.
    expect(fs.readFileSync(settingsFile(), "utf8")).toContain('\n    "model"');
    const backup = (outcome as { backup?: string }).backup!;
    expect(JSON.parse(fs.readFileSync(backup, "utf8")).hooks.PermissionRequest).toEqual([theirs]);
    expect(fs.readFileSync(hookScriptFile(configDir), "utf8")).toBe(HOOK_SCRIPT);
    expect(promptHookInstalled(configDir)).toBe(true);
  });

  it("writes nothing the second time, and replaces an entry of Lookout's written otherwise", () => {
    installPromptHook(configDir);
    expect(installPromptHook(configDir)).toMatchObject({ ok: true, unchanged: true });
    const stale = { matcher: "*", hooks: [{ type: "command", command: "sh '/old/place/lookout/answer-prompt.sh'", timeout: 600 }] };
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { PermissionRequest: [stale, theirs] } }));
    expect(promptHookInstalled(configDir)).toBe(false);
    installPromptHook(configDir);
    expect((settings().hooks as Record<string, unknown[]>).PermissionRequest).toEqual([theirs, { matcher: "*", hooks: [{ type: "command", command: hookCommand(configDir), timeout: 86400 }] }]);
  });

  it.runIf(posix)("keeps the prompts' folder to the user alone, as Claude Code keeps its transcripts", () => {
    installPromptHook(configDir);
    expect(fs.statSync(path.join(configDir, "lookout")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(asksFolder(configDir)).mode & 0o777).toBe(0o700);
  });

  it("moves a changed script into place whole, so a hook waiting goes on reading the one it started from", () => {
    installPromptHook(configDir);
    const script = hookScriptFile(configDir);
    fs.writeFileSync(script, "#!/bin/sh\n# an older Lookout's\n");
    const before = fs.statSync(script).ino;
    installPromptHook(configDir);
    expect(fs.readFileSync(script, "utf8")).toBe(HOOK_SCRIPT);
    expect(fs.statSync(script).ino).not.toBe(before);
    expect(fs.readdirSync(path.join(configDir, "lookout")).sort()).toEqual(["alive", "answer-prompt.sh", "asks"]);
  });

  it("creates the settings file when there is none", () => {
    expect(installPromptHook(configDir)).toMatchObject({ ok: true });
    expect(promptHookInstalled(configDir)).toBe(true);
  });

  it("leaves a file alone whose hooks it cannot read as Claude Code writes them", () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { PermissionRequest: { matcher: "*" } } }));
    expect(installPromptHook(configDir)).toEqual({ ok: false, file: settingsFile(), why: "has a `hooks.PermissionRequest` value that is not a list" });
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: [] }));
    expect(installPromptHook(configDir)).toEqual({ ok: false, file: settingsFile(), why: "has a `hooks` value that is not an object" });
    fs.writeFileSync(settingsFile(), "{ not json");
    expect(installPromptHook(configDir)).toEqual({ ok: false, file: settingsFile(), why: "does not parse as JSON" });
    expect(fs.readFileSync(settingsFile(), "utf8")).toBe("{ not json");
  });
});

describe("removePromptHook", () => {
  it("takes out only Lookout's hook, drops what it leaves empty, and removes Lookout's folder", () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ model: "opus", hooks: { PermissionRequest: [theirs] } }));
    installPromptHook(configDir);
    expect(removePromptHook(configDir)).toMatchObject({ ok: true });
    expect(settings()).toEqual({ model: "opus", hooks: { PermissionRequest: [theirs] } });
    expect(fs.existsSync(hookScriptFile(configDir))).toBe(false);
    fs.writeFileSync(settingsFile(), JSON.stringify({ model: "opus" }));
    installPromptHook(configDir);
    removePromptHook(configDir);
    expect(settings()).toEqual({ model: "opus" });
  });

  it("keeps another hook in the same entry as Lookout's", () => {
    const shared = { matcher: "*", hooks: [{ type: "command", command: hookCommand(configDir) }, { type: "command", command: "~/bin/audit.sh" }] };
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { PermissionRequest: [shared] } }));
    removePromptHook(configDir);
    expect(settings()).toEqual({ hooks: { PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: "~/bin/audit.sh" }] }] } });
  });

  it("writes nothing when the file holds no hook of Lookout's", () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { PermissionRequest: [theirs] } }));
    expect(removePromptHook(configDir)).toEqual({ ok: true, file: settingsFile(), unchanged: true });
    expect(fs.readdirSync(configDir)).toEqual(["settings.json"]);
  });
});

describe("the hook command", () => {
  it("quotes the script's path for the shell, with forward slashes", () => {
    expect(hookCommand("/home/u/.claude")).toBe("[ ! -f '/home/u/.claude/lookout/answer-prompt.sh' ] || exec sh '/home/u/.claude/lookout/answer-prompt.sh'");
    expect(hookCommand("/home/o'neil/.claude")).toContain(`'/home/o'\\''neil/.claude/lookout/answer-prompt.sh'`);
  });

  it.runIf(posix)("does nothing, successfully, once the script is gone", () => {
    const run = spawnSync("sh", ["-c", hookCommand(configDir)], { input: "{}", encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });
});

const ask = (overrides: Record<string, unknown> = {}) => ({
  session_id: "s1",
  hook_event_name: "PermissionRequest",
  tool_name: "AskUserQuestion",
  tool_input: { questions: [{ question: "Pick a colour?", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] },
  ...overrides,
});

describe("readAsks", () => {
  it("reads the prompts hooks wait on, and clears those whose hook stopped marking them", () => {
    installPromptHook(configDir);
    const folder = asksFolder(configDir);
    fs.writeFileSync(path.join(folder, "101.json"), JSON.stringify(ask()));
    fs.writeFileSync(path.join(folder, "102.json"), JSON.stringify(ask({ session_id: "s2", tool_name: "Bash", tool_input: { command: "ls" } })));
    fs.writeFileSync(path.join(folder, "103.json.part"), "{");
    fs.writeFileSync(path.join(folder, "104.json"), JSON.stringify(ask({ hook_event_name: "PreToolUse" })));
    const old = new Date(Date.now() - 60_000);
    fs.writeFileSync(path.join(folder, "105.json"), JSON.stringify(ask()));
    fs.utimesSync(path.join(folder, "105.json"), old, old);
    fs.writeFileSync(path.join(folder, "106.reply.json"), "{}");
    fs.utimesSync(path.join(folder, "106.reply.json"), old, old);
    const asks = readAsks(configDir);
    expect(asks.map((a) => [path.basename(a.file), a.sessionId, a.tool])).toEqual([
      ["101.json", "s1", "AskUserQuestion"],
      ["102.json", "s2", "Bash"],
    ]);
    expect(fs.existsSync(path.join(folder, "105.json"))).toBe(false);
    expect(fs.existsSync(path.join(folder, "106.reply.json"))).toBe(false);
    // A part being written is fresh: left to its hook.
    expect(fs.existsSync(path.join(folder, "103.json.part"))).toBe(true);
  });

  it("finds none while the hook is off", () => {
    expect(readAsks(configDir)).toEqual([]);
  });
});

describe("decisionFor", () => {
  const panelAsk = (raw: ReturnType<typeof ask>): PanelAsk => ({ file: "/x/1.json", sessionId: raw.session_id, tool: raw.tool_name, input: raw.tool_input as Record<string, unknown> });

  it("answers a question with its option's own words, the rest of the call kept", () => {
    const out = JSON.parse(decisionFor(panelAsk(ask()), { kind: "option", index: 1, count: 2 })!);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { ...ask().tool_input, answers: { "Pick a colour?": "Blue" } } },
      },
    });
  });

  it("allows a call, or refuses it and stops the turn, as Esc does in a terminal", () => {
    const bash = panelAsk(ask({ tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(JSON.parse(decisionFor(bash, { kind: "yes" })!).hookSpecificOutput.decision).toEqual({ behavior: "allow" });
    expect(JSON.parse(decisionFor(bash, { kind: "no" })!).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: REFUSED, interrupt: true });
  });

  it("gives no answer the prompt does not offer", () => {
    // The card showed another number of options: not the same question.
    expect(decisionFor(panelAsk(ask()), { kind: "option", index: 1, count: 3 })).toBeUndefined();
    expect(decisionFor(panelAsk(ask()), { kind: "option", index: 2, count: 2 })).toBeUndefined();
    expect(decisionFor(panelAsk(ask()), { kind: "yes" })).toBeUndefined();
    const several = ask({ tool_input: { questions: [ask().tool_input.questions[0], ask().tool_input.questions[0]] } });
    expect(decisionFor(panelAsk(several), { kind: "option", index: 0, count: 2 })).toBeUndefined();
    const multi = ask({ tool_input: { questions: [{ ...ask().tool_input.questions[0], multiSelect: true }] } });
    expect(decisionFor(panelAsk(multi), { kind: "option", index: 0, count: 2 })).toBeUndefined();
    expect(decisionFor(panelAsk(ask({ tool_name: "Bash", tool_input: { command: "ls" } })), { kind: "option", index: 0, count: 2 })).toBeUndefined();
  });
});

/** Git for Windows' `sh`, which Claude Code runs hooks in there: started by a Windows program, it names no parent. */
const gitSh = "C:\\Program Files\\Git\\bin\\sh.exe";
const sh = posix ? "sh" : gitSh;

describe.runIf(posix || fs.existsSync(gitSh))("the hook script, run as Claude Code runs it", () => {
  const run = (env: Record<string, string>, input: string) => {
    const child = spawn(sh, ["-c", hookCommand(configDir)], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.end(input);
    const done = new Promise<{ code: number | null; out: string }>((resolve) => child.on("close", (code) => resolve({ code, out })));
    return { child, done };
  };
  const waitFor = async (test: () => boolean, tries = 100) => {
    for (let i = 0; i < tries && !test(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(test()).toBe(true);
  };
  const panel = { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" };

  it("hands the prompt to Lookout and prints Lookout's answer", async () => {
    installPromptHook(configDir);
    const { done } = run(panel, JSON.stringify(ask()));
    await waitFor(() => readAsks(configDir).length === 1);
    const [waiting] = readAsks(configDir);
    expect(waiting!.sessionId).toBe("s1");
    expect(replyToAsk(waiting!, decisionFor(waiting!, { kind: "option", index: 0, count: 2 })!)).toBe(true);
    const { code, out } = await done;
    expect(code).toBe(0);
    expect(JSON.parse(out).hookSpecificOutput.decision.updatedInput.answers).toEqual({ "Pick a colour?": "Red" });
    // It clears its files as it ends.
    expect(fs.readdirSync(asksFolder(configDir))).toEqual([]);
  }, 30_000);

  it("goes on waiting past its first look for Claude Code, in a shell that names no parent too", async () => {
    installPromptHook(configDir);
    const { done } = run(panel, JSON.stringify(ask()));
    await waitFor(() => readAsks(configDir).length === 1);
    const [waiting] = readAsks(configDir);
    // It marks its prompt right after that look: a prompt marked again is of a hook that went on.
    const written = fs.statSync(waiting!.file).mtimeMs;
    await waitFor(() => fs.existsSync(waiting!.file) && fs.statSync(waiting!.file).mtimeMs > written, 400);
    expect(replyToAsk(waiting!, decisionFor(waiting!, { kind: "option", index: 1, count: 2 })!)).toBe(true);
    const { code, out } = await done;
    expect(code).toBe(0);
    expect(JSON.parse(out).hookSpecificOutput.decision.updatedInput.answers).toEqual({ "Pick a colour?": "Blue" });
  }, 60_000);

  it.runIf(posix)("keeps its prompt to the user alone", async () => {
    installPromptHook(configDir);
    const { child, done } = run(panel, JSON.stringify(ask()));
    await waitFor(() => readAsks(configDir).length === 1);
    expect(fs.statSync(readAsks(configDir)[0]!.file).mode & 0o777).toBe(0o600);
    child.kill("SIGTERM");
    await done;
  }, 30_000);

  it.runIf(posix)("does not take an answer left for an earlier hook that had its process id", async () => {
    installPromptHook(configDir);
    // Every process id the hook can get holds an answer nobody read.
    const child = spawn(sh, ["-c", `for f in $(seq 1 99999); do :; done; ${hookCommand(configDir)}`], { env: { ...process.env, ...panel } });
    fs.writeFileSync(path.join(asksFolder(configDir), `${child.pid}.reply.json`), `${decisionFor({ file: "", sessionId: "s0", tool: "Bash", input: {} }, { kind: "yes" })}\n`);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.end(JSON.stringify(ask()));
    await waitFor(() => readAsks(configDir).length === 1, 400);
    expect(fs.existsSync(path.join(asksFolder(configDir), `${child.pid}.reply.json`))).toBe(false);
    expect(out).toBe("");
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("close", resolve));
  }, 30_000);

  it("ends at once, answering nothing, outside the panel or with no Lookout window open", async () => {
    installPromptHook(configDir);
    expect(await run({ CLAUDE_CODE_ENTRYPOINT: "cli" }, JSON.stringify(ask())).done).toEqual({ code: 0, out: "" });
    markAlive(configDir, Date.now() - 5 * 60_000);
    expect(await run(panel, JSON.stringify(ask())).done).toEqual({ code: 0, out: "" });
    expect(fs.readdirSync(asksFolder(configDir))).toEqual([]);
  }, 30_000);

  it.runIf(posix)("clears its prompt when Claude Code ends it because the panel answered first", async () => {
    installPromptHook(configDir);
    const { child, done } = run(panel, JSON.stringify(ask()));
    await waitFor(() => readAsks(configDir).length === 1);
    // The command became the script: ending the hook's process ends it.
    child.kill("SIGTERM");
    await done;
    await waitFor(() => fs.readdirSync(asksFolder(configDir)).length === 0);
  }, 30_000);

  it("ends when Lookout turns the hook off while it waits", async () => {
    installPromptHook(configDir);
    const { done } = run(panel, JSON.stringify(ask()));
    await waitFor(() => readAsks(configDir).length === 1);
    removePromptHook(configDir);
    expect(await done).toEqual({ code: 0, out: "" });
  }, 30_000);

  it("ends when the last Lookout window has gone while it waits", async () => {
    installPromptHook(configDir);
    const { done } = run(panel, JSON.stringify(ask()));
    await waitFor(() => readAsks(configDir).length === 1);
    markAlive(configDir, Date.now() - 5 * 60_000);
    expect(await done).toEqual({ code: 0, out: "" });
    expect(fs.readdirSync(asksFolder(configDir))).toEqual([]);
  }, 90_000);
});
