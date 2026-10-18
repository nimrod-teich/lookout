import * as vscode from "vscode";
import type { PastView, SessionView } from "../../core/types";
import type { Log } from "../log";
import type { PanelAdapter } from "./panel";
import { openChatSession } from "./vscodeChat";

/** Copilot's sessions in VS Code's Chat: each opens in an editor, with any approval it waits on. */
export const copilotPanel: PanelAdapter = {
  reveal: (view: SessionView, log: Log) => openChatSession(view.vscodeSession, log, view.title),

  /** The chat's editor is the one in front: VS Code names its tab after the session. */
  isActive(view: SessionView): boolean {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab !== undefined && !(tab.input instanceof vscode.TabInputTerminal) && tab.label === view.title;
  },

  /** VS Code names the session; Lookout offers no rename. */
  rename: () => Promise.resolve(false),

  resume: async (_id: string, log: Log, view?: PastView) => (await openChatSession(view?.vscodeSession, log)) === "revealed",
};
