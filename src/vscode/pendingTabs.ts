// The Claude tabs a restore left to reopen: each window offers the ones whose
// session worked in its first folder, since Claude Code resumes a session from
// the folder it worked in, and opens them in editor tabs through the Claude
// Code extension, one after another. A tab waits until its session's
// transcript is on this machine: Claude Code has nothing to open before.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { findTranscript, type ClaudeDir } from "../core/agents/claude/paths";
import { plainText } from "../core/plainText";
import { folderKey, pendingFor, readPending, TabClaims, withoutTabs } from "../core/transfer/tabs";
import { PENDING_TABS_KEY, type PendingTab } from "../core/transfer/types";
import { claudePanel } from "./agents/claudePanel";
import type { Log } from "./log";

export const REOPEN_TABS = "lookout.reopenTabs";
const CLAUDE_EXTENSION = "anthropic.claude-code";
/**
 * How long to wait for a tab Claude Code opens to show among the editor tabs,
 * and then how long more before the next one. Claude Code brings a tab it
 * restored after a reload to the front in the background, after its command
 * returns, and opens the session in a new tab when that one has not come to
 * the front within a second: the next tab opened before then could take the
 * front from it and have its session open twice.
 */
const PACE = { waitMs: 1500, gapMs: 300 };

export interface PendingTabsDeps {
  log: Log;
  /** The Claude Code config directories, one of which holds a session's transcript once it is on this machine. */
  claudeDirs: () => readonly ClaudeDir[];
  /** How long to wait for each tab to show, and then before the next one; for the tests. */
  pace?: { waitMs: number; gapMs: number };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The longest folder a message shows. */
const FOLDER_MAX = 400;

/** The machine a tab came from, as plain words: a backup names it, and a message must not turn it into a link. */
function hostOf(tab: PendingTab): string {
  return plainText(tab.from);
}

/** A folder as a message shows it. */
function folderOf(folder: string): string {
  return plainText(folder, FOLDER_MAX);
}

/** "3 Claude tabs from laptop". */
function tabsFrom(tabs: readonly PendingTab[]): string {
  const hosts = [...new Set(tabs.map(hostOf).filter(Boolean))];
  return `${tabs.length} Claude ${plural(tabs.length, "tab", "tabs")}${hosts.length ? ` from ${listed(hosts)}` : ""}`;
}

/** A tab as the messages and the list name it. */
function titleOf(tab: PendingTab): string {
  return plainText(tab.title) || `Session ${tab.sessionId.slice(0, 8)}`;
}

/** "a", "b" and 3 more. */
function titles(tabs: readonly PendingTab[], max = 3): string {
  const shown = tabs.slice(0, max).map((tab) => `"${titleOf(tab)}"`);
  return tabs.length > max ? `${shown.join(", ")} and ${tabs.length - max} more` : listed(shown);
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves at the next change of the editor tabs, or after `ms`. */
function nextTabChange(ms: number): { done: Promise<void>; dispose(): void } {
  let finish = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  const timer = setTimeout(finish, ms);
  const listener = vscode.window.tabGroups.onDidChangeTabs(() => finish());
  void done.then(() => {
    clearTimeout(timer);
    listener.dispose();
  });
  return { done, dispose: finish };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A folder of this machine as VS Code opens it: in a remote window, on the same remote; none in a remote window without a folder to name the remote by. */
function folderUri(folder: string): vscode.Uri | undefined {
  const here = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (here && here.scheme !== "file") return here.with({ path: folder });
  return vscode.env.remoteName ? undefined : vscode.Uri.file(folder);
}

class PendingTabs {
  private readonly claims: TabClaims;
  /** Tabs this window offered and the user put off, or failed to open: not offered again until the window reloads. */
  private readonly putOff = new Set<string>();
  /** An offer is showing: it stays pending while it waits in the notification center. */
  private offering = false;
  /** Tabs are being opened. */
  private opening = false;

  constructor(
    private readonly state: vscode.Memento,
    claimsDir: string,
    private readonly deps: PendingTabsDeps,
  ) {
    this.claims = new TabClaims(claimsDir);
  }

  private pending(): PendingTab[] {
    return readPending(this.state.get(PENDING_TABS_KEY));
  }

  private firstFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Whether the tab's session has its transcript on this machine, so Claude Code can open it. */
  private ready(tab: PendingTab): boolean {
    return this.deps.claudeDirs().some((dir) => findTranscript(dir.resolved, tab.cwd, tab.sessionId) !== undefined);
  }

  /** Offers to reopen the pending tabs of this window's first folder, the ones not offered before whose transcripts are here. */
  async offer(): Promise<void> {
    if (this.offering || this.opening) return;
    const tabs = pendingFor(this.pending(), this.firstFolder()).filter((tab) => !this.putOff.has(tab.sessionId.toLowerCase()) && this.ready(tab));
    // Without Claude Code the tabs wait: the list says why.
    if (tabs.length === 0 || !vscode.extensions.getExtension(CLAUDE_EXTENSION)) return;
    this.offering = true;
    let choice: string | undefined;
    try {
      choice = await vscode.window.showInformationMessage(`Lookout: ${tabsFrom(tabs)} ${plural(tabs.length, "belongs", "belong")} in this window.`, "Reopen", "Later", "Forget");
    } finally {
      this.offering = false;
    }
    if (choice === "Reopen") await this.reopen(tabs);
    else if (choice === "Forget") await this.forget(tabs);
    else for (const tab of tabs) this.putOff.add(tab.sessionId.toLowerCase());
  }

  /** Every pending tab, to pick the ones to reopen: this window's here, the others' by opening their folders. */
  async choose(): Promise<void> {
    const pending = this.pending();
    if (pending.length === 0) {
      void vscode.window.showInformationMessage("Lookout: no Claude tabs from a backup wait to be reopened.");
      return;
    }
    const here = new Set(pendingFor(pending, this.firstFolder()).map((tab) => tab.sessionId));
    const ordered = [...pending].sort((a, b) => Number(here.has(b.sessionId)) - Number(here.has(a.sessionId)) || a.cwd.localeCompare(b.cwd));
    const items = ordered.map((tab) => {
      const ready = this.ready(tab);
      const where = here.has(tab.sessionId) ? "This window" : "Opens its folder in a new window";
      return {
        label: titleOf(tab),
        description: folderOf(tab.cwd),
        detail: `${where}${ready ? "" : " · its conversation is not on this machine yet"} · from ${hostOf(tab) || "another machine"}`,
        picked: here.has(tab.sessionId) && ready,
        tab,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: "Reopen Tabs from Backup",
      placeHolder: "Pick the tabs to reopen",
      matchOnDescription: true,
    });
    if (!picked?.length) return;
    const mine = picked.filter((item) => here.has(item.tab.sessionId)).map((item) => item.tab);
    const others = picked.filter((item) => !here.has(item.tab.sessionId)).map((item) => item.tab);
    if (mine.length > 0) {
      if (vscode.extensions.getExtension(CLAUDE_EXTENSION)) await this.reopen(mine);
      else void vscode.window.showWarningMessage(`Lookout cannot reopen ${tabsFrom(mine)}: Claude Code is not installed here. ${plural(mine.length, "It waits", "They wait")} until it is.`);
    }
    if (others.length > 0) await this.elsewhere(others);
  }

  /**
   * Opens the tabs no other window has taken, in order. Each one is claimed
   * and taken off the pending list before any opens, so no other window opens
   * it too. A tab whose transcript is not on this machine stays on the list,
   * unclaimed; a tab that fails to open goes back on it. Both are reported.
   */
  async reopen(tabs: readonly PendingTab[]): Promise<void> {
    this.opening = true;
    try {
      await this.reopenNow(tabs);
    } finally {
      this.opening = false;
    }
  }

  private async reopenNow(tabs: readonly PendingTab[]): Promise<void> {
    const pendingNow = new Set(this.pending().map((tab) => tab.sessionId.toLowerCase()));
    this.claims.prune(Date.now());
    const claimed: PendingTab[] = [];
    // A tab another window claimed is that window's to open.
    const taken: PendingTab[] = [];
    const waiting: PendingTab[] = [];
    for (const tab of tabs) {
      if (!pendingNow.has(tab.sessionId.toLowerCase())) continue;
      if (!this.ready(tab)) waiting.push(tab);
      else (this.claims.claim(tab) ? claimed : taken).push(tab);
    }
    if (waiting.length > 0) {
      for (const tab of waiting) this.putOff.add(tab.sessionId.toLowerCase());
      void vscode.window.showWarningMessage(
        `Lookout cannot reopen ${titles(waiting)} yet: ${plural(waiting.length, "its conversation is", "their conversations are")} not on this machine. ${plural(waiting.length, "It waits", "They wait")} under Reopen Tabs from Backup.`,
      );
    }
    await this.state.update(PENDING_TABS_KEY, withoutTabs(this.pending(), [...claimed, ...taken]));
    const pace = this.deps.pace ?? PACE;
    const failed: PendingTab[] = [];
    for (const [index, tab] of claimed.entries()) {
      const shown = index < claimed.length - 1 ? nextTabChange(pace.waitMs) : undefined;
      const opened = await claudePanel.resume(tab.sessionId, this.deps.log);
      if (!opened) failed.push(tab);
      if (!shown) continue;
      if (opened) {
        await shown.done;
        await sleep(pace.gapMs);
      }
      shown.dispose();
    }
    const reopened = claimed.length - failed.length;
    if (reopened > 0) this.deps.log.info(`Reopened ${reopened} Claude ${plural(reopened, "tab", "tabs")} from a backup`);
    if (failed.length === 0) return;
    for (const tab of failed) {
      this.claims.release(tab);
      this.putOff.add(tab.sessionId.toLowerCase());
    }
    const rest = this.pending();
    await this.state.update(PENDING_TABS_KEY, [...rest, ...withoutTabs(failed, rest)]);
    void vscode.window.showWarningMessage(`Lookout could not reopen ${titles(failed)}. ${plural(failed.length, "It waits", "They wait")} under Reopen Tabs from Backup.`);
  }

  private async forget(tabs: readonly PendingTab[]): Promise<void> {
    await this.state.update(PENDING_TABS_KEY, withoutTabs(this.pending(), tabs));
  }

  /**
   * Tabs of other folders: a folder this machine has opens in a new window,
   * which then offers its tabs; the tabs of a folder it does not have can be
   * forgotten.
   */
  private async elsewhere(tabs: readonly PendingTab[]): Promise<void> {
    const folders = new Map<string, { folder: string; tabs: PendingTab[] }>();
    for (const tab of tabs) {
      const key = folderKey(tab.cwd);
      const entry = folders.get(key) ?? { folder: tab.cwd, tabs: [] };
      entry.tabs.push(tab);
      folders.set(key, entry);
    }
    const present = [...folders.values()].filter((entry) => isDirectory(entry.folder));
    const missing = [...folders.values()].filter((entry) => !isDirectory(entry.folder));
    if (present.length > 0) {
      const count = present.reduce((sum, entry) => sum + entry.tabs.length, 0);
      const where = `${count} ${plural(count, "tab belongs", "tabs belong")} in ${plural(present.length, "a window", "windows")} on ${listed(present.map((entry) => folderOf(entry.folder)))}`;
      const reopen = `${plural(present.length, "offers", "offer")} to reopen ${plural(count, "it", "them")} there`;
      const uris = present.map((entry) => folderUri(entry.folder));
      if (uris.some((uri) => uri === undefined)) {
        void vscode.window.showInformationMessage(`Lookout: ${where}. Open ${plural(present.length, "it", "each one")} in a window, which ${reopen}.`);
      } else {
        const open = plural(present.length, "Open in New Window", "Open in New Windows");
        if ((await vscode.window.showInformationMessage(`Lookout: ${where}, which ${reopen}.`, open)) === open) {
          for (const [index, entry] of present.entries()) {
            try {
              await vscode.commands.executeCommand("vscode.openFolder", uris[index], { forceNewWindow: true });
            } catch (err) {
              this.deps.log.errorOnce(`Could not open ${entry.folder} in a new window: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    }
    if (missing.length > 0) {
      const lost = missing.flatMap((entry) => entry.tabs);
      const choice = await vscode.window.showWarningMessage(
        `Lookout: ${titles(lost)} worked in ${listed(missing.map((entry) => folderOf(entry.folder)))}, which ${plural(missing.length, "is", "are")} not on this machine. Forget ${plural(lost.length, "it", "them")}?`,
        "Forget",
      );
      if (choice === "Forget") await this.forget(lost);
    }
  }
}

/**
 * Offers this window's pending tabs on activation, when its folders change and
 * when it gains the focus (a restore in another window may have added some),
 * and registers `lookout.reopenTabs`, which lists every pending tab.
 */
export function registerPendingTabs(context: vscode.ExtensionContext, deps: PendingTabsDeps): vscode.Disposable {
  const tabs = new PendingTabs(context.globalState, path.join(context.globalStorageUri.fsPath, "tab-claims"), deps);
  const disposables = [
    vscode.commands.registerCommand(REOPEN_TABS, () => tabs.choose()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void tabs.offer()),
    vscode.window.onDidChangeWindowState(() => {
      if (vscode.window.state.focused) void tabs.offer();
    }),
  ];
  void tabs.offer();
  return { dispose: () => disposables.forEach((disposable) => disposable.dispose()) };
}
