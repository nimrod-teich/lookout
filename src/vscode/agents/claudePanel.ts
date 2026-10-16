import * as vscode from "vscode";
import type { SessionView } from "../../core/types";
import type { Log } from "../log";
import type { PanelAdapter, PanelReveal } from "./panel";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The Claude Code extension's command that reveals the tab or sidebar holding a session. */
const CLAUDE_OPEN = "claude-vscode.editor.open";
/** The Claude Code extension's rename: an input box for the active session tab, saved as the session's custom title. */
const CLAUDE_RENAME = "claude-vscode.renameSessionTab";
/** How long to wait for the tab to come to the front before asking for the rename. */
const ACTIVATE_WAIT_MS = 1500;
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

function isClaudeTab(tab: vscode.Tab, label: string): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_PANEL_VIEW_TYPE) && tab.label === label;
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

/** Reveals the session, waits for its tab to be in front, then opens Claude Code's rename box. */
async function rename(view: SessionView, log: Log): Promise<boolean> {
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

export const claudePanel: PanelAdapter = { reveal, isActive, rename, resume };
