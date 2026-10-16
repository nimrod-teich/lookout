import * as vscode from "vscode";
import { describeReason } from "../core/format";
import type { SessionView } from "../core/types";

const JUMP = "Jump";

/** Shows a notification with a Jump button; resolves true when the user presses it. */
async function offerJump(message: string): Promise<boolean> {
  return (await vscode.window.showInformationMessage(message, JUMP)) === JUMP;
}

export function notifyWaiting(view: SessionView): Promise<boolean> {
  if (view.reason?.kind === "typed") return offerJump(`"${view.title}" asked you a question: ${view.reason.ask}`);
  return offerJump(`"${view.title}" needs you: ${describeReason(view.reason)}`);
}

export function notifyFinished(view: SessionView): Promise<boolean> {
  return offerJump(`"${view.title}" finished.`);
}
