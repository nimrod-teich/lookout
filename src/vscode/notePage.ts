import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { NOTE_MAX } from "../core/sessionRecords";
import type { FromNote, ToNote } from "../webview/noteProtocol";

export const NOTE_VIEW_TYPE = "lookout.note";

export interface NotePageActions {
  /** The title of a live or a past session. */
  titleOf(id: string): string;
  /** Its project, worktree and git branch, for the page's heading. */
  whereOf(id: string): string | undefined;
  agentOf?(id: string): string | undefined;
  /** Tell the agents apart. */
  markers?(): boolean;
  /** The note on the session, and when it was written; nothing for none. */
  noteOf(id: string): { note: string; noteAt?: number } | undefined;
  /** Keeps the note, or takes it away for undefined; false when Lookout cannot. */
  setNote(id: string, note: string | undefined): boolean;
  /** The session is running now. */
  isLive?(id: string): boolean;
  /** Brings the session's own tab or terminal to the front, or resumes it when it is not running. */
  open(id: string): Promise<void>;
  /** `open` can reach the session. */
  openable?(id: string): boolean;
}

/**
 * A page of its own for the note on a session: the session at the top, the
 * note under it, as many lines as it takes, kept on Ctrl+S or the button.
 * One tab per session, reused; closed by the user like any other.
 */
export class NotePage implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: NotePageActions,
  ) {}

  /** Opens the note on a session, or brings its tab forward. */
  show(id: string): void {
    const panel = this.ensurePanel(id);
    panel.title = this.titleFor(id);
    panel.reveal(undefined, false);
    void panel.webview.postMessage(this.state(id));
  }

  /** The open pages hear of their sessions again: a title changed, or another window wrote the note. */
  refresh(): void {
    for (const [id, panel] of this.panels) {
      const title = this.titleFor(id);
      if (panel.title !== title) panel.title = title;
      void panel.webview.postMessage(this.state(id));
    }
  }

  private titleFor(id: string): string {
    return `Note: ${this.actions.titleOf(id)}`;
  }

  private state(id: string): ToNote {
    const kept = this.actions.noteOf(id);
    return {
      type: "note",
      session: { id, title: this.actions.titleOf(id), where: this.actions.whereOf(id), agent: this.actions.agentOf?.(id), live: this.actions.isLive?.(id) === true, ...(this.actions.openable?.(id) === false ? { openable: false } : {}) },
      note: kept?.note,
      ...(kept?.noteAt !== undefined ? { noteAt: kept.noteAt } : {}),
      max: NOTE_MAX,
      markers: this.actions.markers?.(),
    };
  }

  private ensurePanel(id: string): vscode.WebviewPanel {
    const open = this.panels.get(id);
    if (open) return open;
    const panel = vscode.window.createWebviewPanel(NOTE_VIEW_TYPE, "Lookout: Note", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((raw: unknown) => this.receive(id, panel, raw));
    panel.onDidDispose(() => {
      if (this.panels.get(id) === panel) this.panels.delete(id);
    });
    this.panels.set(id, panel);
    return panel;
  }

  private receive(id: string, panel: vscode.WebviewPanel, raw: unknown): void {
    const message = raw as Partial<FromNote>;
    switch (message?.type) {
      case "ready":
        void panel.webview.postMessage(this.state(id));
        return;
      case "save":
      case "remove": {
        const text = message.type === "save" && typeof message.text === "string" ? message.text : undefined;
        const ok = this.actions.setNote(id, text);
        const kept = ok ? this.actions.noteOf(id) : undefined;
        const answer: ToNote = ok ? { type: "saved", id, note: kept?.note, ...(kept?.noteAt !== undefined ? { noteAt: kept.noteAt } : {}) } : { type: "failed", id };
        void panel.webview.postMessage(answer);
        return;
      }
      case "open":
        void this.actions.open(id);
        return;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "note.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "note.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Lookout: Note</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
