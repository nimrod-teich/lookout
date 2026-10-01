import * as vscode from "vscode";
import type { SessionView } from "../core/types";
import { panelAdapter } from "./agents";
import type { Terminals } from "./terminals";

/** The user has this session in front of them: its tab or terminal is the active one in the focused window. */
export function isWatched(view: SessionView, terminals: Terminals): boolean {
  if (!vscode.window.state.focused) return false;
  if (view.host === "panel") return panelAdapter(view.agent)?.isActive(view) ?? false;
  if (view.host === "terminal") return view.terminalPid !== undefined && terminals.activePid() === view.terminalPid;
  return false;
}
