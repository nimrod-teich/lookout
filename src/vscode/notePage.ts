import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { NOTE_MAX } from "../core/sessionRecords";
import type { FromNote, NoteItem, ToNote } from "../webview/noteProtocol";

export const NOTE_VIEW_TYPE = "lookout.note";

export interface NotePageActions {
  /** The title of a live or a past session. */
  titleOf(id: string): string;
  /** Its project, worktree and git branch, for the page's heading. */
  whereOf(id: string): string | undefined;
  agentOf?(id: string): string | undefined;
  /** Tell the agents apart. */
  markers?(): boolean;
  /** The notes on the session, oldest first. */
  notesOf(id: string): NoteItem[];
  /** Adds a note; false when Lookout cannot. */
  addNote(id: string, text: string): boolean;
  /** Changes one note; a blank text takes it away. False when Lookout cannot. */
  editNote(id: string, noteId: string, text: string): boolean;
  /** Takes one note away. False when Lookout cannot. */
  removeNote(id: string, noteId: string): boolean;
  /** The session is running now. */
  isLive?(id: string): boolean;
  /** Brings the session's own tab or terminal to the front, or resumes it when it is not running. */
  open(id: string): Promise<void>;
  /** `open` can reach the session. */
  openable?(id: string): boolean;
}

/**
 * A page of its own for the notes on a session: the session at the top,
 * the notes under it as a thread, each with its time, and a box for the
 * next one. One tab per session, reused; closed by the user like any other.
 */
export class NotePage implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: NotePageActions,
  ) {}

  /** Opens the notes on a session, or brings their tab forward. */
  show(id: string): void {
    const panel = this.ensurePanel(id);
    panel.title = this.titleFor(id);
    panel.reveal(undefined, false);
    void panel.webview.postMessage(this.state(id));
  }

  /** The open pages hear of their sessions again: a title changed, or another window wrote a note. */
  refresh(): void {
    for (const [id, panel] of this.panels) {
      const title = this.titleFor(id);
      if (panel.title !== title) panel.title = title;
      void panel.webview.postMessage(this.state(id));
    }
  }

  private titleFor(id: string): string {
    return `Notes: ${this.actions.titleOf(id)}`;
  }

  private state(id: string): ToNote {
    return {
      type: "notes",
      session: { id, title: this.actions.titleOf(id), where: this.actions.whereOf(id), agent: this.actions.agentOf?.(id), live: this.actions.isLive?.(id) === true, ...(this.actions.openable?.(id) === false ? { openable: false } : {}) },
      notes: this.actions.notesOf(id),
      max: NOTE_MAX,
      markers: this.actions.markers?.(),
    };
  }

  private ensurePanel(id: string): vscode.WebviewPanel {
    const open = this.panels.get(id);
    if (open) return open;
    const panel = vscode.window.createWebviewPanel(NOTE_VIEW_TYPE, "Lookout: Notes", vscode.ViewColumn.Active, {
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
    let ok: boolean | undefined;
    switch (message?.type) {
      case "ready":
        void panel.webview.postMessage(this.state(id));
        return;
      case "add":
        ok = typeof message.text === "string" && this.actions.addNote(id, message.text);
        break;
      case "edit":
        ok = typeof message.noteId === "string" && typeof message.text === "string" && this.actions.editNote(id, message.noteId, message.text);
        break;
      case "remove":
        ok = typeof message.noteId === "string" && this.actions.removeNote(id, message.noteId);
        break;
      case "open":
        void this.actions.open(id);
        return;
      default:
        return;
    }
    // The thread as it is now, whether the change took or not; a change that did not is said.
    void panel.webview.postMessage(ok ? this.state(id) : { type: "failed", id });
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
<title>Lookout: Notes</title>
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
