// The sessions VS Code runs in its own Chat view, whichever agent: opened in
// an editor, with the approval they wait on.
import * as vscode from "vscode";
import type { Log } from "../log";
import type { PanelReveal } from "./panel";
import { activateTab } from "./tabs";

/**
 * VS Code's command that moves a chat session into an editor of the active
 * group, out of the Chat view if it is there, or brings its editor forward.
 * The chat's approval prompt goes with it; opening the session's address with
 * `vscode.open` instead shows a second view of it, without the prompt.
 */
const OPEN_IN_EDITOR = "workbench.action.chat.openSessionInEditorGroup";

/** A chat's editor tab, which VS Code names after the session: one other kind of tab can share the name. */
function isChatTab(tab: vscode.Tab, title: string): boolean {
  const input = tab.input;
  return (
    tab.label === title &&
    !(input instanceof vscode.TabInputText) &&
    !(input instanceof vscode.TabInputTerminal) &&
    !(input instanceof vscode.TabInputWebview) &&
    !(input instanceof vscode.TabInputCustom)
  );
}

/**
 * Opens a session VS Code runs in its Chat: the editor tab that shows it,
 * when one carries its title; else, by its address, in an editor of the
 * active group. A session the Copilot extension started in a tab of its own
 * keeps its approval prompt in that tab, so the tab goes first.
 */
export async function openChatSession(address: string | undefined, log: Log, title?: string): Promise<PanelReveal> {
  if (title) {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => isChatTab(tab, title));
    // Two tabs of one name cannot be told apart.
    if (tabs.length === 1 && (await activateTab(tabs[0]!))) return "revealed-by-tab";
  }
  if (!address) return "failed";
  try {
    await vscode.commands.executeCommand(OPEN_IN_EDITOR, { resource: vscode.Uri.parse(address) });
    return "revealed";
  } catch (err) {
    log.errorOnce(`Opening a session in VS Code's Chat failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

