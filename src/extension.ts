import * as path from "node:path";
import * as vscode from "vscode";
import { nextAttention } from "./core/model";
import type { SessionView } from "./core/types";
import { Board, BOARD_VIEW } from "./vscode/board";
import { findClaudeBinary } from "./vscode/claudeBinary";
import { readConfig } from "./vscode/config";
import { Controller } from "./vscode/controller";
import { jumpToSession, renameSession, revealed } from "./vscode/jump";
import { createLog } from "./vscode/log";
import { notifyFinished, notifyWaiting } from "./vscode/notifications";
import { pickSession } from "./vscode/quickPick";
import { toggleRemoteControl } from "./vscode/remote";
import { StatusBar } from "./vscode/statusBar";
import { Terminals } from "./vscode/terminals";

const JUMP = "lookout.jump";
const JUMP_NEXT_ATTENTION = "lookout.jumpNextAttention";
const MARK_ALL_SEEN = "lookout.markAllSeen";
const SHOW_BOARD = "lookout.showBoard";
const REFRESH_USAGE = "lookout.refreshUsage";

export function activate(context: vscode.ExtensionContext): void {
  const log = createLog();
  const terminals = new Terminals();
  const controller = new Controller(
    {
      pid: process.pid,
      label: vscode.workspace.name ?? "untitled window",
      sharedDir: path.join(context.globalStorageUri.fsPath, "windows"),
      state: context.workspaceState,
      claudeBinary: findClaudeBinary,
    },
    terminals,
    log,
  );
  const statusBar = new StatusBar(JUMP);
  let config = readConfig();
  /** The session the last "next" jump went to, so repeated presses cycle through them. */
  let lastJump: string | undefined;

  const jump = async (view: SessionView) => {
    lastJump = view.id;
    if (revealed(await jumpToSession(view, terminals, log))) controller.markSeen(view.id);
  };
  const board = new Board(context.extensionUri, {
    sessions: () => controller.sessions,
    usage: () => {
      const usage = controller.usage;
      return usage && { ...usage, canRefresh: controller.canRefreshUsage };
    },
    jump,
    rename: async (view) => {
      await renameSession(view, terminals, log);
    },
    markSeen: (id) => controller.markSeen(id),
    markAllSeen: () => controller.markAllSeen(),
    refreshUsage: () => void controller.refreshUsage(),
    remote: async (view) => {
      await toggleRemoteControl(view, terminals, log, { configDir: () => config.claudeConfigDir, sessions: () => controller.sessions });
    },
  });
  const render = () => {
    statusBar.render({
      views: controller.sessions,
      usage: controller.usage,
      enabled: config.statusBarEnabled,
      showUsage: config.statusBarUsage,
      canRefreshUsage: controller.canRefreshUsage,
    });
    board.refresh();
  };
  const noticeFocus = () => controller.noticeFocus();

  context.subscriptions.push(
    log,
    terminals,
    controller,
    statusBar,
    board,
    controller.onDidChangeUsage(render),
    vscode.window.registerWebviewViewProvider(BOARD_VIEW, board),
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
      const view = await pickSession(() => controller.sessions, controller.onDidChange);
      if (view) await jump(view);
    }),
    vscode.commands.registerCommand(JUMP_NEXT_ATTENTION, async () => {
      const view = nextAttention(controller.sessions, lastJump);
      if (view) await jump(view);
      else void vscode.window.showInformationMessage("Lookout: no session in this window is waiting for you.");
    }),
    vscode.commands.registerCommand(MARK_ALL_SEEN, () => controller.markAllSeen()),
    vscode.commands.registerCommand(SHOW_BOARD, () => vscode.commands.executeCommand(`${BOARD_VIEW}.focus`)),
    vscode.commands.registerCommand(REFRESH_USAGE, async () => {
      if (!controller.canRefreshUsage) {
        void vscode.window.showInformationMessage("Lookout can't fetch usage: usage refresh is off, or the Claude Code extension is not installed.");
        return;
      }
      if (!(await controller.refreshUsage())) void vscode.window.showWarningMessage("Lookout: Claude Code gave no usage numbers. Check the Lookout output log.");
    }),
  );

  controller.start(config);
  render();
}

export function deactivate(): void {}
