import * as vscode from "vscode";
import type { SessionView } from "../../core/types";
import type { Log } from "../log";
import type { PanelAdapter, PanelReveal } from "./panel";

/** The OpenAI extension that hosts Codex threads in VS Code. */
const CODEX_EXTENSION = "openai.chatgpt";
/** Its editor for one thread, opened on the thread's address. */
const CODEX_EDITOR = "chatgpt.conversationEditor";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The address the Codex extension gives a thread, `openai-codex://route/local/<id>`: its editor opens it. */
function threadUri(id: string): vscode.Uri {
  return vscode.Uri.from({ scheme: "openai-codex", authority: "route", path: `/local/${id}` });
}

/** The editor tab that shows the thread, when one does. */
function tabOf(id: string): vscode.Tab | undefined {
  const address = threadUri(id).toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputCustom && tab.input.viewType === CODEX_EDITOR && tab.input.uri.toString() === address) return tab;
    }
  }
  return undefined;
}

/**
 * Shows a thread in the extension's editor: its tab, brought to the front in
 * its own group, when one shows it, or a new one. The extension's side bar
 * shows one thread at a time, and the only way to point it at another, the
 * extension's link `vscode://openai.chatgpt/local/<id>`, makes VS Code ask
 * whether the extension may open it.
 */
async function show(id: string, log: Log): Promise<PanelReveal> {
  if (!UUID.test(id)) return "refused-invalid";
  if (!vscode.extensions.getExtension(CODEX_EXTENSION)) return "failed";
  try {
    const tab = tabOf(id);
    await vscode.commands.executeCommand("vscode.openWith", threadUri(id), CODEX_EDITOR, { viewColumn: tab?.group.viewColumn, preview: false });
    return "revealed";
  } catch (err) {
    log.errorOnce(`Opening a Codex thread failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

/** The Codex extension's threads: its side bar, or an editor tab per thread. */
export const codexPanel: PanelAdapter = {
  reveal: (view: SessionView, log: Log) => show(view.id, log),

  /** Its editor tab is the one in front; a thread in the side bar cannot be told. */
  isActive(view: SessionView): boolean {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === CODEX_EDITOR && tab.input.uri.toString() === threadUri(view.id).toString();
  },

  /** Codex names its threads itself; the extension offers no rename from outside. */
  rename: () => Promise.resolve(false),

  /** The extension loads a thread it is asked to show, and resumes it there. */
  resume: async (id: string, log: Log) => (await show(id, log)) === "revealed",
};
