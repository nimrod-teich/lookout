import * as vscode from "vscode";

const FOCUS_GROUP = [
  "workbench.action.focusFirstEditorGroup",
  "workbench.action.focusSecondEditorGroup",
  "workbench.action.focusThirdEditorGroup",
  "workbench.action.focusFourthEditorGroup",
  "workbench.action.focusFifthEditorGroup",
  "workbench.action.focusSixthEditorGroup",
  "workbench.action.focusSeventhEditorGroup",
  "workbench.action.focusEighthEditorGroup",
];

/** Brings a tab to the front: its group takes the focus and shows it. False when its group cannot be reached. */
export async function activateTab(tab: vscode.Tab): Promise<boolean> {
  const column = tab.group.viewColumn;
  const focusGroup = FOCUS_GROUP[column - 1];
  // Asking for a group past the last one creates a new, empty group.
  if (!focusGroup || column > vscode.window.tabGroups.all.length) return false;
  const index = tab.group.tabs.indexOf(tab);
  if (index < 0) return false;
  await vscode.commands.executeCommand(focusGroup);
  await vscode.commands.executeCommand("workbench.action.openEditorAtIndex", index);
  return true;
}
