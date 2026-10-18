import * as vscode from "vscode";
import type { PastView, SessionView } from "../../core/types";
import type { Log } from "../log";
import type { PanelAdapter, PanelReveal } from "./panel";

/**
 * VS Code's command that moves a chat session into an editor of the active
 * group, out of the Chat view if it is there, or brings its editor forward.
 * The chat's approval prompt goes with it; opening the session's address with
 * `vscode.open` instead shows a second view of it, without the prompt.
 */
const OPEN_IN_EDITOR = "workbench.action.chat.openSessionInEditorGroup";

/** Opens a session VS Code runs in its Chat, by its address there. */
async function open(address: string | undefined, log: Log): Promise<PanelReveal> {
  if (!address) return "failed";
  try {
    await vscode.commands.executeCommand(OPEN_IN_EDITOR, { resource: vscode.Uri.parse(address) });
    return "revealed";
  } catch (err) {
    log.errorOnce(`Opening a Copilot session in VS Code's Chat failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

/** Copilot's sessions in VS Code's Chat: each opens in an editor, with any approval it waits on. */
export const copilotPanel: PanelAdapter = {
  reveal: (view: SessionView, log: Log) => open(view.vscodeSession, log),

  /** The chat's editor is the one in front: VS Code names its tab after the session. */
  isActive(view: SessionView): boolean {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab !== undefined && !(tab.input instanceof vscode.TabInputTerminal) && tab.label === view.title;
  },

  /** VS Code names the session; Lookout offers no rename. */
  rename: () => Promise.resolve(false),

  resume: async (_id: string, log: Log, view?: PastView) => (await open(view?.vscodeSession, log)) === "revealed",
};
