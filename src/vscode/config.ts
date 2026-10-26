import * as vscode from "vscode";
import { agentByKey, markerSetting, type MarkerSetting } from "../core/agents/catalog";
import { resolveConfigDir } from "../core/agents/claude/paths";
import { codexHome } from "../core/agents/codex/paths";
import { copilotHome } from "../core/agents/copilot/paths";
import { envFlag, NONESSENTIAL_TRAFFIC, type RefreshMode } from "../core/usage";

export interface Config {
  statusBarEnabled: boolean;
  statusBarUsage: boolean;
  /** Show when the 5-hour window resets, after the bar. */
  statusBarUsageReset: boolean;
  /** Announce usage thresholds. */
  usageAlerts: boolean;
  /** Claude Code is told not to make nonessential network calls, which fetching usage is, in the environment or the Claude Code extension's settings. */
  usageRefreshDisabled: boolean;
  usageRefresh: RefreshMode;
  notifyWaiting: boolean;
  notifyDone: boolean;
  /** Also notify on the desktop while VS Code is not in front. */
  notifyOs: boolean;
  notifySound: boolean;
  /** Desktop notifications per session and event come at most this often. */
  notifyCooldownMs: number;
  /** An idle session whose last message asks the user something counts as needing them. */
  typedQuestions: boolean;
  /** A session idle or finished this long goes under Parked; 0: never on its own. */
  parkAfterMs: number;
  /** Keep what was said in a conversation after the agent deletes its transcript, under Purged. */
  historyKeep: boolean;
  /** The search keeps what the tool calls ran and returned too: off by default. */
  searchToolOutput: boolean;
  /** Keep a copy of every starred session's transcript, as if Keep Transcript were chosen for it. */
  keepFavourites: boolean;
  /** Watch Claude Code: its sessions and its usage. */
  claudeEnabled: boolean;
  /** The Claude Code config directory to read sessions and transcripts from. */
  claudeConfigDir: string;
  /** When to tell agents apart by hue and silhouette. */
  agentMarkers: MarkerSetting;
  /** Whose usage the status bar's bar shows: `auto` or an agent's key. */
  usageAgent: string;
  /** Watch Codex's sessions. */
  codexEnabled: boolean;
  /** Codex's home, where its sessions are: the setting, `CODEX_HOME`, or `~/.codex`. */
  codexHome: string;
  /** Watch Copilot's sessions. */
  copilotEnabled: boolean;
  /** Copilot's home: the setting, `COPILOT_HOME`, or `~/.copilot`. */
  copilotHome: string;
}

interface EnvVar {
  name?: unknown;
  value?: unknown;
}

/** A variable as the Claude Code extension passes it to the sessions it hosts. */
function claudeExtensionEnv(name: string): string | undefined {
  const vars = vscode.workspace.getConfiguration("claudeCode").get<EnvVar[]>("environmentVariables");
  if (!Array.isArray(vars)) return undefined;
  const entry = vars.find((v) => v?.name === name);
  return typeof entry?.value === "string" ? entry.value : undefined;
}

/** Set for Claude Code in this process's environment or in the Claude Code extension's settings; its own settings file is asked before each refresh. */
function nonessentialTrafficDisabled(): boolean {
  return envFlag(process.env[NONESSENTIAL_TRAFFIC]) || envFlag(claudeExtensionEnv(NONESSENTIAL_TRAFFIC));
}

/** `auto`, or the key of an agent the catalog lists. */
function usageAgent(value: string | undefined): string {
  return value !== undefined && agentByKey(value) ? value : "auto";
}

function refreshMode(value: string | undefined): RefreshMode {
  return value === "manual" || value === "off" ? value : "auto";
}

export function readConfig(): Config {
  const lookout = vscode.workspace.getConfiguration("lookout");
  const claudeConfigDir = resolveConfigDir({
    setting: lookout.get<string>("claudeConfigDir"),
    claudeExtensionEnv: claudeExtensionEnv("CLAUDE_CONFIG_DIR"),
  });
  return {
    statusBarEnabled: lookout.get<boolean>("statusBar.enabled", true),
    statusBarUsage: lookout.get<boolean>("statusBar.showUsage", true),
    statusBarUsageReset: lookout.get<boolean>("statusBar.usageReset", true),
    usageAlerts: lookout.get<boolean>("usage.alerts", true),
    usageRefreshDisabled: nonessentialTrafficDisabled(),
    usageRefresh: refreshMode(lookout.get<string>("usage.refresh")),
    notifyWaiting: lookout.get<boolean>("notifications.waiting", true),
    notifyDone: lookout.get<boolean>("notifications.done", false),
    notifyOs: lookout.get<boolean>("notifications.os", true),
    notifySound: lookout.get<boolean>("notifications.sound", false),
    notifyCooldownMs: Math.max(0, lookout.get<number>("notifications.cooldownSeconds", 30)) * 1000,
    typedQuestions: lookout.get<boolean>("state.typedQuestions", true),
    parkAfterMs: Math.max(0, lookout.get<number>("parkAfterHours", 24)) * 3_600_000,
    historyKeep: lookout.get<boolean>("history.keep", true),
    searchToolOutput: lookout.get<boolean>("search.toolOutput", false),
    keepFavourites: lookout.get<boolean>("keepTranscripts.favourites", false),
    claudeEnabled: lookout.get<boolean>("agents.claude", true),
    claudeConfigDir,
    agentMarkers: markerSetting(lookout.get<string>("agentMarkers")),
    usageAgent: usageAgent(lookout.get<string>("statusBar.usageAgent")),
    codexEnabled: lookout.get<boolean>("agents.codex", true),
    codexHome: codexHome(lookout.get<string>("codexHome")),
    copilotEnabled: lookout.get<boolean>("agents.copilot", true),
    copilotHome: copilotHome(lookout.get<string>("copilotHome")),
  };
}
