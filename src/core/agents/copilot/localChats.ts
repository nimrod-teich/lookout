// VS Code's Local chats, the "Local" session type of its Chat view, where
// Copilot runs inside VS Code: one log per chat in
// `<user data>/User/workspaceStorage/<workspace id>/chatSessions/<id>.jsonl`
// (see `chatLog.ts`), on the side of VS Code that shows the window (under WSL,
// Windows). A chat's last request says what it does:
//
// - `modelState.value` 0: an answer is being made (working); 4: it waits for
//   the user, a tool call with no `isConfirmed` in its `response` saying what
//   for (`toolSpecificData.commandLine.original` for a terminal command); 1
//   done, 2 cancelled, 3 failed.
// - `message.text` is what you wrote; the `response` parts with a string
//   `value` and no `kind` are what Copilot answered.
//
// The chat's folder is its workspace's, from `workspace.json` beside
// `chatSessions`.
import * as fs from "node:fs";
import * as path from "node:path";
import { quoteAsk } from "../../asks";
import { HistoryIndex, type HistoryMessage } from "../../history";
import type { Reason } from "../../types";
import { applyChatLine, type ChatLog } from "./chatLog";

const TITLE_MAX = 60;
/** A request left pending this long is a window that went away mid-answer, not one still answering. */
const LIVE_MS = 2 * 3_600_000;
/** The chat folders are looked through again at most this often. */
const SCAN_MS = 15_000;

export type ChatState = "working" | "waiting" | "idle";

/** A Local chat, as its log says now. */
export interface LocalChat {
  id: string;
  file: string;
  /** Its workspace's folder, or "" when unknown. */
  cwd: string;
  title: string;
  state: ChatState;
  /** What it waits on, while it waits. */
  reason?: Reason;
  /** Epoch ms its last request was made. */
  since?: number;
  model?: string;
  /** Epoch ms the log was last written. */
  mtimeMs: number;
  messages: HistoryMessage[];
}

/** VS Code's address for a Local chat: its editor opens it there. */
export function localChatAddress(id: string): string {
  return `vscode-chat-session://local/${Buffer.from(id, "utf8").toString("base64url")}`;
}

type Json = unknown;
const obj = (value: Json): Record<string, Json> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {});
const arr = (value: Json): Json[] => (Array.isArray(value) ? value : []);
const str = (value: Json): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: Json): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** "Running `npm test`" → "npm test". */
function commandIn(message: string): string {
  return /`\s*([^`]+?)\s*`/.exec(message)?.[1] ?? message;
}

/** What a request waits on: its newest tool call not yet confirmed. */
function waitOf(request: Record<string, Json>): Reason {
  const calls = arr(request.response).map(obj).filter((part) => part.kind === "toolInvocationSerialized" && part.isConfirmed === undefined);
  const call = calls.at(-1);
  if (!call) return { kind: "dialog", ask: "a confirmation", raw: "confirmation" };
  const message = str(obj(call.invocationMessage).value) ?? str(call.invocationMessage);
  const command = str(obj(obj(call.toolSpecificData).commandLine).original);
  const ask = command ?? (message ? commandIn(message) : str(call.toolId) ?? "a tool");
  return { kind: "permission", ask: quoteAsk(ask), raw: message ? quoteAsk(message) : undefined };
}

/** The chat a log holds, or nothing when it has no request. */
export function chatOf(log: ChatLog, file: string, mtimeMs: number, cwd: string, now: number): LocalChat | undefined {
  const root = log.root;
  const id = str(root?.sessionId);
  const requests = arr(root?.requests).map(obj);
  if (!id || requests.length === 0) return undefined;
  const messages: HistoryMessage[] = [];
  for (const request of requests) {
    const at = num(request.timestamp);
    const asked = str(obj(request.message).text)?.trim();
    if (asked) messages.push({ role: "you", at, text: asked });
    const answer = arr(request.response)
      .map(obj)
      .filter((part) => part.kind === undefined && typeof part.value === "string")
      .map((part) => (part.value as string).trim())
      .filter(Boolean)
      .join("\n\n");
    if (answer) messages.push({ role: "agent", at: num(obj(request.modelState).completedAt) ?? at, text: answer });
  }
  const last = requests.at(-1)!;
  const value = num(obj(last.modelState).value);
  const fresh = now - mtimeMs <= LIVE_MS;
  const state: ChatState = fresh && value === 4 ? "waiting" : fresh && value === 0 ? "working" : "idle";
  // The model "auto" picked for the newest request that says.
  const resolved = requests
    .flatMap((request) => arr(request.response).map(obj))
    .filter((part) => part.kind === "autoModeResolution")
    .at(-1);
  const model = str(obj(resolved?.resolved).id) ?? str(last.modelId)?.replace(/^copilot\//, "");
  const first = messages.find((message) => message.role === "you")?.text;
  const title = str(root?.customTitle) ?? (first ? quoteAsk(first, TITLE_MAX) : "Chat");
  return { id, file, cwd, title, state, reason: state === "waiting" ? waitOf(last) : undefined, since: num(last.timestamp), model, mtimeMs, messages };
}

/** A workspace's folder from its `workspace.json`: `folder`, or the folder of a `.code-workspace` file. */
export function workspaceFolderOf(text: string): string | undefined {
  let raw: { folder?: unknown; workspace?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    return undefined;
  }
  const uri = typeof raw.folder === "string" ? raw.folder : typeof raw.workspace === "string" ? raw.workspace : undefined;
  if (!uri) return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(uri).pathname);
  } catch {
    return undefined;
  }
  // A Windows drive: "/c:/Users/x".
  if (/^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1);
  return typeof raw.workspace === "string" ? path.posix.dirname(pathname) : pathname.replace(/\/+$/, "") || "/";
}

/**
 * Where VS Code may keep its workspaces' storage: beside the extension's
 * global storage, and under WSL on the Windows side too, where VS Code shows
 * a WSL window. Only folders that exist are returned.
 */
export function chatStorageRoots(globalStorageDir: string, platform: string = process.platform, mounts = "/mnt"): string[] {
  const out = [path.resolve(globalStorageDir, "..", "workspaceStorage")];
  if (platform === "linux") {
    for (const drive of safeReaddir(mounts)) {
      const users = path.join(mounts, drive, "Users");
      for (const user of safeReaddir(users)) {
        const roaming = path.join(users, user, "AppData", "Roaming");
        for (const code of safeReaddir(roaming)) {
          if (code === "Code" || code.startsWith("Code - ")) out.push(path.join(roaming, code, "User", "workspaceStorage"));
        }
      }
    }
  }
  return out.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

interface Read {
  mtimeMs: number;
  size: number;
  log: ChatLog;
}

/** The messages of a Local chat, from its log replayed, for the search and the conversation tab. */
export class ChatLogIndex extends HistoryIndex {
  /** The log's mtime when the messages were taken; empty before. */
  private takenAt = "";

  constructor(
    private readonly chatFile: string,
    private readonly chats: LocalChats,
  ) {
    super(chatFile, () => undefined);
  }

  override get ready(): boolean {
    return this.takenAt !== "";
  }

  override refresh(): void {
    const chat = this.chats.byFile(this.chatFile);
    if (!chat) return;
    const takenAt = `${chat.mtimeMs}`;
    if (takenAt === this.takenAt) return;
    this.takenAt = takenAt;
    this.messages.length = 0;
    this.messages.push(...chat.messages);
  }
}

/**
 * Every Local chat of the workspaces whose storage is under `roots`, read
 * again when its log changes. The storage can be across the WSL boundary,
 * where a look takes up to a second, so looks run in the background, at most
 * every 15 seconds, and `list` gives the last one.
 */
export class LocalChats {
  /** Set by the owner to learn that a look found something new. */
  onDidUpdate?: () => void;
  private readonly reads = new Map<string, Read>();
  private readonly folders = new Map<string, string>();
  private scanned: { at: number; chats: LocalChat[] } | undefined;
  private scanning: Promise<void> | undefined;
  private lookedAt = -Infinity;

  constructor(
    private readonly roots: () => readonly string[],
    private readonly now: () => number = Date.now,
  ) {}

  /** Every chat with a request, newest first, as last looked; starts a new look when the last is 15 seconds old. */
  list(): LocalChat[] {
    if (this.now() - this.lookedAt >= SCAN_MS) void this.refresh();
    return this.scanned?.chats ?? [];
  }

  /** The chat of a log, as last listed. */
  byFile(file: string): LocalChat | undefined {
    return this.scanned?.chats.find((chat) => chat.file === file);
  }

  /** Looks through the chat folders now, unless a look runs. */
  refresh(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.lookedAt = this.now();
    this.scanning = this.look()
      .then((chats) => {
        const before = JSON.stringify(this.scanned?.chats.map((chat) => [chat.file, chat.mtimeMs, chat.state]));
        this.scanned = { at: this.now(), chats };
        if (JSON.stringify(chats.map((chat) => [chat.file, chat.mtimeMs, chat.state])) !== before) this.onDidUpdate?.();
      })
      .catch(() => {
        // Nothing read: the last look stands.
      })
      .finally(() => {
        this.scanning = undefined;
      });
    return this.scanning;
  }

  private async look(): Promise<LocalChat[]> {
    const now = this.now();
    const chats: LocalChat[] = [];
    const seen = new Set<string>();
    for (const root of this.roots()) {
      for (const workspace of await readdir(root)) {
        const dir = path.join(root, workspace, "chatSessions");
        const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
        if (names.length === 0) continue;
        const cwd = await this.folderOf(path.join(root, workspace));
        for (const name of names) {
          const file = path.join(dir, name);
          seen.add(file);
          const read = await this.read(file);
          const chat = read && chatOf(read.log, file, read.mtimeMs, cwd, now);
          if (chat) chats.push(chat);
        }
      }
    }
    for (const file of [...this.reads.keys()]) if (!seen.has(file)) this.reads.delete(file);
    return chats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private async read(file: string): Promise<Read | undefined> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      return undefined;
    }
    const cached = this.reads.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch {
      return cached;
    }
    const log: ChatLog = {};
    for (const line of text.split("\n")) applyChatLine(log, line);
    const read = { mtimeMs: st.mtimeMs, size: st.size, log };
    this.reads.set(file, read);
    return read;
  }

  private async folderOf(workspaceDir: string): Promise<string> {
    let folder = this.folders.get(workspaceDir);
    if (folder === undefined) {
      try {
        folder = workspaceFolderOf(await fs.promises.readFile(path.join(workspaceDir, "workspace.json"), "utf8")) ?? "";
      } catch {
        folder = "";
      }
      this.folders.set(workspaceDir, folder);
    }
    return folder;
  }
}

async function readdir(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}
