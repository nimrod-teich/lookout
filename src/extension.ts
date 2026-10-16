import * as path from "node:path";
import * as vscode from "vscode";
import { nextAttention } from "./core/model";
import type { SessionView } from "./core/types";
import { Board, BOARD_VIEW } from "./vscode/board";
import { findClaudeBinary } from "./vscode/claudeBinary";
import { readConfig } from "./vscode/config";
import { panelAdapter } from "./vscode/agents";
import { Findings } from "./vscode/findings";
import { Controller } from "./vscode/controller";
import { jumpToSession, renameSession, revealed } from "./vscode/jump";
import { createLog } from "./vscode/log";
import { notifyFinished, notifyWaiting } from "./vscode/notifications";
import { pickSession } from "./vscode/quickPick";
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
      workspaceFolders: () => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
      globalStorageDir: path.dirname(context.globalStorageUri.fsPath),
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
  /** Opens a session that is not running: the agent resumes it in its panel. */
  const resume = async (id: string) => {
    const view = controller.past.find((p) => p.id === id);
    if (!view || !(await panelAdapter(view.agent)?.resume(id, log))) void vscode.window.showWarningMessage(`Lookout could not resume "${view?.title ?? id}".`);
  };
  const findings = new Findings(context.extensionUri, {
    titleOf: (id) => controller.titleOf(id) ?? id,
    history: (id) => controller.history(id),
    open: async (id) => {
      const live = controller.sessions.find((view) => view.id === id);
      if (live) await jump(live);
      else await resume(id);
    },
  });
  const board = new Board(context.extensionUri, {
    sessions: () => controller.sessions,
    past: () => controller.past,
    resume: (id) => void resume(id),
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
    dismiss: (id) => controller.dismiss(id),
    refreshUsage: () => void controller.refreshUsage(),
    search: (query) => controller.search(query),
    openHit: (query, id, index) => {
      if (!findings.show(id, query, index)) void vscode.window.showInformationMessage(`Lookout has not found the transcript of "${controller.sessions.find((v) => v.id === id)?.title ?? id}" yet.`);
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
    findings,
    controller.onDidChangeUsage(render),
    vscode.window.registerWebviewViewProvider(BOARD_VIEW, board),
    controller.onDidChange(render),
    controller.onDidChange(() => findings.refresh()),
    controller.onDidStartWaiting(async (view) => {
      // A turn that ends on a question is a finished turn too.
      const wanted = config.notifyWaiting || (view.reason?.kind === "typed" && config.notifyDone);
      if (wanted && (await notifyWaiting(view))) await jump(view);
    }),
    controller.onDidFinish(async (view) => {
      if (config.notifyDone && (await notifyFinished(view))) await jump(view);
    }),
    terminals.onDidChange(() => controller.poll()),
    vscode.window.tabGroups.onDidChangeTabs(noticeFocus),
    vscode.window.tabGroups.onDidChangeTabGroups(noticeFocus),
    vscode.window.onDidChangeActiveTerminal(noticeFocus),
    vscode.window.onDidChangeWindowState(noticeFocus),
    vscode.workspace.onDidChangeWorkspaceFolders(() => controller.poll()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("lookout") && !event.affectsConfiguration("claudeCode.environmentVariables")) return;
      const next = readConfig();
      const moved = next.claudeConfigDir !== config.claudeConfigDir;
      config = next;
      if (moved) controller.start(config);
      else controller.configure(config);
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
