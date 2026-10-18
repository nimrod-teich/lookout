import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { HistoryMessage } from "../core/history";
import type { FromFindings, ToFindings } from "../webview/findingsProtocol";

export const FINDINGS_VIEW_TYPE = "lookout.findings";

export interface FindingsActions {
  /** The title of a live or a past session. */
  titleOf(id: string): string;
  /** Its project, worktree and git branch, for the tab's heading. */
  whereOf(id: string): string | undefined;
  /** The conversation of a live or a past session, oldest first. */
  history(id: string): HistoryMessage[] | undefined;
  /** Brings the session's own tab or terminal to the front, or resumes it when it is not running. */
  open(id: string): Promise<void>;
}

/**
 * A session's whole conversation in an editor tab, with a search of its own:
 * opened from the board at a match, kept up to date as the session goes on.
 * One tab, reused; closed by the user like any other.
 */
export class Findings implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  /** What the tab shows, sent again when its webview says it is ready. */
  private last: ToFindings | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: FindingsActions,
  ) {}

  /**
   * Shows the session's conversation with the query applied, scrolled to the
   * message at `index` (or the newest match). False when Lookout has no
   * transcript for the session.
   */
  show(id: string, query: string, index?: number): boolean {
    const message = this.conversation(id, query, index);
    if (!message) return false;
    this.send(message);
    return true;
  }

  /** Sends the conversation again when it grew since the tab last saw it. */
  refresh(): void {
    if (!this.panel || !this.last) return;
    const messages = this.actions.history(this.last.session.id);
    if (!messages || messages.length === this.last.messages.length) return;
    this.send(this.conversation(this.last.session.id, this.last.query, undefined)!);
  }

  private conversation(id: string, query: string, target: number | undefined): ToFindings | undefined {
    const messages = this.actions.history(id);
    if (!messages) return undefined;
    return { type: "conversation", session: { id, title: this.actions.titleOf(id), where: this.actions.whereOf(id) }, messages: messages.map((message, index) => ({ index, ...message })), query, target };
  }

  private send(message: ToFindings): void {
    this.last = message;
    const panel = this.ensurePanel();
    panel.title = `Lookout: ${message.session.title}`;
    panel.reveal(undefined, false);
    void panel.webview.postMessage(message);
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) return this.panel;
    const panel = vscode.window.createWebviewPanel(FINDINGS_VIEW_TYPE, "Lookout", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw));
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.last = undefined;
      }
    });
    this.panel = panel;
    return panel;
  }

  private receive(raw: unknown): void {
    const message = raw as Partial<FromFindings>;
    switch (message?.type) {
      case "ready":
        if (this.last) void this.panel?.webview.postMessage(this.last);
        return;
      case "jump":
        if (typeof message.id === "string") void this.actions.open(message.id);
        return;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "findings.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "findings.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Lookout</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.last = undefined;
  }
}
