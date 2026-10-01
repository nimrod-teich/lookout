import * as vscode from "vscode";
import { describeLocation, describeState, formatElapsed } from "../core/format";
import type { Host, SessionView } from "../core/types";
import { STATE_ICON } from "./icons";

const HOST_LABEL: Record<Host, string> = {
  panel: "",
  terminal: "terminal",
  elsewhere: "another window",
};

interface SessionItem extends vscode.QuickPickItem {
  view: SessionView;
}

function toItem(view: SessionView, now: number): SessionItem {
  let detail = describeState(view);
  if (view.since) detail += ` · ${formatElapsed(now - view.since)}`;
  if (HOST_LABEL[view.host]) detail += ` · ${HOST_LABEL[view.host]}`;
  return { label: `${STATE_ICON[view.state]} ${view.title}`, description: describeLocation(view), detail, view };
}

/** Lets the user choose a session; the list is already ordered with what needs attention first. */
export async function pickSession(views: readonly SessionView[], now: number = Date.now()): Promise<SessionView | undefined> {
  const picked = await vscode.window.showQuickPick(
    views.map((view) => toItem(view, now)),
    { placeHolder: "Jump to a session", matchOnDescription: true, matchOnDetail: true },
  );
  return picked?.view;
}
