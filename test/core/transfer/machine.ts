// A made-up machine for the backup tests: two Claude config directories with
// sessions in a repository, one of its worktrees, a plain folder and a folder
// whose place is unknown, with the files a backup must leave out beside them;
// Lookout's history database, notes, kept transcripts, usage records and
// removed-worktrees log. Every byte is synthetic.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ClaudeDir } from "../../../src/core/agents/claude/paths";
import { encodeProjectDir } from "../../../src/core/agents/claude/paths";
import { CLAUDE_CODE } from "../../../src/core/agents/claude/provider";
import { SessionRecords } from "../../../src/core/sessionRecords";
import { ConversationStore } from "../../../src/core/store";
import type { InventorySources } from "../../../src/core/transfer/inventory";
import { TranscriptVault } from "../../../src/core/vault";
import { linkWorktree, sessionId, tempConfigDir } from "../helpers";

export const DAY = 24 * 60 * 60_000;
export const NOW = Date.UTC(2026, 10, 15, 12);

/** The sessions, by what each shows. */
export const S = {
  /** In the repository; its place only in its head, after a line without one and a subagent's line with another. */
  app: sessionId(1),
  /** In a worktree of the repository; its place only in the history database. */
  worktree: sessionId(2),
  /** In the repository's folder, with no place anywhere. */
  placeless: sessionId(3),
  /** In the second config directory, in a folder no session's place is known for. */
  lost: sessionId(4),
  /** The history database has it somewhere its folder is not named after; its head has the folder's place. */
  resumed: sessionId(5),
  /** The history database has it somewhere its folder is not named after; its head has no place. */
  moved: sessionId(6),
  /** Subagents and tool outputs left behind by a transcript that is gone. */
  orphan: sessionId(7),
} as const;

export interface Machine {
  root: string;
  dirs: ClaudeDir[];
  repo: string;
  worktree: string;
  tools: string;
  storeFile: string;
  /** Kept open, as another window keeps it, for the tests that write to it meanwhile. */
  store: ConversationStore | undefined;
  sources: InventorySources;
  /** A session's transcript, when it has one. */
  transcript(id: string): string;
  folderOf(cwd: string): string;
}

function write(file: string, text: string, mtime?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

function lines(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry) + "\n").join("");
}

export function buildMachine(): Machine {
  const root = fs.realpathSync.native(tempConfigDir());
  const repo = path.join(root, "repos", "app");
  const worktree = path.join(root, "repos", "app-wt", "feat");
  const tools = path.join(root, "repos", "tools");
  fs.mkdirSync(repo, { recursive: true });
  linkWorktree(repo, worktree);
  fs.mkdirSync(tools, { recursive: true });

  const main: ClaudeDir = { dir: path.join(root, "home", ".claude"), resolved: path.join(root, "home", ".claude"), label: "default", isDefault: true };
  const work: ClaudeDir = { dir: path.join(root, "claude-work"), resolved: path.join(root, "claude-work"), label: "work", isDefault: false };
  const projects = (dir: ClaudeDir) => path.join(dir.resolved, "projects");
  const appFolder = path.join(projects(main), encodeProjectDir(repo));
  const toolsFolder = path.join(projects(main), encodeProjectDir(tools));
  const worktreeFolder = path.join(projects(main), encodeProjectDir(worktree));
  const lostFolder = path.join(projects(work), "-gone-place");
  const transcripts = new Map<string, string>();
  const transcript = (folder: string, id: string, text: string, mtime: number) => transcripts.set(id, write(path.join(folder, `${id}.jsonl`), text, mtime));

  transcript(
    appFolder,
    S.app,
    lines({ type: "summary", summary: "earlier" }, { type: "user", isSidechain: true, cwd: "/elsewhere", message: { content: "sub" } }, { type: "user", isSidechain: false, cwd: repo, message: { content: "fix the build" } }, { type: "assistant", cwd: "/later", message: { content: "done" } }),
    NOW - 2 * DAY,
  );
  // A subagent's file older than its transcript: the transcript's time is the session's.
  write(path.join(appFolder, S.app, "subagents", "agent-a1.jsonl"), lines({ type: "user", isSidechain: true, cwd: repo }), NOW - 200 * DAY);
  write(path.join(appFolder, S.app, "tool-results", "toolu_1.txt"), "output one\n", NOW - 2 * DAY);
  write(path.join(appFolder, S.app, "tool-results", "deep", "toolu_2.txt"), "output two\n", NOW - 2 * DAY);
  // Never in a backup: anything else in a session's folder or a project folder, and Claude's memory.
  write(path.join(appFolder, S.app, "scratch", "x.txt"), "no\n");
  write(path.join(appFolder, "memory", "MEMORY.md"), "remember nothing\n");
  write(path.join(appFolder, "memory", S.app, "subagents", "a.jsonl"), "no\n");
  write(path.join(appFolder, "notes.txt"), "no\n");
  write(path.join(appFolder, "not-a-session.jsonl"), lines({ cwd: repo }));
  if (process.platform !== "win32") fs.symlinkSync(path.join(appFolder, "notes.txt"), path.join(appFolder, S.app, "tool-results", "link.txt"));

  transcript(appFolder, S.placeless, lines({ type: "summary", summary: "no place" }), NOW - 100 * DAY);
  write(path.join(appFolder, S.orphan, "subagents", "agent-o1.jsonl"), lines({ type: "user", isSidechain: true }), NOW - 50 * DAY);
  transcript(worktreeFolder, S.worktree, lines({ type: "summary", summary: "worktree" }), NOW - 10 * DAY);
  transcript(toolsFolder, S.resumed, lines({ type: "user", cwd: tools, message: { content: "hi" } }), NOW - 5 * DAY);
  transcript(toolsFolder, S.moved, lines({ type: "summary", summary: "moved" }), NOW - 40 * DAY);
  transcript(lostFolder, S.lost, lines({ type: "summary", summary: "lost" }), NOW - DAY);

  const storage = path.join(root, "storage");
  const storeFile = path.join(storage, "history.sqlite");
  const store = ConversationStore.open(storeFile);
  store?.rememberSessions([
    { id: S.worktree, agent: CLAUDE_CODE, file: transcripts.get(S.worktree)!, title: "worktree", cwd: worktree },
    { id: S.resumed, agent: CLAUDE_CODE, file: transcripts.get(S.resumed)!, title: "resumed", cwd: "/elsewhere/resumed" },
    { id: S.moved, agent: CLAUDE_CODE, file: transcripts.get(S.moved)!, title: "moved", cwd: path.join(root, "x", "moved") },
    // Another agent's session under a Claude session's id says nothing of it.
    { id: S.placeless, agent: "codex", file: "/codex/file.jsonl", title: "codex", cwd: "/codex/place" },
  ]);

  const recordsDir = path.join(storage, "sessions");
  new SessionRecords(recordsDir).addNote(S.app, "Remember the flaky test", { agent: CLAUDE_CODE, title: "fix the build", cwd: repo }, NOW - DAY);
  const vaultDir = path.join(storage, "vault");
  new TranscriptVault(vaultDir).keep(S.app, CLAUDE_CODE, transcripts.get(S.app)!, NOW - DAY);
  write(path.join(vaultDir, "half-written.json.123.1.tmp"), "{");
  const usageDir = path.join(storage, "usage");
  write(path.join(usageDir, "alerts", "five-hour-90"), "");
  write(path.join(usageDir, "refresh", "hold-default"), "123");
  const removedWorktreesFile = write(path.join(storage, "worktrees", "removed.json"), JSON.stringify([{ repo, path: path.join(root, "wt", "old"), removedAt: NOW - DAY }]));

  const sources: InventorySources = {
    claudeDirs: [main, work],
    storeFile,
    recordsDir,
    vaultDir,
    usageDir,
    removedWorktreesFile,
    state: { "lookout.favourites": [S.app], "lookout.sort": "recent", "lookout.group": undefined },
    tabs: [{ label: "app", folders: [repo], tabs: [{ sessionId: S.app, title: "fix the build" }] }],
    now: NOW,
  };
  return {
    root,
    dirs: [main, work],
    repo,
    worktree,
    tools,
    storeFile,
    store,
    sources,
    transcript: (id) => transcripts.get(id)!,
    folderOf: (cwd) => encodeProjectDir(cwd),
  };
}
