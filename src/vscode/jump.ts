import * as vscode from "vscode";
import type { SessionView } from "../core/types";
import { panelAdapter } from "./agents";
import type { PanelReveal } from "./agents/panel";
import type { Log } from "./log";
import type { Terminals } from "./terminals";

export type JumpResult = PanelReveal | "revealed-terminal" | "refused-not-here";

/** The jump brought the session to the front. */
export function revealed(result: JumpResult): boolean {
  return result === "revealed" || result === "revealed-by-tab" || result === "revealed-terminal";
}

async function reveal(view: SessionView, terminals: Terminals, log: Log): Promise<JumpResult> {
  switch (view.host) {
    case "panel":
      return (await panelAdapter(view.agent)?.reveal(view, log)) ?? "failed";
    case "terminal":
      return view.terminalPid !== undefined && terminals.show(view.terminalPid) ? "revealed-terminal" : "failed";
    case "window":
    case "editor":
    case "elsewhere":
      return "refused-not-here";
  }
}

function whereItRuns(view: SessionView): string {
  if (view.host === "window") return view.windowLabel ? `in the window "${view.windowLabel}"` : "in another window";
  if (view.host === "editor") return "in a window where Lookout does not run";
  return "outside VS Code";
}

/** Brings the session's tab or terminal to the front. Returns whether it got there. */
export async function jumpToSession(view: SessionView, terminals: Terminals, log: Log): Promise<JumpResult> {
  const result = await reveal(view, terminals, log);
  if (result === "refused-not-here") {
    void vscode.window.showInformationMessage(`"${view.title}" runs ${whereItRuns(view)}. Lookout jumps to sessions in the VS Code windows on this machine.`);
  } else if (result === "failed") {
    void vscode.window.showWarningMessage(`Lookout could not find the tab or terminal for "${view.title}".`);
  }
  return result;
}

/**
 * Lets the user rename a session through its agent. Only sessions in this
 * window's agent panel can be renamed from here: the agent's rename works on
 * the tab it owns.
 */
export async function renameSession(view: SessionView, terminals: Terminals, log: Log): Promise<boolean> {
  if (view.host !== "panel") {
    void vscode.window.showInformationMessage(
      view.host === "terminal"
        ? `"${view.title}" runs in a terminal; rename it there with /rename.`
        : `"${view.title}" runs ${whereItRuns(view)}. Lookout renames sessions hosted in this window.`,
    );
    return false;
  }
  const adapter = panelAdapter(view.agent);
  if (!adapter || !(await adapter.rename(view, log))) {
    void vscode.window.showWarningMessage(`Lookout could not open the rename for "${view.title}".`);
    return false;
  }
  return true;
}
