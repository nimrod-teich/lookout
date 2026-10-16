import * as vscode from "vscode";
import { writeRemoteControlAtStartup } from "../core/agents/claude/remoteControl";
import type { SessionView } from "../core/types";
import { panelAdapter } from "./agents";
import type { Log } from "./log";
import type { Terminals } from "./terminals";

/** The agent's own command that turns Remote Control on, and asks what to do when it is on. */
export const REMOTE_CONTROL_COMMAND = "/remote-control";
/** Its short form, for the user to type. */
const SHORT_COMMAND = "/rc";
/** How long to wait for the agent to connect or disconnect a tab after its setting changed. */
const SETTING_WAIT_MS = 15_000;

export interface RemoteOptions {
  /** The agent's config directory, where its settings file lives. */
  configDir(): string;
  /** Every session Lookout knows, read again on each call. */
  sessions(): readonly SessionView[];
  /** How long to wait for the agent after its setting changed; the default is 15 s. */
  waitMs?: number;
}

export type RemoteResult = "sent" | "switched" | "revealed" | "refused" | "failed";

/**
 * Turns Remote Control on or off for one session, by the means its host allows.
 * A terminal gets the agent's own slash command typed into it. A panel session
 * takes no commands from outside the agent's extension; that extension does
 * apply its `remoteControlAtStartup` setting to every running tab when the
 * setting changes, so the user is asked, then the setting is written.
 * Sessions elsewhere are left alone.
 */
export async function toggleRemoteControl(view: SessionView, terminals: Terminals, log: Log, options: RemoteOptions): Promise<RemoteResult> {
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
    case "panel":
      return switchTabs(view, options, log);
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

/**
 * Claude Code switches Remote Control for all its tabs together: its
 * extension applies the `remoteControlAtStartup` setting to every running tab
 * when the setting changes (seen live: on within 5 s, off within 3 s). One
 * card's switch therefore reaches every tab, and the user is asked first.
 */
async function switchTabs(view: SessionView, options: RemoteOptions, log: Log): Promise<RemoteResult> {
  const on = !view.remote;
  const tabs = options.sessions().filter((s) => s.host === "panel").length;
  const where = `every Claude tab (${tabs} in this window, plus any in other windows)`;
  const question = on
    ? `Claude Code switches Remote Control for all its tabs together, not one at a time. Turn it on for ${where}? New tabs will start with it on until it is turned off.`
    : `Turn Remote Control off for ${where}? New tabs will start without it.`;
  const answer = await vscode.window.showWarningMessage(question, { modal: true }, on ? "Turn on for all tabs" : "Turn off for all tabs");
  if (answer === undefined) return "refused";
  try {
    writeRemoteControlAtStartup(options.configDir(), on);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.errorOnce(`Could not write Claude Code's settings: ${reason}`);
    void vscode.window.showErrorMessage(`Lookout could not change Claude Code's settings: ${reason}`);
    return revealForTyping(view, log, on ? "on" : "off");
  }
  const deadline = Date.now() + (options.waitMs ?? SETTING_WAIT_MS);
  while (Date.now() < deadline) {
    if ((options.sessions().find((s) => s.id === view.id)?.remote === true) === on) {
      void vscode.window.showInformationMessage(on ? `Remote Control is on for "${view.title}" and the other Claude tabs.` : "Remote Control is off for the Claude tabs.");
      return "switched";
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  void vscode.window.showWarningMessage(
    on
      ? `Claude Code has not connected "${view.title}" yet. It keeps trying while the setting is on; a tab whose Remote Control is disabled by policy stays off.`
      : `Claude Code has not disconnected "${view.title}" yet.`,
  );
  return "switched";
}

/** The way that always works: the tab in front, the cursor in its input, and the command to type. */
async function revealForTyping(view: SessionView, log: Log, verb: "on" | "off"): Promise<RemoteResult> {
  const adapter = panelAdapter(view.agent);
  const result = (await adapter?.reveal(view, log)) ?? "failed";
  if (result === "failed" || result === "refused-invalid") {
    void vscode.window.showWarningMessage(`Lookout could not find the tab for "${view.title}".`);
    return "failed";
  }
  const focused = (await adapter?.focusInput(view, log)) === true;
  // Short, so the toast shows all of it.
  void vscode.window.showInformationMessage(focused ? `Type ${SHORT_COMMAND} ⏎ to turn Remote Control ${verb}.` : `Type ${SHORT_COMMAND} ⏎ in the session's input to turn Remote Control ${verb}.`);
  return "revealed";
}
