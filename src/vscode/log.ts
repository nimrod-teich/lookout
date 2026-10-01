import * as vscode from "vscode";

export interface Log extends vscode.Disposable {
  info(message: string): void;
  /** Logs an error once per distinct message, so a failing poll doesn't flood the channel. */
  errorOnce(message: string): void;
}

export function createLog(): Log {
  const channel = vscode.window.createOutputChannel("Lookout");
  const seen = new Set<string>();
  const write = (level: string, message: string) => channel.appendLine(`${new Date().toISOString()} [${level}] ${message}`);
  return {
    info: (message) => write("info", message),
    errorOnce: (message) => {
      if (seen.has(message)) return;
      seen.add(message);
      write("error", message);
    },
    dispose: () => channel.dispose(),
  };
}
