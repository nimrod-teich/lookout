import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { clockTime, describeAlert, noticeBody } from "./core/format";
import { nextAttention } from "./core/model";
import { NotifyGate, type NoticeKind } from "./core/notifyGate";
import { desktopOf, jumpKeyLabel } from "./core/osNotify";
import type { SessionView } from "./core/types";
import { Board, BOARD_VIEW } from "./vscode/board";
import { findClaudeBinary } from "./vscode/claudeBinary";
import { readConfig } from "./vscode/config";
import { panelAdapter } from "./vscode/agents";
import { Findings } from "./vscode/findings";
import { Controller } from "./vscode/controller";
import { CrossWindowJumps, raiseWindow } from "./vscode/crossWindow";
import { jumpToSession, renameSession, revealed } from "./vscode/jump";
import { createLog } from "./vscode/log";
import { notifyFinished, notifyWaiting } from "./vscode/notifications";
import { OsNotifier } from "./vscode/osNotifier";
import { pickSession } from "./vscode/quickPick";
import { StatusBar } from "./vscode/statusBar";
import { Terminals } from "./vscode/terminals";

const JUMP = "lookout.jump";
const JUMP_NEXT_ATTENTION = "lookout.jumpNextAttention";
const MARK_ALL_SEEN = "lookout.markAllSeen";
const SHOW_BOARD = "lookout.showBoard";
const REFRESH_USAGE = "lookout.refreshUsage";

/** WSL reports itself as Linux; its kernel says otherwise. */
function insideWsl(): boolean {
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const log = createLog();
  const terminals = new Terminals();
  const sharedDir = path.join(context.globalStorageUri.fsPath, "windows");
  const controller = new Controller(
    {
      pid: process.pid,
      label: vscode.workspace.name ?? "untitled window",
      sharedDir,
      state: context.workspaceState,
      globalState: context.globalState,
      usageDir: path.join(context.globalStorageUri.fsPath, "usage"),
      focused: () => vscode.window.state.focused,
      claudeBinary: findClaudeBinary,
      workspaceFolders: () => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
      globalStorageDir: path.dirname(context.globalStorageUri.fsPath),
    },
    terminals,
    log,
  );
  const statusBar = new StatusBar(JUMP);
  let config = readConfig();
  const desktop = desktopOf(process.platform, vscode.env.remoteName, process.platform === "linux" && insideWsl());
  const osNotifier = new OsNotifier(desktop, log);
  const gate = new NotifyGate(config.notifyCooldownMs);
  /** A desktop notification too, while VS Code is not the window in front. */
  const notifyDesktop = (view: SessionView, kind: NoticeKind) => {
    if (!config.notifyOs || vscode.window.state.focused) return;
    const needYou = controller.sessions.filter((v) => v.state === "waiting").map((v) => v.title);
    const message = gate.decide({ id: view.id, kind, title: view.title, body: noticeBody(view, kind === "finished") }, needYou, `Lookout · ${jumpKeyLabel(desktop)} in VS Code jumps to the next one that needs you`, Date.now());
    if (message) osNotifier.send(message, config.notifySound);
  };
  /** The session the last "next" jump went to, so repeated presses cycle through them. */
  let lastJump: string | undefined;

  // Sessions hosted by the other windows on this host are jumped to through those windows.
  const crossWindow = new CrossWindowJumps({
    pid: process.pid,
    dir: sharedDir,
    find: (id) => controller.sessions.find((view) => view.id === id),
    reveal: async (view) => {
      const shown = revealed(await jumpToSession(view, terminals, log));
      if (shown) controller.markSeen(view.id);
      return shown;
    },
    // On a Mac the extension host's parent is the application's main process, which AppleScript addresses by pid.
    raise: () => raiseWindow(desktop, { title: vscode.workspace.name ?? "", app: vscode.env.appName, appPid: desktop === "macos" ? process.ppid : undefined }, log),
    registryChanged: () => controller.windowsChanged(),
    log,
  });
  // The key that switches between windows of one application: GNOME keeps Alt+Tab for applications.
  const switchKey = desktop === "macos" ? "⌘`" : desktop === "linux" && /gnome/i.test(process.env.XDG_CURRENT_DESKTOP ?? "") ? "Alt+`" : "Alt+Tab";
  const jumpToOtherWindow = async (view: SessionView) => {
    const window = view.windowLabel ? `window "${view.windowLabel}"` : "the other window";
    switch (await crossWindow.request(view)) {
      case "raised":
        return;
      case "opened":
        void vscode.window.showInformationMessage(`Opened "${view.title}" in ${window}; switch with ${switchKey}.`);
        return;
      case "not found":
        void vscode.window.showWarningMessage(`The ${window.replace(/^the /, "")} could not bring "${view.title}" forward.`);
        return;
      case "no answer":
        void vscode.window.showWarningMessage(`The ${window.replace(/^the /, "")} did not answer in time: it may run an older Lookout, or be busy. Switch to it with ${switchKey}.`);
        return;
      case "not sent":
        void vscode.window.showWarningMessage(`Lookout could not reach ${window}.`);
    }
  };

  const jump = async (view: SessionView) => {
    lastJump = view.id;
    if (view.host === "window") return jumpToOtherWindow(view);
    if (revealed(await jumpToSession(view, terminals, log))) controller.markSeen(view.id);
  };
  /** Opens a session that is not running: the agent resumes it in its panel, when it belongs to this window's folders. */
  const resume = async (id: string) => {
    const view = controller.pastView(id);
    if (!view) {
      void vscode.window.showWarningMessage("Lookout could not resume that session: it is no longer listed under Earlier.");
      return;
    }
    if (!view.resumable) {
      void vscode.window.showInformationMessage(`"${view.title}" is from ${view.cwd || "another project"}, not one of this window's folders: the agent resumes it from a window open on that folder.`);
      return;
    }
    if (!(await panelAdapter(view.agent)?.resume(id, log))) void vscode.window.showWarningMessage(`Lookout could not resume "${view.title}".`);
  };
  const findings = new Findings(context.extensionUri, {
    titleOf: (id) => controller.titleOf(id) ?? id,
    whereOf: (id) => controller.whereOf(id),
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
    earlier: () => controller.earlier,
    setEarlierScope: (scope) => controller.setEarlierScope(scope),
    resume: (id) => void resume(id),
    usage: () => {
      const usage = controller.usage;
      return { fetchedAt: usage?.fetchedAt, stale: usage?.stale ?? false, meters: usage?.meters ?? [], pace: usage?.pace ?? {}, canRefresh: controller.canRefreshUsage, note: controller.usageNote };
    },
    jump,
    rename: async (view) => {
      await renameSession(view, terminals, log);
    },
    markSeen: (id) => controller.markSeen(id),
    markAllSeen: () => controller.markAllSeen(),
    dismiss: (id) => controller.dismiss(id),
    // The command, so the board's link says what the command says when it cannot fetch.
    refreshUsage: () => void vscode.commands.executeCommand(REFRESH_USAGE),
    search: (query, zone) => controller.search(query, zone),
    openHit: (query, id, index) => {
      if (!findings.show(id, query, index)) void vscode.window.showInformationMessage(`Lookout has not found the transcript of "${controller.sessions.find((v) => v.id === id)?.title ?? id}" yet.`);
    },
  });
  const render = () => {
    statusBar.render({
      views: controller.sessions,
      usage: controller.usage,
      usageNote: controller.usageNote,
      enabled: config.statusBarEnabled,
      showUsage: config.statusBarUsage,
      showReset: config.statusBarUsageReset,
      canRefreshUsage: controller.canRefreshUsage,
    });
    board.refresh();
  };
  const noticeFocus = () => controller.noticeFocus();

  context.subscriptions.push(
    log,
    terminals,
    controller,
    crossWindow,
    statusBar,
    board,
    findings,
    controller.onDidChangeUsage(render),
    controller.onDidReachUsageThreshold((alert) => {
      const said = describeAlert(alert.meter);
      void vscode.window.showWarningMessage(`Lookout: ${said.text}`);
      if (config.notifyOs && !vscode.window.state.focused) osNotifier.send({ title: said.title, body: `${said.body}\nLookout`, tag: alert.id }, config.notifySound);
    }),
    vscode.window.registerWebviewViewProvider(BOARD_VIEW, board),
    controller.onDidChange(render),
    controller.onDidChange(() => findings.refresh()),
    controller.onDidStartWaiting(async (view) => {
      // A turn that ends on a question is a finished turn too.
      if (!config.notifyWaiting && !(view.reason?.kind === "typed" && config.notifyDone)) return;
      notifyDesktop(view, "waiting");
      if (await notifyWaiting(view)) await jump(view);
    }),
    controller.onDidFinish(async (view) => {
      if (!config.notifyDone) return;
      notifyDesktop(view, "finished");
      if (await notifyFinished(view)) await jump(view);
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
      gate.setCooldown(config.notifyCooldownMs);
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
        void vscode.window.showInformationMessage(`Lookout can't fetch usage: ${controller.usageNote ?? "usage refresh is off"}.`);
        return;
      }
      const outcome = await controller.refreshUsage(true);
      if (outcome === "too soon") void vscode.window.showInformationMessage(`Lookout fetches usage at most every 3 minutes on this machine; next at ${clockTime(controller.nextRefreshAt(true))}.`);
      else if (outcome === "failed") void vscode.window.showWarningMessage("Lookout: Claude Code gave no new usage numbers. Check the Lookout output log.");
    }),
  );

  controller.start(config);
  render();
}

export function deactivate(): void {}
