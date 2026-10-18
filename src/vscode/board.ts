import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { countStates } from "../core/format";
import type { SearchOutcome } from "../core/agents/agent";
import type { PastView, SessionView } from "../core/types";
import type { BoardUsage, EarlierInfo, EarlierScope, Favourites, FromBoard, ToBoard } from "../webview/protocol";

export const BOARD_VIEW = "lookout.board";

export interface BoardActions {
  sessions(): readonly SessionView[];
  /** The sessions that are not running, newest first. */
  past(): readonly PastView[];
  /** Which earlier sessions are listed, and how many there are. */
  earlier(): EarlierInfo;
  /** Lists and searches the earlier sessions of this window's folders, or of every project. */
  setEarlierScope(scope: EarlierScope): void;
  /** The starred sessions. */
  favourites(): Favourites;
  /** Stars a session, or takes its star away. */
  toggleFavourite(id: string): void;
  /** Resumes a past session in the agent's panel. */
  resume(id: string): void;
  /** One agent's usage, or each agent's. */
  usage(): BoardUsage | BoardUsage[] | undefined;
  /** The agent whose bar the status bar shows. */
  usageBar?(): string | undefined;
  /** Tell the agents apart. */
  markers?(): boolean;
  refreshUsage(): void;
  jump(view: SessionView): Promise<void>;
  rename(view: SessionView): Promise<void>;
  markSeen(id: string): void;
  markAllSeen(): void;
  /** Dismisses the question a session's last message asks. */
  dismiss(id: string): void;
  /** Searches the live and the past sessions' conversations. */
  /** `zone`: the board's time zone, minutes behind UTC, for the days the query names. */
  search(query: string, zone?: number): SearchOutcome;
  /** Opens the search page with this query, leaving out the agents hidden on the board. */
  openSearch(query: string, hide?: string[]): void;
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
        const message: ToBoard = {
          type: "sessions",
          sessions: [...sessions],
          past: [...this.actions.past()],
          now: Date.now(),
          usage: this.actions.usage(),
          usageBar: this.actions.usageBar?.(),
          markers: this.actions.markers?.(),
          earlier: this.actions.earlier(),
          favourites: this.actions.favourites(),
        };
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
      case "seen":
      case "dismiss": {
        // The webview can only act on sessions it was shown.
        const view = this.actions.sessions().find((s) => s.id === message.id);
        if (!view) return;
        if (message.type === "jump") void this.actions.jump(view);
        else if (message.type === "rename") void this.actions.rename(view);
        else if (message.type === "dismiss") this.actions.dismiss(view.id);
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
      case "openSearch": {
        if (typeof message.query !== "string") return;
        const hide = Array.isArray(message.hide) ? message.hide.filter((agent): agent is string => typeof agent === "string") : [];
        if (hide.length) this.actions.openSearch(message.query, hide);
        else this.actions.openSearch(message.query);
        return;
      }
      case "search": {
        if (typeof message.query !== "string") return;
        const zone = typeof message.zone === "number" && Math.abs(message.zone) <= 24 * 60 ? message.zone : undefined;
        const outcome = this.actions.search(message.query, zone);
        const results: ToBoard = { type: "search", query: message.query, results: outcome.results, pending: outcome.pending };
        void this.view?.webview.postMessage(results);
        return;
      }
      case "resume": {
        // Only a session the board was shown.
        const view = [...this.actions.past(), ...this.actions.favourites().past].find((p) => p.id === message.id);
        if (view) this.actions.resume(view.id);
        return;
      }
      case "favourite": {
        // Only a session the board was shown, or one already starred.
        const id = message.id;
        if (typeof id !== "string") return;
        const known = this.actions.sessions().some((v) => v.id === id) || this.actions.past().some((p) => p.id === id) || this.actions.favourites().ids.includes(id);
        if (known) this.actions.toggleFavourite(id);
        return;
      }
      case "earlierScope":
        if (message.scope === "folders" || message.scope === "all") this.actions.setEarlierScope(message.scope);
        return;
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
