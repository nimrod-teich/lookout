import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDir } from "../../src/core/agents/claude/paths";
import { PENDING_TABS_KEY, type PendingTab } from "../../src/core/transfer/types";
import { registerPendingTabs, REOPEN_TABS } from "../../src/vscode/pendingTabs";
import { tempConfigDir, transcriptPath } from "../core/helpers";
import { fakeLog, settle } from "./helpers";
import { env, stub, workspace } from "./stub-vscode";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const D = "00000000-0000-4000-8000-00000000000d";
const CLAUDE_OPEN = "claude-vscode.editor.open";
const PACE = { waitMs: 50, gapMs: 0 };

/** The globalState of one window: each window keeps its own copy of what all of them share. */
class Memento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  pending(): string[] {
    return ((this.values.get(PENDING_TABS_KEY) as PendingTab[] | undefined) ?? []).map((tab) => tab.sessionId);
  }
}

function tab(sessionId: string, cwd: string, title: string, from = "laptop"): PendingTab {
  return { sessionId, title, cwd, from, madeAt: 1_700_000_000_000 };
}

let storage: string;
/** Session ids Claude Code was asked to open, in order. */
let opened: string[];
/** The Claude Code config directories of this machine. */
let claudeDirs: ClaudeDir[];

/** A Claude Code config directory holding the transcripts of these sessions, under the project folder Claude Code names after `cwd`. */
function claudeDir(label: string, sessions: string[], cwd = "/work/app"): ClaudeDir {
  const dir = tempConfigDir();
  for (const id of sessions) fs.writeFileSync(transcriptPath(dir, cwd, id), "{}\n");
  return { dir, resolved: dir, label, isDefault: label === "default" };
}

function window(state: Memento) {
  const log = fakeLog();
  const disposable = registerPendingTabs({ globalState: state, globalStorageUri: { fsPath: storage }, subscriptions: [] } as never, { log, claudeDirs: () => claudeDirs, pace: PACE });
  return { log, disposable };
}

function openFolder(folder: string | undefined): void {
  workspace.workspaceFolders = folder === undefined ? undefined : [{ uri: { fsPath: folder, scheme: "file" } }];
}

function messages(kind: "info" | "warning"): string[] {
  return stub.ops.filter(([target, action]) => target === "window" && action === kind).map(([, , message]) => message as string);
}

function claudeOpens(): unknown[][] {
  return stub.ops.filter(([target, action]) => target === "commands" && action === CLAUDE_OPEN).map(([, , args]) => args as unknown[]);
}

beforeEach(() => {
  stub.reset();
  storage = path.join(tempConfigDir(), "global-storage");
  opened = [];
  // Every session's transcript is on this machine, the last one under a second account's directory.
  claudeDirs = [claudeDir("default", [A, B, C]), claudeDir("work", [D], "/somewhere/else")];
  openFolder("/work/app");
  stub.extension = { extensionPath: "/extensions/anthropic.claude-code" };
  // Claude Code opens the tab, and the editor tabs change.
  stub.commands.set(CLAUDE_OPEN, (id) => {
    opened.push(id as string);
    stub.focusChange.fire();
  });
});

describe("the offer to reopen a backup's tabs", () => {
  it("offers the tabs whose session worked in this window's first folder, and reopens them in order through Claude Code", async () => {
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app/", "Wire the cache"), tab(B, "/work/api", "Add the route"), tab(C, "/work/app", "Fix the build")]);
    stub.notificationAnswer = "Reopen";
    window(state);
    await vi.waitFor(() => expect(opened).toEqual([A, C]));
    expect(messages("info")).toEqual(["Lookout: 2 Claude tabs from laptop belong in this window."]);
    // In an editor tab, never the sidebar, as Lookout resumes a session.
    expect(claudeOpens()).toEqual([
      [A, undefined, undefined, undefined, undefined, { programmatic: "pin-to-panel" }],
      [C, undefined, undefined, undefined, undefined, { programmatic: "pin-to-panel" }],
    ]);
    expect(state.pending()).toEqual([B]);
    expect(fs.readdirSync(path.join(storage, "tab-claims")).sort()).toEqual([`${A}-1700000000000`, `${C}-1700000000000`]);
  });

  it("forgets the tabs when told to", async () => {
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache", "desktop"), tab(B, "/work/api", "Add the route")]);
    stub.notificationAnswer = "Forget";
    window(state);
    await vi.waitFor(() => expect(state.pending()).toEqual([B]));
    expect(messages("info")).toEqual(["Lookout: 1 Claude tab from desktop belongs in this window."]);
    expect(opened).toEqual([]);
  });

  it("puts the tabs off until the window reloads, and offers a tab added since", async () => {
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache")]);
    stub.notificationAnswer = "Later";
    window(state);
    await settle();
    expect(messages("info")).toHaveLength(1);
    stub.foldersChange.fire();
    stub.focusChange.fire();
    await settle();
    expect(messages("info")).toHaveLength(1);
    expect(state.pending()).toEqual([A]);
    // A restore in another window added one.
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache"), tab(D, "/work/app", "Ship it", "desktop")]);
    stub.focusChange.fire();
    await settle();
    expect(messages("info")).toEqual(["Lookout: 1 Claude tab from laptop belongs in this window.", "Lookout: 1 Claude tab from desktop belongs in this window."]);
    expect(opened).toEqual([]);
  });

  it("offers nothing in a window of another folder or of none, nor without Claude Code, until that changes", async () => {
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache")]);
    stub.notificationAnswer = "Reopen";
    openFolder("/work/application");
    window(state);
    await settle();
    openFolder(undefined);
    stub.foldersChange.fire();
    await settle();
    stub.extension = undefined;
    openFolder("/work/app");
    stub.foldersChange.fire();
    await settle();
    expect(messages("info")).toEqual([]);
    stub.extension = { extensionPath: "/extensions/anthropic.claude-code" };
    stub.foldersChange.fire();
    await vi.waitFor(() => expect(opened).toEqual([A]));
  });

  it("lets only one of two windows open a tab both still list", async () => {
    // The second window's copy of the shared state has not caught up with the first's claim.
    const first = new Memento();
    const second = new Memento();
    for (const state of [first, second]) await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache"), tab(B, "/work/app", "Fix the build")]);
    stub.notificationAnswer = "Reopen";
    window(first);
    window(second);
    await vi.waitFor(() => expect(opened).toEqual([A, B]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(opened).toEqual([A, B]);
    expect(first.pending()).toEqual([]);
    expect(second.pending()).toEqual([]);
  });

  it("opens the other tabs when one fails, keeps the failed one for later and says so", async () => {
    stub.commands.set(CLAUDE_OPEN, (id) => {
      if (id === B) throw new Error("webview failed");
      opened.push(id as string);
      stub.focusChange.fire();
    });
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache"), tab(B, "/work/app", "Fix the build"), tab(C, "/work/app", "Ship it")]);
    stub.notificationAnswer = "Reopen";
    const { log } = window(state);
    await vi.waitFor(() => expect(messages("warning")).toEqual(['Lookout could not reopen "Fix the build". It waits under Reopen Tabs from Backup.']));
    expect(opened).toEqual([A, C]);
    expect(state.pending()).toEqual([B]);
    expect(log.errors.join("\n")).toContain("webview failed");
    // Not offered again in this window; the list still has it, and can open it once more.
    stub.foldersChange.fire();
    await settle();
    expect(messages("info")).toHaveLength(1);
    expect(fs.readdirSync(path.join(storage, "tab-claims")).sort()).toEqual([`${A}-1700000000000`, `${C}-1700000000000`]);
  });
});

describe("tabs whose conversation is not on this machine yet", () => {
  it("offers only the tabs whose transcript is here, and offers the others once theirs arrive", async () => {
    claudeDirs = [claudeDir("default", [A])];
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache"), tab(C, "/work/app", "Fix the build")]);
    stub.notificationAnswer = "Reopen";
    window(state);
    await vi.waitFor(() => expect(opened).toEqual([A]));
    expect(messages("info")).toEqual(["Lookout: 1 Claude tab from laptop belongs in this window."]);
    expect(state.pending()).toEqual([C]);
    // A later restore brings its transcript, in another account's directory.
    claudeDirs.push(claudeDir("work", [C], "/old/place"));
    stub.focusChange.fire();
    await vi.waitFor(() => expect(opened).toEqual([A, C]));
    expect(state.pending()).toEqual([]);
  });

  it("keeps a tab picked to reopen on the list, unclaimed, and says it cannot be opened yet", async () => {
    claudeDirs = [claudeDir("default", [A])];
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache"), tab(B, "/work/app", "Fix the build")]);
    stub.notificationAnswer = "Later";
    window(state);
    await settle();
    let listed: { label: string; detail: string; picked: boolean }[] = [];
    stub.quickPick = (items) => {
      listed = items as typeof listed;
      return items;
    };
    await stub.commands.get(REOPEN_TABS)!();
    expect(listed.map(({ label, detail, picked }) => ({ label, detail, picked }))).toEqual([
      { label: "Wire the cache", detail: "This window · from laptop", picked: true },
      { label: "Fix the build", detail: "This window · its conversation is not on this machine yet · from laptop", picked: false },
    ]);
    await vi.waitFor(() => expect(messages("warning")).toEqual(['Lookout cannot reopen "Fix the build" yet: its conversation is not on this machine. It waits under Reopen Tabs from Backup.']));
    expect(opened).toEqual([A]);
    expect(state.pending()).toEqual([B]);
    expect(fs.readdirSync(path.join(storage, "tab-claims"))).toEqual([`${A}-1700000000000`]);
  });
});

describe("text from a backup in a message", () => {
  it("never reaches a notification as a link, nor on more than one line", async () => {
    const link = "[Update](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22curl%20x%7Csh%5Cn%22%7D)";
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", `Wire ${link}`, `laptop\n${link}`), tab(B, `/nowhere/${link}`, `Gone ${link}`)]);
    stub.commands.set(CLAUDE_OPEN, () => {
      throw new Error("webview failed");
    });
    stub.notificationAnswer = "Reopen";
    window(state);
    await vi.waitFor(() => expect(messages("warning")).toHaveLength(1));
    stub.quickPick = (items) => (items as { tab: PendingTab }[]).filter((item) => item.tab.sessionId === B);
    await stub.commands.get(REOPEN_TABS)!();
    const shown = [...messages("info"), ...messages("warning")];
    expect(shown).toHaveLength(3);
    for (const message of shown) {
      expect(message).not.toMatch(/\]\(command:/);
      expect(message).not.toMatch(/\n/);
    }
    const plain = "[Update] (command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22curl%20x%7Csh%5Cn%22%7D)";
    expect(shown).toEqual([
      `Lookout: 1 Claude tab from laptop ${plain} belongs in this window.`,
      `Lookout could not reopen "Wire ${plain}". It waits under Reopen Tabs from Backup.`,
      `Lookout: "Gone ${plain}" worked in /nowhere/${plain}, which is not on this machine. Choose the folder it works in here, or forget it.`,
    ]);
  });
});

describe("Reopen Tabs from Backup", () => {
  it("lists every pending tab, this window's first and picked, and reopens the ones picked here", async () => {
    const other = fs.realpathSync(tempConfigDir());
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(B, other, "Add the route"), tab(A, "/work/app", "Wire the cache"), tab(C, "/nowhere/gone", "")]);
    window(state);
    await settle();
    let listed: { label: string; description: string; detail: string; picked: boolean }[] = [];
    stub.quickPick = (items) => {
      listed = items as typeof listed;
      return items;
    };
    stub.commands.set("vscode.openFolder", () => undefined);
    stub.notificationAnswer = "Open in New Window";
    await stub.commands.get(REOPEN_TABS)!();
    expect(listed.map(({ label, description, detail, picked }) => ({ label, description, detail, picked }))).toEqual([
      { label: "Wire the cache", description: "/work/app", detail: "This window · from laptop", picked: true },
      { label: "Session 00000000", description: "/nowhere/gone", detail: "Its folder is not on this machine: you choose where it works · from laptop", picked: false },
      { label: "Add the route", description: other, detail: "Opens its folder in a new window · from laptop", picked: false },
    ]);
    expect(opened).toEqual([A]);
    // Another folder opens in a window of its own, which offers its tabs.
    expect(messages("info").at(-1)).toBe(`Lookout: 1 tab belongs in a window on ${other}, which offers to reopen it there.`);
    expect(stub.ops.find(([target, action]) => target === "commands" && action === "vscode.openFolder")?.[2]).toEqual([expect.objectContaining({ fsPath: other }), { forceNewWindow: true }]);
    expect(messages("warning")).toEqual(['Lookout: "Session 00000000" worked in /nowhere/gone, which is not on this machine. Choose the folder it works in here, or forget it.']);
    expect(state.pending()).toEqual([B, C]);

    // The tab of a folder this machine lacks can be forgotten from the list.
    stub.quickPick = (items) => (items as { tab: PendingTab }[]).filter((item) => item.tab.sessionId === C);
    stub.notificationAnswer = "Forget";
    await stub.commands.get(REOPEN_TABS)!();
    expect(state.pending()).toEqual([B]);
    expect(opened).toEqual([A]);
  });

  it("opens another folder on this window's remote, and only names it in a remote window with no folder", async () => {
    const other = fs.realpathSync(tempConfigDir());
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(B, other, "Add the route")]);
    stub.commands.set("vscode.openFolder", () => undefined);
    stub.quickPick = (items) => items;
    stub.notificationAnswer = "Open in New Window";
    const remote = { scheme: "vscode-remote", fsPath: "/work/app", with: (change: { path: string }) => ({ scheme: "vscode-remote", authority: "wsl+ubuntu", path: change.path }) };
    workspace.workspaceFolders = [{ uri: remote }];
    env.remoteName = "wsl";
    try {
      window(state);
      await stub.commands.get(REOPEN_TABS)!();
      expect(stub.ops.find(([target, action]) => target === "commands" && action === "vscode.openFolder")?.[2]).toEqual([{ scheme: "vscode-remote", authority: "wsl+ubuntu", path: other }, { forceNewWindow: true }]);
      stub.ops.length = 0;
      openFolder(undefined);
      await stub.commands.get(REOPEN_TABS)!();
      expect(messages("info")).toEqual([`Lookout: 1 tab belongs in a window on ${other}. Open it in a window, which offers to reopen it there.`]);
      expect(stub.ops.some(([target, action]) => target === "commands" && action === "vscode.openFolder")).toBe(false);
      expect(state.pending()).toEqual([B]);
    } finally {
      env.remoteName = undefined;
    }
  });

  it("says when no tab waits, and keeps this window's tabs while Claude Code is missing", async () => {
    const state = new Memento();
    stub.extension = undefined;
    window(state);
    await stub.commands.get(REOPEN_TABS)!();
    expect(messages("info")).toEqual(["Lookout: no Claude tabs from a backup wait to be reopened."]);
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache")]);
    stub.quickPick = (items) => items;
    await stub.commands.get(REOPEN_TABS)!();
    expect(messages("warning")).toEqual(["Lookout cannot reopen 1 Claude tab from laptop: Claude Code is not installed here. It waits until it is."]);
    expect(state.pending()).toEqual([A]);
    expect(opened).toEqual([]);
  });

  it("stops offering and listing once disposed", async () => {
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache")]);
    stub.notificationAnswer = "Later";
    const { disposable } = window(state);
    await settle();
    disposable.dispose();
    expect(stub.commands.has(REOPEN_TABS)).toBe(false);
    stub.notificationAnswer = "Reopen";
    stub.foldersChange.fire();
    await settle();
    expect(opened).toEqual([]);
  });
});

describe("tabs waiting elsewhere", () => {
  const ITEM = "statusBar:lookout.pendingTabs";
  const count = () => {
    const ops = stub.ops.filter(([target, action]) => target === ITEM && (action === "set:text" || action === "show" || action === "hide"));
    const last = ops.at(-1);
    if (!last || last[1] === "hide") return undefined;
    return ops.filter(([, action]) => action === "set:text").at(-1)?.[2];
  };

  it("counts the tabs that wait, in every window, whichever folder it has, and stops once none do", async () => {
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache"), tab(B, "/somewhere/else", "Add the route")]);
    openFolder("/not/theirs");
    window(state);
    await settle();
    expect(count()).toBe("$(history) 2");
    const command = stub.ops.find(([target, action]) => target === ITEM && action === "set:command")?.[2];
    expect(command).toBe(REOPEN_TABS);
    // Another window reopened them: this one learns it when it comes to the front.
    await state.update(PENDING_TABS_KEY, []);
    stub.focusChange.fire();
    await settle();
    expect(count()).toBeUndefined();
  });

  it("counts the tabs a restore in this window queued, with no change of focus or folder", async () => {
    const state = new Memento();
    openFolder("/not/theirs");
    const { disposable } = window(state);
    await settle();
    expect(count()).toBeUndefined();
    await state.update(PENDING_TABS_KEY, [tab(A, "/work/app", "Wire the cache")]);
    disposable.refresh();
    expect(count()).toBe("$(history) 1");
    // Counted only: the offer keeps to the window's own tabs, at its usual times.
    expect(messages("info")).toEqual([]);
  });

  it("says where tabs of a folder that is not here work instead, and offers them there", async () => {
    const state = new Memento();
    const gone = "/nowhere/gone";
    await state.update(PENDING_TABS_KEY, [tab(A, gone, "Wire the cache"), tab(B, gone, "Add the route"), tab(C, "/kept/apart", "Other")]);
    window(state);
    await settle();
    stub.quickPick = (items) => (items as { tab: PendingTab }[]).filter((item) => item.tab.cwd === gone);
    stub.openDialog = () => ["/work/app"];
    stub.answerNotice = (notice) => (notice.actions.includes("Choose Folder…") ? "Choose Folder…" : notice.actions.includes("Reopen") ? "Reopen" : undefined);
    await stub.commands.get(REOPEN_TABS)!();
    await settle();
    // Both tabs of the folder that is gone now work in this window's folder, and reopen here.
    expect(opened).toEqual([A, B]);
    expect(state.pending()).toEqual([C]);
    expect(stub.notices.find((notice) => notice.actions.includes("Choose Folder…"))?.message).toBe(
      'Lookout: "Wire the cache" and "Add the route" worked in /nowhere/gone, which is not on this machine. Choose the folder they work in here, or forget them.',
    );
  });

  it("moves the tabs to another folder chosen, for that folder's window to offer", async () => {
    const state = new Memento();
    const other = fs.realpathSync(tempConfigDir());
    await state.update(PENDING_TABS_KEY, [tab(A, "/nowhere/gone", "Wire the cache")]);
    window(state);
    await settle();
    stub.quickPick = (items) => items;
    stub.openDialog = () => [other];
    stub.commands.set("vscode.openFolder", () => undefined);
    stub.answerNotice = (notice) => (notice.actions.includes("Choose Folder…") ? "Choose Folder…" : notice.actions.includes("Open in New Window") ? "Open in New Window" : undefined);
    await stub.commands.get(REOPEN_TABS)!();
    await settle();
    expect((state.values.get(PENDING_TABS_KEY) as PendingTab[]).map((t) => t.cwd)).toEqual([other]);
    expect(stub.ops.find(([target, action]) => target === "commands" && action === "vscode.openFolder")?.[2]).toEqual([expect.objectContaining({ fsPath: other }), { forceNewWindow: true }]);
    expect(opened).toEqual([]);
  });

  it("leaves the tabs where they were when no folder is chosen", async () => {
    const state = new Memento();
    await state.update(PENDING_TABS_KEY, [tab(A, "/nowhere/gone", "Wire the cache")]);
    window(state);
    await settle();
    stub.quickPick = (items) => items;
    stub.openDialog = () => undefined;
    stub.notificationAnswer = "Choose Folder…";
    await stub.commands.get(REOPEN_TABS)!();
    expect((state.values.get(PENDING_TABS_KEY) as PendingTab[]).map((t) => t.cwd)).toEqual(["/nowhere/gone"]);
  });
});
