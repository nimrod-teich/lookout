import * as vscode from "vscode";
import { agentInfo } from "../core/agents/catalog";
import type { ResumeCommand } from "../core/agents/agent";

/** One argument as a POSIX shell reads it: bare when it is plain, else single-quoted. */
export function shellArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resumes a session in a new terminal, in the folder it worked in, for an
 * agent whose sessions resume there: the terminal is named after the agent
 * and the session, gets the command's variables, and is shown.
 */
export function resumeInTerminal(agent: string, title: string, command: ResumeCommand): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name: `${agentInfo(agent).label}: ${title}`, cwd: command.cwd, ...(command.env ? { env: command.env } : {}) });
  terminal.sendText(command.args.map(shellArg).join(" "), true);
  terminal.show(false);
  return terminal;
}
