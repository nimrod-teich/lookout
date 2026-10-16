import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { countStates } from "../core/format";
import type { SearchResult } from "../core/history";
import type { SessionView } from "../core/types";
import type { BoardUsage, FromBoard, ToBoard } from "../webview/protocol";

export const BOARD_VIEW = "lookout.board";

export interface BoardActions {
  sessions(): readonly SessionView[];
  usage(): BoardUsage | undefined;
  refreshUsage(): void;
  jump(view: SessionView): Promise<void>;
  rename(view: SessionView): Promise<void>;
  markSeen(id: string): void;
  markAllSeen(): void;
  /** Searches the live sessions' conversations. */
  search(query: string): SearchResult[];
  /** Shows a session's conversation in the findings tab, at one message or at the newest match. */
  openHit(query: string, id: string, index: number | undefined): void;
}

/** The session board in the activity bar: one card per session, grouped by state. */
export class Board implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: BoardActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")] };
    view.webview.html = this.html(view.webview);
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => this.receive(message)),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.refresh();
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );
    this.refresh();
  }

  /** Sends the sessions to the board and updates the view's badge. */
  refresh(): void {
    const sessions = this.actions.sessions();
    const counts = countStates(sessions);
    const attention = counts.waiting + counts.done;
    if (this.view) {
      this.view.badge = attention > 0 ? { value: attention, tooltip: `${counts.waiting} need you, ${counts.done} finished` } : undefined;
      if (this.view.visible) {
        const message: ToBoard = { type: "sessions", sessions: [...sessions], now: Date.now(), usage: this.actions.usage() };
        void this.view.webview.postMessage(message);
      }
    }
  }

  private receive(raw: unknown): void {
    const message = raw as Partial<FromBoard>;
    switch (message?.type) {
      case "ready":
        this.refresh();
        return;
      case "jump":
      case "rename":
      case "seen": {
        // The webview can only act on sessions it was shown.
        const view = this.actions.sessions().find((s) => s.id === message.id);
        if (!view) return;
        if (message.type === "jump") void this.actions.jump(view);
        else if (message.type === "rename") void this.actions.rename(view);
        else this.actions.markSeen(view.id);
        return;
      }
      case "seenAll":
        this.actions.markAllSeen();
        return;
      case "refreshUsage":
        this.actions.refreshUsage();
        return;
      case "openHit":
        if (typeof message.query === "string" && typeof message.id === "string" && (message.index === undefined || typeof message.index === "number")) {
          this.actions.openHit(message.query, message.id, message.index);
        }
        return;
      case "search": {
        if (typeof message.query !== "string") return;
        const results: ToBoard = { type: "search", query: message.query, results: this.actions.search(message.query) };
        void this.view?.webview.postMessage(results);
        return;
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "board.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "board.css"));
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
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
