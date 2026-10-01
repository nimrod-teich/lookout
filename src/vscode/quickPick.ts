import * as vscode from "vscode";
import { describeLocation, describeState } from "../core/format";
import type { SessionView } from "../core/types";
import { STATE_ICON } from "./icons";

/** How often the elapsed times in the open list are refreshed. */
const REFRESH_MS = 1000;

interface SessionItem extends vscode.QuickPickItem {
  view: SessionView;
}

function hostLabel(view: SessionView): string | undefined {
  switch (view.host) {
    case "terminal":
      return "terminal";
    case "window":
      return view.windowLabel ? `window: ${view.windowLabel}` : "another window";
    case "elsewhere":
      return "outside VS Code";
    default:
      return undefined;
  }
}

export function toItem(view: SessionView, now: number): SessionItem {
  const where = hostLabel(view);
  const detail = where ? `${describeState(view, now)} · ${where}` : describeState(view, now);
  return { label: `${STATE_ICON[view.state]} ${view.title}`, description: describeLocation(view), detail, view };
}

/**
 * Lets the user choose a session. The list follows the sessions while it is
 * open and its elapsed times tick; the list is already ordered with what
 * needs attention first.
 */
export function pickSession(sessions: () => readonly SessionView[], onDidChange: vscode.Event<unknown>): Promise<SessionView | undefined> {
  const picker = vscode.window.createQuickPick<SessionItem>();
  picker.placeholder = "Jump to a session";
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;

  const refresh = () => {
    const activeId = picker.activeItems[0]?.view.id;
    picker.items = sessions().map((view) => toItem(view, Date.now()));
    const active = picker.items.find((item) => item.view.id === activeId);
    if (active) picker.activeItems = [active];
  };
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  const subscription = onDidChange(refresh);

  return new Promise((resolve) => {
    let picked: SessionView | undefined;
    picker.onDidAccept(() => {
      picked = picker.selectedItems[0]?.view;
      picker.hide();
    });
    picker.onDidHide(() => {
      clearInterval(timer);
      subscription.dispose();
      picker.dispose();
      resolve(picked);
    });
    picker.show();
  });
}
