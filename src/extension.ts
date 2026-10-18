import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { agentInfo, boardAgents, canJump, canRename, canResume, markersShown } from "./core/agents/catalog";
import { describeAlert, noticeBody } from "./core/format";
import { PAGE_SNIPPET } from "./core/history";
import { nextAttention } from "./core/model";
import { NotifyGate, type NoticeKind } from "./core/notifyGate";
import { desktopOf, jumpKeyLabel } from "./core/osNotify";
import type { SessionView } from "./core/types";
import { pickBar } from "./core/usageGroups";
import { Board, BOARD_VIEW } from "./vscode/board";
import { findClaudeBinary } from "./vscode/claudeBinary";
import { readConfig } from "./vscode/config";
import { panelAdapter } from "./vscode/agents";
import { claudeTabLabel, claudeTabLabels } from "./vscode/agents/claudePanel";
import { Findings } from "./vscode/findings";
import { Controller } from "./vscode/controller";
import { CrossWindowJumps, raiseWindow } from "./vscode/crossWindow";
import { jumpToSession, renameSession, revealed } from "./vscode/jump";
import { createLog } from "./vscode/log";
import { notifyFinished, notifyWaiting } from "./vscode/notifications";
import { OsNotifier } from "./vscode/osNotifier";
import { pickSession } from "./vscode/quickPick";
import { resumeInTerminal } from "./vscode/resume";
import { PAGE_HITS, SearchPage } from "./vscode/searchPage";
import { StatusBar } from "./vscode/statusBar";
import { Terminals } from "./vscode/terminals";

const JUMP = "lookout.jump";
const JUMP_NEXT_ATTENTION = "lookout.jumpNextAttention";
const MARK_ALL_SEEN = "lookout.markAllSeen";
const SHOW_BOARD = "lookout.showBoard";
const REFRESH_USAGE = "lookout.refreshUsage";
const SEARCH = "lookout.search";

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
      restoredTabs: () => ({ labels: claudeTabLabels(), label: claudeTabLabel }),
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
  /** Tell the agents apart, as `lookout.agentMarkers` says: by default once the board shows two or more, running, earlier or in the usage. */
  const markers = () => markersShown(config.agentMarkers, boardAgents({ sessions: controller.sessions, past: controller.past, usage: controller.usageGroups }));
  /** The agent of a live or a past session. */
  const agentOf = (id: string) => (controller.sessions.find((view) => view.id === id) ?? controller.pastView(id))?.agent;

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
    // The UI offers no jump the agent does not allow; this keeps any other way in from failing.
    if (!canJump(view)) return;
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
    if (!canResume(view)) return;
    // An agent of the terminal resumes in a new terminal, in the folder the session worked in.
    if (agentInfo(view.agent).resumesIn === "terminal") {
      const command = controller.resumeCommand(id);
      if (command) resumeInTerminal(view.agent, view.title, command);
      else void vscode.window.showWarningMessage(`Lookout could not resume "${view.title}": its folder is not known.`);
      return;
    }
    if (!(await panelAdapter(view.agent)?.resume(id, log))) void vscode.window.showWarningMessage(`Lookout could not resume "${view.title}".`);
  };
  const findings = new Findings(context.extensionUri, {
    titleOf: (id) => controller.titleOf(id) ?? id,
    agentOf,
    markers,
    whereOf: (id) => controller.whereOf(id),
    history: (id) => controller.history(id),
    open: async (id) => {
      const live = controller.sessions.find((view) => view.id === id);
      if (live) await jump(live);
      else await resume(id);
    },
  });
  /** Opens a session's conversation in the conversation tab, at one message or at its newest match. */
  const openHit = (query: string, id: string, index?: number) => {
    if (!findings.show(id, query, index)) void vscode.window.showInformationMessage(`Lookout has not found the transcript of "${controller.titleOf(id) ?? id}" yet.`);
  };
  const searchPage = new SearchPage(context.extensionUri, {
    search: (query, zone) => controller.search(query, zone, { hits: PAGE_HITS, snippet: PAGE_SNIPPET }),
    titleOf: (id) => controller.titleOf(id) ?? id,
    agentOf,
    markers,
    whereOf: (id) => controller.whereOf(id),
    isLive: (id) => controller.sessions.some((view) => view.id === id && !view.restored),
    spanOf: (id) => {
      const times = (controller.history(id) ?? []).map((message) => message.at).filter((at): at is number => at !== undefined);
      return times.length ? { started: Math.min(...times), lastActive: Math.max(...times) } : {};
    },
    open: openHit,
  });
  const board = new Board(context.extensionUri, {
    sessions: () => controller.sessions,
    past: () => controller.past,
    earlier: () => controller.earlier,
    setEarlierScope: (scope) => controller.setEarlierScope(scope),
    favourites: () => controller.favourites,
    toggleFavourite: (id) => controller.toggleFavourite(id),
    resume: (id) => void resume(id),
    usage: () => controller.usageGroups.map((group) => ({ ...group, canRefresh: group.canRefresh ?? false })),
    usageBar: () => pickBar(controller.usageGroups, config.usageAgent)?.group.agent,
    markers,
    jump,
    rename: async (view) => {
      if (canRename(view)) await renameSession(view, terminals, log);
    },
    markSeen: (id) => controller.markSeen(id),
    markAllSeen: () => controller.markAllSeen(),
    dismiss: (id) => controller.dismiss(id),
    // The command, so the board's link says what the command says when it cannot fetch.
    refreshUsage: () => void vscode.commands.executeCommand(REFRESH_USAGE),
    search: (query, zone) => controller.search(query, zone),
    openHit,
    openSearch: (query, hide) => searchPage.show(query, hide),
  });
  const render = () => {
    statusBar.render({
      // A tab restored after a reload runs nothing until it is opened.
      views: controller.sessions.filter((view) => !view.restored),
      usage: controller.usage,
      usageGroups: controller.usageGroups,
      usageAgent: config.usageAgent,
      markers: markers(),
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
    searchPage,
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
      // A different place to read, or an agent switched on or off: start over.
      const moved =
        next.claudeConfigDir !== config.claudeConfigDir ||
        next.codexEnabled !== config.codexEnabled ||
        next.codexHome !== config.codexHome ||
        next.copilotEnabled !== config.copilotEnabled ||
        next.copilotHome !== config.copilotHome;
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
      // Only the sessions their agent lets Lookout bring forward.
      const view = await pickSession(() => controller.sessions.filter(canJump), controller.onDidChange, markers);
      if (view) await jump(view);
    }),
    vscode.commands.registerCommand(JUMP_NEXT_ATTENTION, async () => {
      const view = nextAttention(controller.sessions, lastJump);
      if (view) await jump(view);
      else void vscode.window.showInformationMessage("Lookout: no session in this window is waiting for you.");
    }),
    vscode.commands.registerCommand(MARK_ALL_SEEN, () => controller.markAllSeen()),
    vscode.commands.registerCommand(SHOW_BOARD, () => vscode.commands.executeCommand(`${BOARD_VIEW}.focus`)),
    vscode.commands.registerCommand(SEARCH, () => searchPage.show("")),
    vscode.commands.registerCommand(REFRESH_USAGE, async () => {
      if (!controller.canRefreshUsage) {
        void vscode.window.showInformationMessage(`Lookout can't fetch usage: ${controller.usageNote ?? "usage refresh is off"}.`);
        return;
      }
      const outcome = await controller.refreshUsage(true);
      if (outcome === "failed") void vscode.window.showWarningMessage("Lookout: Claude Code gave no new usage numbers. Check the Lookout output log.");
    }),
  );

  controller.start(config);
  render();
}

export function deactivate(): void {}
