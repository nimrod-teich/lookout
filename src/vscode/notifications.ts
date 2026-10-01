import * as vscode from "vscode";
import type { SessionView } from "../core/types";

const JUMP = "Jump";

/** Shows a notification with a Jump button; resolves true when the user presses it. */
async function offerJump(message: string): Promise<boolean> {
  return (await vscode.window.showInformationMessage(message, JUMP)) === JUMP;
}

export function notifyWaiting(view: SessionView): Promise<boolean> {
  return offerJump(`"${view.title}" needs you: ${view.needs ?? "input"}`);
}

export function notifyFinished(view: SessionView): Promise<boolean> {
  return offerJump(`"${view.title}" finished.`);
}
