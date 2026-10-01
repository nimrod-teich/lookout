import * as vscode from "vscode";
import type { SessionView } from "../core/types";
import { panelAdapter } from "./agents";
import type { PanelReveal } from "./agents/panel";
import type { Log } from "./log";
import type { Terminals } from "./terminals";

export type JumpResult = PanelReveal | "revealed-terminal" | "refused-elsewhere";

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
    case "elsewhere":
      return "refused-elsewhere";
  }
}

/** Brings the session's tab or terminal to the front. Returns whether it got there. */
export async function jumpToSession(view: SessionView, terminals: Terminals, log: Log): Promise<JumpResult> {
  const result = await reveal(view, terminals, log);
  if (result === "refused-elsewhere") {
    void vscode.window.showInformationMessage(
      `"${view.title}" runs in another window or outside VS Code. Lookout jumps to sessions hosted in this window.`,
    );
  } else if (result === "failed") {
    void vscode.window.showWarningMessage(`Lookout could not find the tab or terminal for "${view.title}".`);
  }
  return result;
}
