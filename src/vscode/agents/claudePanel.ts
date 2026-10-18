import * as vscode from "vscode";
import type { SessionView } from "../../core/types";
import type { Log } from "../log";
import type { PanelAdapter, PanelReveal } from "./panel";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The Claude Code extension's command that reveals the tab or sidebar holding a session. */
const CLAUDE_OPEN = "claude-vscode.editor.open";
/** The Claude Code extension's rename: an input box for the active session tab, saved as the session's custom title. */
const CLAUDE_RENAME = "claude-vscode.renameSessionTab";
/** The Claude Code extension's "Focus last message": brings the newest message of the chat it last saw focused into view. */
const CLAUDE_LAST_MESSAGE = "claude-vscode.focusLastMessage";
/** How long to wait for the tab to come to the front before asking for the rename. */
const ACTIVATE_WAIT_MS = 1500;
/** Time for a tab that came to the front to tell the Claude Code extension it has the focus. */
const FOCUS_SETTLE_MS = 150;
/**
 * The Claude Code extension's "Focus input": puts the cursor in the prompt box
 * of every visible chat, inserting the active text editor's selection, if any,
 * as an @-mention.
 */
const CLAUDE_FOCUS_INPUT = "claude-vscode.focus";
/** Time for the chat to scroll to its newest message before the prompt box takes the focus. */
const SCROLL_SETTLE_MS = 150;
const CLAUDE_PANEL_VIEW_TYPE = "claudeVSCodePanel";
const FOCUS_GROUP = [
  "workbench.action.focusFirstEditorGroup",
  "workbench.action.focusSecondEditorGroup",
  "workbench.action.focusThirdEditorGroup",
  "workbench.action.focusFourthEditorGroup",
  "workbench.action.focusFifthEditorGroup",
  "workbench.action.focusSixthEditorGroup",
  "workbench.action.focusSeventhEditorGroup",
  "workbench.action.focusEighthEditorGroup",
];

/** The label the Claude Code extension gives a session's tab. */
export function claudeTabLabel(title: string): string {
  return title.length > 25 ? `${title.substring(0, 24)}…` : title;
}

function isClaudePanel(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_PANEL_VIEW_TYPE);
}

function isClaudeTab(tab: vscode.Tab, label: string): boolean {
  return isClaudePanel(tab) && tab.label === label;
}

/** The labels of the Claude Code tabs open in this window. */
export function claudeTabLabels(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(isClaudePanel)
    .map((tab) => tab.label);
}

function findClaudeTab(title: string): vscode.Tab | undefined {
  const label = claudeTabLabel(title);
  const matches = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => isClaudeTab(tab, label));
  // Two tabs with one label can't be told apart; guessing could open the wrong session.
  return matches.length === 1 ? matches[0] : undefined;
}

async function activateTab(tab: vscode.Tab): Promise<boolean> {
  const column = tab.group.viewColumn;
  const focusGroup = FOCUS_GROUP[column - 1];
  // Asking for a group past the last one creates a new, empty group.
  if (!focusGroup || column > vscode.window.tabGroups.all.length) return false;
  const index = tab.group.tabs.indexOf(tab);
  if (index < 0) return false;
  await vscode.commands.executeCommand(focusGroup);
  await vscode.commands.executeCommand("workbench.action.openEditorAtIndex", index);
  return true;
}

/**
 * The Claude command resumes a session that is not open in its window, which
 * would start a second process on a session another window or a terminal
 * already runs. `reveal` relies on being called only for sessions this window hosts.
 */
async function reveal(view: SessionView, log: Log): Promise<PanelReveal> {
  if (!UUID.test(view.id)) {
    log.errorOnce(`Refused to jump to a session with a malformed id (pid ${view.pid})`);
    return "refused-invalid";
  }
  try {
    await vscode.commands.executeCommand(CLAUDE_OPEN, view.id, undefined, undefined, undefined, undefined, {
      programmatic: "pin-to-panel",
    });
    return "revealed";
  } catch (err) {
    log.errorOnce(`${CLAUDE_OPEN} failed, falling back to the tab label: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tab = findClaudeTab(view.title);
  return tab && (await activateTab(tab)) ? "revealed-by-tab" : "failed";
}

function isActive(view: SessionView): boolean {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  return tab !== undefined && isClaudeTab(tab, claudeTabLabel(view.title));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bumped by every jump and rename: a later one cancels the scroll an earlier jump still waits to make. */
let latestJump = 0;

/** Drops the scroll a jump still waits to make. */
export function cancelNewest(): void {
  latestJump++;
}

/**
 * Brings the session's newest message into view, or the prompt it waits on,
 * with the cursor in its prompt box.
 * Claude Code's command acts on the chat it last saw focused, so it runs only
 * once the session's tab is in front and has had a moment to report its
 * focus; a tab that does not come to the front is left as it is.
 */
async function showNewest(view: SessionView, log: Log): Promise<void> {
  const jump = ++latestJump;
  for (let waited = 0; !isActive(view); waited += 50) {
    if (waited >= ACTIVATE_WAIT_MS || jump !== latestJump) return;
    await sleep(50);
  }
  await sleep(FOCUS_SETTLE_MS);
  if (jump !== latestJump || !isActive(view)) return;
  try {
    await vscode.commands.executeCommand(CLAUDE_LAST_MESSAGE);
  } catch (err) {
    log.errorOnce(`${CLAUDE_LAST_MESSAGE} failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // The command scrolls by focusing the newest message, which then keeps a focus
  // outline; the prompt box takes the focus back and the scroll stays. A chat that
  // waits on a prompt keeps the focus on it.
  await sleep(SCROLL_SETTLE_MS);
  if (jump !== latestJump || !isActive(view) || !inputFocusIsHarmless()) return;
  try {
    await vscode.commands.executeCommand(CLAUDE_FOCUS_INPUT);
  } catch (err) {
    log.errorOnce(`${CLAUDE_FOCUS_INPUT} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Claude Code's "Focus input" acts only on this chat and inserts nothing: no
 * other chat tab is in front of its group, and no text is selected in the
 * active text editor.
 */
function inputFocusIsHarmless(): boolean {
  const visibleChats = vscode.window.tabGroups.all.filter((group) => group.activeTab && isClaudePanel(group.activeTab)).length;
  return visibleChats === 1 && (vscode.window.activeTextEditor?.selection.isEmpty ?? true);
}

/** Brings the session's tab forward, at its newest message. */
async function jump(view: SessionView, log: Log): Promise<PanelReveal> {
  const result = await reveal(view, log);
  if (result === "revealed" || result === "revealed-by-tab") void showNewest(view, log);
  return result;
}

/** Reveals the session, waits for its tab to be in front, then opens Claude Code's rename box. */
async function rename(view: SessionView, log: Log): Promise<boolean> {
  // The rename box would lose its focus to the scroll.
  cancelNewest();
  const revealed = await reveal(view, log);
  if (revealed === "refused-invalid" || revealed === "failed") return false;
  for (let waited = 0; !isActive(view) && waited < ACTIVATE_WAIT_MS; waited += 50) await new Promise((r) => setTimeout(r, 50));
  try {
    await vscode.commands.executeCommand(CLAUDE_RENAME);
    return true;
  } catch (err) {
    log.errorOnce(`${CLAUDE_RENAME} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** The same command, for a session no process runs: Claude Code resumes it in a new tab. */
async function resume(id: string, log: Log): Promise<boolean> {
  if (!UUID.test(id)) return false;
  try {
    await vscode.commands.executeCommand(CLAUDE_OPEN, id, undefined, undefined, undefined, undefined, { programmatic: "pin-to-panel" });
    return true;
  } catch (err) {
    log.errorOnce(`${CLAUDE_OPEN} failed to resume a session: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export const claudePanel: PanelAdapter = { reveal: jump, isActive, rename, resume };
