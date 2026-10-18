import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PastView, SessionView } from "../../src/core/types";
import type { BoardUsage, EarlierInfo } from "../../src/webview/protocol";
import { Board } from "../../src/vscode/board";
import { view } from "./helpers";
import { createWebviewView, stub } from "./stub-vscode";

const PAST: PastView[] = [{ id: "00000000-0000-4000-8000-000000000009", agent: "claude-code", title: "Old one", project: "app", cwd: "/work/app", resumable: true, modifiedAt: 1 }];
const EARLIER: EarlierInfo = { scope: "folders", limit: 500, capped: false };

function setup(sessions: SessionView[] = [], usage?: BoardUsage) {
  const actions = { sessions: () => sessions, usage: () => usage, jump: vi.fn(() => Promise.resolve()), rename: vi.fn(() => Promise.resolve()), markSeen: vi.fn(), markAllSeen: vi.fn(),
    dismiss: vi.fn(), refreshUsage: vi.fn(), search: vi.fn((query: string) => ({ results: query === "cache" ? [{ id: "00000000-0000-4000-8000-000000000001", count: 2, hits: [] }] : [], pending: 0 })), openHit: vi.fn(), past: () => PAST, resume: vi.fn(),
    earlier: () => EARLIER, setEarlierScope: vi.fn() };
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
    webviewView.receive({ type: "rename", id: shown.id });
    webviewView.receive({ type: "rename", id: "nope" });
    webviewView.receive({ type: "dismiss", id: shown.id });
    webviewView.receive({ type: "dismiss", id: "nope" });
    webviewView.receive({ type: "seenAll" });
    webviewView.receive("garbage");
    webviewView.receive(null);
    expect(actions.jump).toHaveBeenCalledTimes(1);
    expect(actions.jump).toHaveBeenCalledWith(shown);
    expect(actions.markSeen).toHaveBeenCalledTimes(1);
    expect(actions.rename).toHaveBeenCalledTimes(1);
    expect(actions.rename).toHaveBeenCalledWith(shown);
    expect(actions.markAllSeen).toHaveBeenCalledTimes(1);
    expect(actions.dismiss).toHaveBeenCalledTimes(1);
    expect(actions.dismiss).toHaveBeenCalledWith(shown.id);
  });

  it("sends the usage along with the sessions and relays a refresh request", () => {
    const usage: BoardUsage = { fetchedAt: 1, stale: false, canRefresh: true, meters: [{ key: "session", label: "Session (5hr)", percent: 18 }] };
    const { actions, webviewView } = setup([], usage);
    expect(webviewView.posted[0]).toMatchObject({ type: "sessions", usage });
    webviewView.receive({ type: "refreshUsage" });
    expect(actions.refreshUsage).toHaveBeenCalledTimes(1);
  });

  it("answers a search with the results for that query, and ignores a query that is not a string", () => {
    const { actions, webviewView } = setup([view()]);
    webviewView.receive({ type: "search", query: "cache" });
    webviewView.receive({ type: "search", query: 42 });
    expect(actions.search).toHaveBeenCalledTimes(1);
    expect(webviewView.posted.at(-1)).toEqual({ type: "search", query: "cache", results: [{ id: "00000000-0000-4000-8000-000000000001", count: 2, hits: [] }], pending: 0 });
  });

  it("passes the board's time zone along with a search, and drops one that is not a zone", () => {
    const { actions, webviewView } = setup([view()]);
    webviewView.receive({ type: "search", query: "cache since:today", zone: -180 });
    webviewView.receive({ type: "search", query: "cache", zone: "UTC" });
    webviewView.receive({ type: "search", query: "cache", zone: 100_000 });
    webviewView.receive({ type: "search", query: "cache", zone: Number.NaN });
    expect(actions.search.mock.calls).toEqual([
      ["cache since:today", -180],
      ["cache", undefined],
      ["cache", undefined],
      ["cache", undefined],
    ]);
  });

  it("sends the past sessions with the live ones, and resumes only a past session it showed", () => {
    const { actions, webviewView } = setup([view()]);
    expect(webviewView.posted[0]).toMatchObject({ type: "sessions", past: PAST });
    webviewView.receive({ type: "resume", id: PAST[0]!.id });
    webviewView.receive({ type: "resume", id: "00000000-0000-4000-8000-000000000001" });
    expect(actions.resume).toHaveBeenCalledTimes(1);
    expect(actions.resume).toHaveBeenCalledWith(PAST[0]!.id);
  });

  it("sends which earlier sessions are listed, and relays a change of scope", () => {
    const { actions, webviewView } = setup([view()]);
    expect(webviewView.posted[0]).toMatchObject({ type: "sessions", earlier: EARLIER });
    webviewView.receive({ type: "earlierScope", scope: "all" });
    webviewView.receive({ type: "earlierScope", scope: "folders" });
    webviewView.receive({ type: "earlierScope", scope: "everything" });
    webviewView.receive({ type: "earlierScope" });
    expect(actions.setEarlierScope.mock.calls).toEqual([["all"], ["folders"]]);
  });

  it("relays the requests to open a conversation in the findings tab, at a message or at the newest match", () => {
    const { actions, webviewView } = setup([view()]);
    webviewView.receive({ type: "openHit", query: "cache", id: "00000000-0000-4000-8000-000000000001", index: 4 });
    webviewView.receive({ type: "openHit", query: "cache", id: "00000000-0000-4000-8000-000000000001" });
    webviewView.receive({ type: "openHit", query: "cache", id: "00000000-0000-4000-8000-000000000001", index: "4" });
    webviewView.receive({ type: "openHit", query: 1, id: "00000000-0000-4000-8000-000000000001" });
    expect(actions.openHit).toHaveBeenCalledTimes(2);
    expect(actions.openHit).toHaveBeenNthCalledWith(1, "cache", "00000000-0000-4000-8000-000000000001", 4);
    expect(actions.openHit).toHaveBeenNthCalledWith(2, "cache", "00000000-0000-4000-8000-000000000001", undefined);
  });

  it("stops sending after the view is disposed", () => {
    const { board, webviewView } = setup([view()]);
    webviewView.dispose();
    board.refresh();
    expect(webviewView.posted).toHaveLength(1);
  });
});
