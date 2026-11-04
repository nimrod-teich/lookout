import * as vscode from "vscode";
import type { Focus, SessionView } from "../core/types";
import { panelAdapter } from "./agents";
import type { Terminals } from "./terminals";

/**
 * The user has this session in front of them: its tab is the active one in
 * the focused window, or its terminal is the active one and the user went
 * nowhere else since they were last in it.
 */
export function isWatched(view: SessionView, terminals: Terminals): boolean {
  if (!vscode.window.state.focused) return false;
  if (view.host === "panel") return panelAdapter(view.agent)?.isActive(view) ?? false;
  if (view.host === "terminal") return view.terminalPid !== undefined && terminals.activePid() === view.terminalPid && terminals.userIn(view.terminalPid);
  return false;
}

/**
 * How the session is in front in this window, if it is. One session at most
 * is "focused", the one the user is in: its terminal, when they are in a
 * terminal, else its tab in front of the active editor group. "visible": its
 * tab in front of another group, or of the active one while the user is in a
 * terminal, or its terminal the active one while they are not in it (VS Code
 * does not say whether the panel that holds it is open). Whether the window
 * itself has the focus does not count: the board shows where the user left it.
 */
export function focusOf(view: SessionView, terminals: Terminals): Focus | undefined {
  const inTerminal = terminals.userTerminal();
  if (view.host === "terminal") {
    if (view.terminalPid === undefined || view.terminalPid !== terminals.activePid()) return undefined;
    return view.terminalPid === inTerminal ? "focused" : "visible";
  }
  if (view.host !== "panel") return undefined;
  const tab = panelAdapter(view.agent)?.tab(view);
  if (!tab || tab.group.activeTab !== tab) return undefined;
  return tab.group === vscode.window.tabGroups.activeTabGroup && inTerminal === undefined ? "focused" : "visible";
}
