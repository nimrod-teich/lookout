import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../../src/core/types";
import { Board } from "../../src/vscode/board";
import { view } from "./helpers";
import { createWebviewView, stub } from "./stub-vscode";

function setup(sessions: SessionView[] = []) {
  const actions = { sessions: () => sessions, jump: vi.fn(() => Promise.resolve()), markSeen: vi.fn(), markAllSeen: vi.fn() };
  const board = new Board({ fsPath: "/ext" } as never, actions);
  const webviewView = createWebviewView();
  board.resolveWebviewView(webviewView as never);
  return { board, actions, webviewView };
}

describe("Board", () => {
  beforeEach(() => stub.reset());

  it("serves a page that loads only its own script and stylesheet", () => {
    const { webviewView } = setup();
    const html = webviewView.webview.html;
    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}" src="https://stub.webview/ext/dist/board.js">`);
    expect(html).toContain('href="https://stub.webview/ext/media/board.css"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`style-src ${webviewView.webview.cspSource}`);
    expect(webviewView.webview.options).toMatchObject({ enableScripts: true });
  });

  it("sends the sessions when the page is ready and whenever it refreshes", () => {
    const sessions = [view({ state: "working" })];
    const { board, webviewView } = setup(sessions);
    expect(webviewView.posted).toHaveLength(1);
    webviewView.receive({ type: "ready" });
    board.refresh();
    expect(webviewView.posted).toHaveLength(3);
    expect(webviewView.posted[2]).toMatchObject({ type: "sessions", sessions: [{ id: sessions[0]!.id, state: "working" }] });
    expect(typeof (webviewView.posted[2] as { now: number }).now).toBe("number");
  });

  it("holds messages while hidden and sends on becoming visible", () => {
    const { board, webviewView } = setup([view()]);
    webviewView.setVisible(false);
    board.refresh();
    expect(webviewView.posted).toHaveLength(1);
    webviewView.setVisible(true);
    expect(webviewView.posted).toHaveLength(2);
  });

  it("shows how many sessions need attention on the view's badge", () => {
    const sessions: SessionView[] = [view({ id: "a", state: "waiting" }), view({ id: "b", state: "done" }), view({ id: "c", state: "working" })];
    const { board, webviewView } = setup(sessions);
    expect(webviewView.badge).toEqual({ value: 2, tooltip: "1 need you, 1 finished" });
    sessions.length = 0;
    board.refresh();
    expect(webviewView.badge).toBeUndefined();
  });

  it("acts only on sessions it was shown", async () => {
    const shown = view({ id: "00000000-0000-4000-8000-000000000001" });
    const { actions, webviewView } = setup([shown]);
    webviewView.receive({ type: "jump", id: shown.id });
    webviewView.receive({ type: "jump", id: "00000000-0000-4000-8000-000000000002" });
    webviewView.receive({ type: "seen", id: shown.id });
    webviewView.receive({ type: "seen", id: 42 });
    webviewView.receive({ type: "seenAll" });
    webviewView.receive("garbage");
    webviewView.receive(null);
    expect(actions.jump).toHaveBeenCalledTimes(1);
    expect(actions.jump).toHaveBeenCalledWith(shown);
    expect(actions.markSeen).toHaveBeenCalledTimes(1);
    expect(actions.markAllSeen).toHaveBeenCalledTimes(1);
  });

  it("stops sending after the view is disposed", () => {
    const { board, webviewView } = setup([view()]);
    webviewView.dispose();
    board.refresh();
    expect(webviewView.posted).toHaveLength(1);
  });
});
