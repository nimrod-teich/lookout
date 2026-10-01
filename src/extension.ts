import * as vscode from "vscode";
import type { SessionView } from "./core/types";
import { readConfig } from "./vscode/config";
import { Controller } from "./vscode/controller";
import { jumpToSession, revealed } from "./vscode/jump";
import { createLog } from "./vscode/log";
import { notifyFinished, notifyWaiting } from "./vscode/notifications";
import { pickSession } from "./vscode/quickPick";
import { StatusBar } from "./vscode/statusBar";
import { Terminals } from "./vscode/terminals";

const JUMP = "lookout.jump";
const JUMP_NEXT_ATTENTION = "lookout.jumpNextAttention";
const MARK_ALL_SEEN = "lookout.markAllSeen";

export function activate(context: vscode.ExtensionContext): void {
  const log = createLog();
  const terminals = new Terminals();
  const controller = new Controller(terminals, log);
  const statusBar = new StatusBar(JUMP);
  let config = readConfig();

  const render = () => statusBar.render(controller.sessions, config.statusBarEnabled);
  const jump = async (view: SessionView) => {
    if (revealed(await jumpToSession(view, terminals, log))) controller.markSeen(view.id);
  };
  const noticeFocus = () => controller.noticeFocus();

  context.subscriptions.push(
    log,
    terminals,
    controller,
    statusBar,
    controller.onDidChange(render),
    controller.onDidStartWaiting(async (view) => {
      if (config.notifyWaiting && (await notifyWaiting(view))) await jump(view);
    }),
    controller.onDidFinish(async (view) => {
      if (config.notifyDone && (await notifyFinished(view))) await jump(view);
    }),
    terminals.onDidChange(() => controller.poll()),
    vscode.window.tabGroups.onDidChangeTabs(noticeFocus),
    vscode.window.tabGroups.onDidChangeTabGroups(noticeFocus),
    vscode.window.onDidChangeActiveTerminal(noticeFocus),
    vscode.window.onDidChangeWindowState(noticeFocus),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("lookout") && !event.affectsConfiguration("claudeCode.environmentVariables")) return;
      const next = readConfig();
      const moved = next.claudeConfigDir !== config.claudeConfigDir;
      config = next;
      if (moved) controller.start(config);
      render();
    }),
    vscode.commands.registerCommand(JUMP, async () => {
      if (controller.sessions.length === 0) {
        void vscode.window.showInformationMessage("Lookout: no agent sessions are running.");
        return;
      }
      const view = await pickSession(controller.sessions);
      if (view) await jump(view);
    }),
    vscode.commands.registerCommand(JUMP_NEXT_ATTENTION, async () => {
      // Sessions are ordered with waiting ones first, then finished ones, each longest first.
      const view = controller.sessions.find((s) => (s.state === "waiting" || s.state === "done") && s.host !== "elsewhere");
      if (view) await jump(view);
      else void vscode.window.showInformationMessage("Lookout: no session in this window is waiting for you.");
    }),
    vscode.commands.registerCommand(MARK_ALL_SEEN, () => controller.markAllSeen()),
  );

  controller.start(config);
  render();
}

export function deactivate(): void {}
