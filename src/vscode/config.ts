import * as vscode from "vscode";
import { resolveConfigDir } from "../core/agents/claude/paths";
import type { RefreshMode } from "../core/usage";

export interface Config {
  statusBarEnabled: boolean;
  statusBarUsage: boolean;
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
  /** The Claude Code config directory to read sessions and transcripts from. */
  claudeConfigDir: string;
}

interface EnvVar {
  name?: unknown;
  value?: unknown;
}

/** `CLAUDE_CONFIG_DIR` as the Claude Code extension passes it to the sessions it hosts. */
function claudeExtensionConfigDir(): string | undefined {
  const vars = vscode.workspace.getConfiguration("claudeCode").get<EnvVar[]>("environmentVariables");
  if (!Array.isArray(vars)) return undefined;
  const entry = vars.find((v) => v?.name === "CLAUDE_CONFIG_DIR");
  return typeof entry?.value === "string" ? entry.value : undefined;
}

function refreshMode(value: string | undefined): RefreshMode {
  return value === "manual" || value === "off" ? value : "auto";
}

export function readConfig(): Config {
  const lookout = vscode.workspace.getConfiguration("lookout");
  return {
    statusBarEnabled: lookout.get<boolean>("statusBar.enabled", true),
    statusBarUsage: lookout.get<boolean>("statusBar.showUsage", true),
    usageRefresh: refreshMode(lookout.get<string>("usage.refresh")),
    notifyWaiting: lookout.get<boolean>("notifications.waiting", true),
    notifyDone: lookout.get<boolean>("notifications.done", false),
    notifyOs: lookout.get<boolean>("notifications.os", true),
    notifySound: lookout.get<boolean>("notifications.sound", false),
    notifyCooldownMs: Math.max(0, lookout.get<number>("notifications.cooldownSeconds", 30)) * 1000,
    typedQuestions: lookout.get<boolean>("state.typedQuestions", true),
    claudeConfigDir: resolveConfigDir({
      setting: lookout.get<string>("claudeConfigDir"),
      claudeExtensionEnv: claudeExtensionConfigDir(),
    }),
  };
}
