import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyChatLine, type ChatLog } from "../../../../src/core/agents/copilot/chatLog";
import { ChatLogIndex, chatOf, chatStorageRoots, localChatAddress, LocalChats, workspaceFolderOf } from "../../../../src/core/agents/copilot/localChats";

const NOW = Date.parse("2026-10-18T17:00:00.000Z");
const ID = "3246e7f2-6a68-4998-8595-bb1bb5280cdd";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const markdown = (value: string) => ({ value, supportThemeIcons: false, supportHtml: false });
const terminalCall = (command: string, confirmed?: { type: number }) => ({
  kind: "toolInvocationSerialized",
  toolId: "run_in_terminal",
  invocationMessage: markdown(`Running \` ${command}\``),
  ...(confirmed ? { isConfirmed: confirmed } : {}),
  isComplete: true,
  toolSpecificData: { kind: "terminal", commandLine: { original: command } },
});

/** A chat's log as VS Code writes it: the session, then changes. Its last request waits for approval. */
function waitingLog(): string[] {
  return [
    { kind: 0, v: { version: 3, creationDate: NOW - 600_000, sessionId: ID, requests: [] } },
    { kind: 2, k: ["requests"], v: [{ requestId: "r1", timestamp: NOW - 500_000, message: { text: "Run this command in the terminal: echo lookout-chat-test" }, modelState: { value: 0 }, response: [] }] },
    { kind: 2, k: ["requests", 0, "response"], v: [{ kind: "autoModeResolution", resolved: { id: "mai-code-1.1-flash" } }, markdown("I will run it."), terminalCall("echo lookout-chat-test", { type: 4 }), markdown("The command printed: lookout-chat-test")] },
    { kind: 1, k: ["requests", 0, "modelState"], v: { value: 1, completedAt: NOW - 480_000 } },
    { kind: 2, k: ["requests"], v: [{ requestId: "r2", timestamp: NOW - 60_000, message: { text: "Run this command in the terminal: touch lookout-chat-approval.txt" }, modelState: { value: 0 }, response: [] }] },
    { kind: 2, k: ["requests", 1, "response"], v: [markdown("I will create the file."), terminalCall("touch lookout-chat-approval.txt && ls -l lookout-chat-approval.txt")] },
    { kind: 1, k: ["requests", 1, "modelState"], v: { value: 4 } },
  ].map((change) => JSON.stringify(change));
}

function replay(lines: string[]): ChatLog {
  const log: ChatLog = {};
  for (const line of lines) applyChatLine(log, line);
  return log;
}

describe("a VS Code Local chat", () => {
  it("waits for you while its last request needs input, quoting the command its tool call asks to run", () => {
    const chat = chatOf(replay(waitingLog()), "/s/chatSessions/c.jsonl", NOW - 30_000, "/work/panel", NOW)!;
    expect(chat).toMatchObject({ id: ID, cwd: "/work/panel", state: "waiting", since: NOW - 60_000, model: "mai-code-1.1-flash", title: "Run this command in the terminal: echo lookout-chat-test" });
    expect(chat.reason).toEqual({ kind: "permission", ask: "touch lookout-chat-approval.txt && ls -l lookout-chat-approval.txt", raw: "Running touch lookout-chat-approval.txt && ls -l lookout-chat-approval.txt" });
    expect(chat.messages.map((m) => [m.role, m.text])).toEqual([
      ["you", "Run this command in the terminal: echo lookout-chat-test"],
      ["agent", "I will run it.\n\nThe command printed: lookout-chat-test"],
      ["you", "Run this command in the terminal: touch lookout-chat-approval.txt"],
      ["agent", "I will create the file."],
    ]);
  });

  it("works while an answer is being made, is idle once done, and counts a request left pending for hours as gone", () => {
    const lines = waitingLog();
    const working = [...lines.slice(0, -1)];
    expect(chatOf(replay(working), "f", NOW - 30_000, "", NOW)?.state).toBe("working");
    const done = [...lines.slice(0, -1), JSON.stringify({ kind: 1, k: ["requests", 1, "modelState"], v: { value: 2, completedAt: NOW } })];
    expect(chatOf(replay(done), "f", NOW, "", NOW)).toMatchObject({ state: "idle", reason: undefined });
    expect(chatOf(replay(lines), "f", NOW - 3 * 3_600_000, "", NOW)?.state).toBe("idle");
    // A titled chat keeps VS Code's title; a chat with no request is no chat.
    expect(chatOf(replay([...lines, JSON.stringify({ kind: 1, k: ["customTitle"], v: "Create the file" })]), "f", NOW, "", NOW)?.title).toBe("Create the file");
    expect(chatOf(replay(lines.slice(0, 1)), "f", NOW, "", NOW)).toBeUndefined();
  });

  it("has VS Code's address, the id in base64url", () => {
    expect(localChatAddress(ID)).toBe("vscode-chat-session://local/MzI0NmU3ZjItNmE2OC00OTk4LTg1OTUtYmIxYmI1MjgwY2Rk");
  });

  it("takes its folder from its workspace: a WSL folder, a Windows folder, a workspace file's folder", () => {
    expect(workspaceFolderOf('{"folder":"vscode-remote://wsl%2Bubuntu-22.04/home/user/scratch/panel"}')).toBe("/home/user/scratch/panel");
    expect(workspaceFolderOf('{"folder":"file:///c%3A/Users/u/app"}')).toBe("c:/Users/u/app");
    expect(workspaceFolderOf('{"workspace":"vscode-remote://wsl%2Bubuntu-22.04/home/user/lava.code-workspace"}')).toBe("/home/user");
    expect(workspaceFolderOf("not json")).toBeUndefined();
    expect(workspaceFolderOf("{}")).toBeUndefined();
  });
});

describe("VS Code's Local chats on disk", () => {
  /** A workspace storage folder with one workspace and its chats. */
  function storage(chats: Record<string, string[]>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-chats-"));
    dirs.push(root);
    const workspace = path.join(root, "96b9fa1571773ce0d8a5b7199a4fdca8");
    fs.mkdirSync(path.join(workspace, "chatSessions"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "workspace.json"), '{"folder":"vscode-remote://wsl%2Bubuntu-22.04/work/panel"}');
    for (const [name, lines] of Object.entries(chats)) fs.writeFileSync(path.join(workspace, "chatSessions", name), lines.join("\n") + "\n");
    return root;
  }

  it("looks through the chats in the background and lists those with a request, newest first, read again when changed", async () => {
    const root = storage({ "c.jsonl": waitingLog(), "empty.jsonl": [JSON.stringify({ kind: 0, v: { sessionId: "e", requests: [] } })] });
    let now = Date.now();
    const chats = new LocalChats(() => [root], () => now);
    const updates: number[] = [];
    chats.onDidUpdate = () => updates.push(now);
    expect(chats.list()).toEqual([]);
    await chats.refresh();
    expect(chats.list().map((chat) => [chat.id, chat.cwd, chat.state])).toEqual([[ID, "/work/panel", "waiting"]]);
    expect(updates.length).toBe(1);
    // Answered: read again on the next look.
    const file = path.join(root, "96b9fa1571773ce0d8a5b7199a4fdca8", "chatSessions", "c.jsonl");
    fs.appendFileSync(file, JSON.stringify({ kind: 1, k: ["requests", 1, "modelState"], v: { value: 1, completedAt: now } }) + "\n");
    now += 20_000;
    chats.list();
    await chats.refresh();
    expect(chats.list()[0]?.state).toBe("idle");
    const index = new ChatLogIndex(file, chats);
    expect(index.ready).toBe(false);
    index.refresh();
    expect(index.ready).toBe(true);
    expect(index.messages.map((m) => m.role)).toEqual(["you", "agent", "you", "agent"]);
  });

  it("finds the workspaces' storage beside the global storage and, under WSL, on the Windows side", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-roots-"));
    dirs.push(base);
    const user = path.join(base, "data", "User");
    fs.mkdirSync(path.join(user, "workspaceStorage"), { recursive: true });
    fs.mkdirSync(path.join(user, "globalStorage"), { recursive: true });
    const mounts = path.join(base, "mnt");
    const windows = path.join(mounts, "c", "Users", "u", "AppData", "Roaming");
    fs.mkdirSync(path.join(windows, "Code", "User", "workspaceStorage"), { recursive: true });
    fs.mkdirSync(path.join(windows, "Code - Insiders", "User"), { recursive: true });
    fs.mkdirSync(path.join(windows, "Slack"), { recursive: true });
    expect(chatStorageRoots(path.join(user, "globalStorage"), "linux", mounts)).toEqual([path.join(user, "workspaceStorage"), path.join(windows, "Code", "User", "workspaceStorage")]);
    expect(chatStorageRoots(path.join(user, "globalStorage"), "darwin", mounts)).toEqual([path.join(user, "workspaceStorage")]);
  });
});
