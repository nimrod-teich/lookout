import * as vscode from "vscode";
import { resolveConfigDir } from "../core/agents/claude/paths";

export interface Config {
  statusBarEnabled: boolean;
  notifyWaiting: boolean;
  notifyDone: boolean;
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

export function readConfig(): Config {
  const lookout = vscode.workspace.getConfiguration("lookout");
  return {
    statusBarEnabled: lookout.get<boolean>("statusBar.enabled", true),
    notifyWaiting: lookout.get<boolean>("notifications.waiting", true),
    notifyDone: lookout.get<boolean>("notifications.done", false),
    claudeConfigDir: resolveConfigDir({
      setting: lookout.get<string>("claudeConfigDir"),
      claudeExtensionEnv: claudeExtensionConfigDir(),
    }),
  };
}
