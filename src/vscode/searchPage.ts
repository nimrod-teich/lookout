import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { SearchOutcome } from "../core/agents/agent";
import type { FromSearch, SearchPageSession, ToSearch } from "../webview/searchProtocol";

export const SEARCH_VIEW_TYPE = "lookout.search";
/** Matches listed per session; the rest are in its conversation. */
export const PAGE_HITS = 20;

export interface SearchPageActions {
  /** Searches every conversation the board covers; `zone` is the page's time zone. */
  search(query: string, zone: number | undefined): SearchOutcome;
  /** The title of a live or a past session. */
  titleOf(id: string): string;
  /** The agent of a live or a past session. */
  agentOf?(id: string): string | undefined;
  /** Tell the agents apart. */
  markers?(): boolean;
  /** Its project, worktree and git branch. */
  whereOf(id: string): string | undefined;
  /** When its conversation began and last moved: its first and last message. */
  spanOf(id: string): { started?: number; lastActive?: number };
  /** It is running now. */
  isLive(id: string): boolean;
  /** Opens a session's conversation in the conversation tab, at one message or at its newest match. */
  open(query: string, id: string, index?: number): void;
}

/**
 * Every conversation's matches in an editor tab, with a search box of its
 * own: the board's search, with the room to read it. One tab, reused.
 */
export class SearchPage implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  /** The query the page runs, sent again when its webview says it is ready. */
  private query = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: SearchPageActions,
  ) {}

  /** Opens the page, or brings it forward, with this query in its box. */
  show(query: string): void {
    this.query = query;
    const panel = this.ensurePanel();
    panel.reveal(undefined, false);
    this.post({ type: "query", query });
  }

  /** The sessions with matches, the newest match first; sessions that operators alone picked come last. */
  private results(query: string, zone: number | undefined): ToSearch {
    const outcome = this.actions.search(query, zone);
    const sessions: SearchPageSession[] = outcome.results.map((result) => ({
      id: result.id,
      title: this.actions.titleOf(result.id),
      agent: this.actions.agentOf?.(result.id),
      where: this.actions.whereOf(result.id),
      live: this.actions.isLive(result.id),
      ...this.actions.spanOf(result.id),
      count: result.count,
      hits: result.hits,
    }));
    const newest = (session: SearchPageSession) => session.hits[0]?.at ?? -Infinity;
    sessions.sort((a, b) => newest(b) - newest(a));
    return { type: "results", query, sessions, pending: outcome.pending, markers: this.actions.markers?.() };
  }

  private post(message: ToSearch): void {
    void this.panel?.webview.postMessage(message);
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) return this.panel;
    const panel = vscode.window.createWebviewPanel(SEARCH_VIEW_TYPE, "Lookout: Search", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw));
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    this.panel = panel;
    return panel;
  }

  private receive(raw: unknown): void {
    const message = raw as Partial<FromSearch>;
    switch (message?.type) {
      case "ready":
        this.post({ type: "query", query: this.query });
        return;
      case "search": {
        if (typeof message.query !== "string") return;
        this.query = message.query;
        const zone = typeof message.zone === "number" && Math.abs(message.zone) <= 24 * 60 ? message.zone : undefined;
        this.post(this.results(message.query, zone));
        return;
      }
      case "open":
        if (typeof message.id !== "string" || typeof message.query !== "string") return;
        this.actions.open(message.query, message.id, typeof message.index === "number" ? message.index : undefined);
        return;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "search.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "search.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Lookout: Search</title>
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
  }
}
