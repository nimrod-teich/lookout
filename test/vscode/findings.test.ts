import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryMessage } from "../../src/core/history";
import { Findings } from "../../src/vscode/findings";
import { stub } from "./stub-vscode";

const ID = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function setup() {
  const history: Record<string, HistoryMessage[]> = {
    [ID]: [
      { role: "you", at: 1, text: "Fix the billing webhook" },
      { role: "agent", at: 2, text: "Looking" },
    ],
  };
  const actions = {
    titleOf: (id: string) => (id === ID ? "Webhooks" : id),
    whereOf: (id: string) => (id === ID ? "api · ⎇ fix-login" : undefined),
    history: vi.fn((id: string) => history[id]),
    open: vi.fn(() => Promise.resolve()),
  };
  const findings = new Findings({ fsPath: "/ext" } as never, actions);
  return { findings, actions, history };
}

describe("Findings", () => {
  beforeEach(() => stub.reset());

  it("opens one tab with the session's whole conversation, the query and the message to land on", () => {
    const { findings } = setup();
    expect(findings.show(ID, "billing", 0)).toBe(true);
    expect(stub.panels).toHaveLength(1);
    const panel = stub.panels[0]!;
    expect(panel.viewType).toBe("lookout.findings");
    expect(panel.title).toBe("Lookout: Webhooks");
    expect(panel.webview.html).toContain("dist/findings.js");
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(panel.posted.at(-1)).toEqual({
      type: "conversation",
      session: { id: ID, title: "Webhooks", where: "api · ⎇ fix-login" },
      messages: [
        { index: 0, role: "you", at: 1, text: "Fix the billing webhook" },
        { index: 1, role: "agent", at: 2, text: "Looking" },
      ],
      query: "billing",
      target: 0,
    });
    expect(findings.show(ID, "billing")).toBe(true);
    expect(stub.panels).toHaveLength(1);
    expect(panel.posted.at(-1)).toMatchObject({ target: undefined });
    expect(stub.ops.filter(([target, action]) => target === "panel:lookout.findings" && action === "reveal")).toHaveLength(2);
  });

  it("refuses a session it has no transcript for, and opens nothing", () => {
    const { findings } = setup();
    expect(findings.show(OTHER, "billing", 3)).toBe(false);
    expect(stub.panels).toHaveLength(0);
  });

  it("sends the conversation again only when it grew, keeping the query", () => {
    const { findings, history } = setup();
    findings.show(ID, "billing", 0);
    const panel = stub.panels[0]!;
    findings.refresh();
    expect(panel.posted).toHaveLength(1);
    history[ID]!.push({ role: "agent", at: 3, text: "The billing webhook retries twice" });
    findings.refresh();
    expect(panel.posted).toHaveLength(2);
    expect(panel.posted[1]).toMatchObject({ query: "billing", target: undefined, messages: [{ index: 0 }, { index: 1 }, { index: 2, text: "The billing webhook retries twice" }] });
  });

  it("opens the session on request, sends the last view again on ready, and starts afresh after the tab is closed", () => {
    const { findings, actions } = setup();
    findings.show(ID, "billing", 1);
    const panel = stub.panels[0]!;
    panel.receive({ type: "jump", id: ID });
    expect(actions.open).toHaveBeenCalledWith(ID);
    panel.receive({ type: "jump", id: 5 });
    expect(actions.open).toHaveBeenCalledTimes(1);
    panel.receive({ type: "ready" });
    expect(panel.posted).toHaveLength(2);
    expect(panel.posted[1]).toEqual(panel.posted[0]);
    panel.dispose();
    findings.refresh();
    expect(stub.panels).toHaveLength(1);
    findings.show(ID, "");
    expect(stub.panels).toHaveLength(2);
    findings.dispose();
    expect(stub.ops.filter(([, action]) => action === "dispose")).toHaveLength(2);
  });
});
