import * as vscode from "vscode";
import type { SessionView } from "../core/types";
import { panelAdapter } from "./agents";
import type { Log } from "./log";
import type { Terminals } from "./terminals";

/** The agent's own command that turns Remote Control on, and asks what to do when it is on. */
export const REMOTE_CONTROL_COMMAND = "/remote-control";

export type RemoteResult = "sent" | "revealed" | "refused" | "failed";

/**
 * Turns Remote Control on or off for one session, by the means its host allows.
 * A terminal gets the agent's own slash command typed into it. A panel session
 * has no way in from outside the agent's extension, so the tab comes to the
 * front with the command to type. Sessions elsewhere are left alone.
 */
export async function toggleRemoteControl(view: SessionView, terminals: Terminals, log: Log): Promise<RemoteResult> {
  const verb = view.remote ? "off" : "on";
  switch (view.host) {
    case "terminal": {
      if (view.state === "waiting") {
        // A line typed into a prompt answers the prompt.
        void vscode.window.showInformationMessage(`"${view.title}" is waiting for you. Answer it first, then turn Remote Control ${verb}.`);
        return "refused";
      }
      if (view.terminalPid === undefined || !terminals.send(view.terminalPid, REMOTE_CONTROL_COMMAND)) {
        void vscode.window.showWarningMessage(`Lookout could not find the terminal for "${view.title}".`);
        return "failed";
      }
      if (view.remote) void vscode.window.showInformationMessage(`"${view.title}" asks what to do with Remote Control; pick "Disconnect" in the terminal.`);
      return "sent";
    }
    case "panel": {
      const result = (await panelAdapter(view.agent)?.reveal(view, log)) ?? "failed";
      if (result === "failed" || result === "refused-invalid") {
        void vscode.window.showWarningMessage(`Lookout could not find the tab for "${view.title}".`);
        return "failed";
      }
      void vscode.window.showInformationMessage(`Type ${REMOTE_CONTROL_COMMAND} in "${view.title}" and press Enter to turn Remote Control ${verb}. The agent's panel takes no commands from outside.`);
      return "revealed";
    }
    case "window":
      void vscode.window.showInformationMessage(
        `"${view.title}" runs ${view.windowLabel ? `in the window "${view.windowLabel}"` : "in another window"}; turn Remote Control ${verb} from Lookout there.`,
      );
      return "refused";
    case "elsewhere":
      void vscode.window.showInformationMessage(`"${view.title}" runs outside VS Code; type ${REMOTE_CONTROL_COMMAND} there to turn Remote Control ${verb}.`);
      return "refused";
  }
}
