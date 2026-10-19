import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchOutcome } from "../../src/core/agents/agent";
import { SearchPage } from "../../src/vscode/searchPage";
import { stub } from "./stub-vscode";

const OLD = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-000000000002";
const PICKED = "00000000-0000-4000-8000-000000000003";

const hit = (index: number, at: number) => ({ index, role: "you" as const, at, snippet: `deploy ${index}`, ranges: [[0, 6]] as [number, number][] });

function setup() {
  const outcome: SearchOutcome = {
    results: [
      { id: OLD, count: 1, hits: [hit(4, 1_000)] },
      { id: PICKED, count: 0, hits: [] },
      { id: NEW, count: 30, hits: [hit(9, 5_000), hit(7, 4_000)] },
    ],
    pending: 2,
  };
  const actions = {
    search: vi.fn<(query: string, zone: number | undefined) => SearchOutcome>(() => outcome),
    titleOf: (id: string) => ({ [OLD]: "Old deploy", [NEW]: "New deploy", [PICKED]: "Picked" })[id] ?? id,
    whereOf: (id: string) => (id === NEW ? "api · ⎇ fix-login" : undefined),
    isLive: (id: string) => id === NEW,
    spanOf: (id: string) => (id === NEW ? { started: 1_000, lastActive: 5_000 } : {}),
    open: vi.fn(),
  };
  const page = new SearchPage({ fsPath: "/ext" } as never, actions);
  return { page, actions };
}

describe("SearchPage", () => {
  beforeEach(() => stub.reset());

  it("sends its results again as more conversations are read, once it has searched, saying it follows", () => {
    const { page, actions } = setup();
    const follows = Object.assign(actions, { follows: () => true });
    const followed = new SearchPage({ fsPath: "/ext" } as never, follows);
    followed.followSearch();
    expect(actions.search).not.toHaveBeenCalled();
    followed.show("deploy");
    const panel = stub.panels.at(-1)!;
    // The query is in its box, but the page has not asked yet.
    followed.followSearch();
    expect(actions.search).not.toHaveBeenCalled();
    panel.receive({ type: "search", query: "deploy", zone: 120 });
    expect(panel.posted.at(-1)).toMatchObject({ type: "results", query: "deploy", pending: 2, follows: true });
    followed.followSearch();
    expect(actions.search).toHaveBeenCalledTimes(2);
    expect(actions.search).toHaveBeenLastCalledWith("deploy", 120);
    // Closed: nothing more is sent.
    panel.dispose();
    followed.followSearch();
    expect(actions.search).toHaveBeenCalledTimes(2);
    page.dispose();
  });

  it("passes on the agents hidden on the board, to leave them out", () => {
    const { page } = setup();
    page.show("deploy", ["codex"]);
    expect(stub.panels[0]!.posted.at(-1)).toEqual({ type: "query", query: "deploy", hide: ["codex"] });
    page.show("deploy");
    expect(stub.panels[0]!.posted.at(-1)).toEqual({ type: "query", query: "deploy" });
  });

  it("opens one tab with the query in its box, and runs a search the page asks for", () => {
    const { page, actions } = setup();
    page.show("deploy");
    expect(stub.panels).toHaveLength(1);
    const panel = stub.panels[0]!;
    expect(panel.viewType).toBe("lookout.search");
    expect(panel.title).toBe("Lookout: Search");
    expect(panel.webview.html).toContain("dist/search.js");
    expect(panel.webview.html).toContain("media/search.css");
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(panel.posted.at(-1)).toEqual({ type: "query", query: "deploy" });
    panel.receive({ type: "search", query: "deploy since:today", zone: -180 });
    expect(actions.search).toHaveBeenCalledWith("deploy since:today", -180);
    // The newest match first; a session the operators picked without matches last.
    expect(panel.posted.at(-1)).toEqual({
      type: "results",
      query: "deploy since:today",
      pending: 2,
      sessions: [
        { id: NEW, title: "New deploy", where: "api · ⎇ fix-login", live: true, started: 1_000, lastActive: 5_000, count: 30, hits: [hit(9, 5_000), hit(7, 4_000)] },
        { id: OLD, title: "Old deploy", where: undefined, live: false, count: 1, hits: [hit(4, 1_000)] },
        { id: PICKED, title: "Picked", where: undefined, live: false, count: 0, hits: [] },
      ],
    });
    page.show("other");
    expect(stub.panels).toHaveLength(1);
    expect(panel.posted.at(-1)).toEqual({ type: "query", query: "other" });
  });

  it("drops a zone that is not one, ignores what does not parse, and sends the query again when the page is ready", () => {
    const { page, actions } = setup();
    page.show("deploy");
    const panel = stub.panels[0]!;
    panel.receive({ type: "search", query: "deploy", zone: 100_000 });
    panel.receive({ type: "search", query: 42 });
    panel.receive("garbage");
    expect(actions.search.mock.calls).toEqual([["deploy", undefined]]);
    panel.receive({ type: "ready" });
    expect(panel.posted.at(-1)).toEqual({ type: "query", query: "deploy" });
  });

  it("opens a conversation at a match, or at its newest match", () => {
    const { page, actions } = setup();
    page.show("deploy");
    const panel = stub.panels[0]!;
    panel.receive({ type: "open", query: "deploy", id: NEW, index: 7 });
    panel.receive({ type: "open", query: "deploy", id: OLD });
    panel.receive({ type: "open", query: "deploy", id: 5 });
    panel.receive({ type: "open", id: OLD });
    expect(actions.open.mock.calls).toEqual([
      ["deploy", NEW, 7],
      ["deploy", OLD, undefined],
    ]);
  });

  it("starts afresh after the tab is closed", () => {
    const { page } = setup();
    page.show("deploy");
    stub.panels[0]!.dispose();
    page.show("again");
    expect(stub.panels).toHaveLength(2);
    page.dispose();
  });
});
