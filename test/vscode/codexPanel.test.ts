import { beforeEach, describe, expect, it } from "vitest";
import { codexPanel } from "../../src/vscode/agents/codexPanel";
import { view } from "./helpers";
import { stub, TabInputCustom, Uri } from "./stub-vscode";

const THREAD = "01a14f9b-ad80-7b82-adf4-949abb052b7a";
const OTHER = "01a14f98-8a19-7a12-bb1b-f3a74309ea7f";
const log = { info: () => {}, errorOnce: () => {} } as never;

/** A group of Codex editor tabs, one per thread. */
function codexGroup(viewColumn: number, threads: string[]) {
  const group = { viewColumn, tabs: [] as { label: string; input: unknown; group: unknown }[] };
  group.tabs = threads.map((id) => ({ label: id, input: new TabInputCustom(Uri.from({ scheme: "openai-codex", authority: "route", path: `/local/${id}` }), "chatgpt.conversationEditor"), group }));
  stub.groups.push(group as never);
  return group;
}

describe("the Codex extension's threads", () => {
  beforeEach(() => {
    stub.reset();
    stub.extension = { extensionPath: "/ext/openai.chatgpt" };
    stub.commands.set("vscode.openWith", () => undefined);
  });

  it("brings a thread's editor tab to the front in its own group", async () => {
    codexGroup(1, [OTHER]);
    codexGroup(2, [THREAD]);
    expect(await codexPanel.reveal(view({ id: THREAD, agent: "codex" }), log)).toBe("revealed");
    const [, command, args] = stub.ops.find((op) => op[1] === "vscode.openWith")!;
    expect(command).toBe("vscode.openWith");
    const [uri, editor, options] = args as [{ toString(): string }, string, { viewColumn?: number; preview: boolean }];
    expect([uri.toString(), editor, options]).toEqual([`openai-codex://route/local/${THREAD}`, "chatgpt.conversationEditor", { viewColumn: 2, preview: false }]);
  });

  it("opens a thread no tab shows in the extension's editor, and resumes an earlier one the same way", async () => {
    expect(await codexPanel.reveal(view({ id: THREAD, agent: "codex" }), log)).toBe("revealed");
    expect(await codexPanel.resume(OTHER, log)).toBe(true);
    const opened = stub.ops.filter((op) => op[1] === "vscode.openWith").map((op) => (op[2] as [{ toString(): string }, string, { viewColumn?: number }]).map(String));
    expect(opened.map((args) => args[0])).toEqual([`openai-codex://route/local/${THREAD}`, `openai-codex://route/local/${OTHER}`]);
  });

  it("refuses an id that is not a thread's, and fails without the extension or when it cannot open", async () => {
    expect(await codexPanel.reveal(view({ id: "codex-pid-11-0", agent: "codex" }), log)).toBe("refused-invalid");
    stub.commands.set("vscode.openWith", () => {
      throw new Error("no editor");
    });
    expect(await codexPanel.reveal(view({ id: THREAD, agent: "codex" }), log)).toBe("failed");
    stub.extension = undefined;
    expect(await codexPanel.reveal(view({ id: THREAD, agent: "codex" }), log)).toBe("failed");
    expect(await codexPanel.rename(view({ id: THREAD, agent: "codex" }), log)).toBe(false);
  });

  it("opens a thread VS Code's own Chat runs there, with its approval prompt, even without the extension", async () => {
    stub.extension = undefined;
    stub.commands.set("workbench.action.chat.openSessionInEditorGroup", () => undefined);
    const address = "agent-host-codex:/ef8da9c5-e92c-412e-a5ec-8030c1d4cdd1";
    expect(await codexPanel.reveal(view({ id: THREAD, agent: "codex", vscodeSession: address }), log)).toBe("revealed");
    expect(await codexPanel.resume(OTHER, log, { ...view({ id: OTHER, agent: "codex" }), vscodeSession: address } as never)).toBe(true);
    const calls = stub.ops.filter((op) => op[1] === "workbench.action.chat.openSessionInEditorGroup").map((op) => String((op[2] as [{ resource: unknown }])[0].resource));
    expect(calls).toEqual([address, address]);
    expect(stub.ops.some((op) => op[1] === "vscode.openWith")).toBe(false);
  });

  it("knows a thread is in front only when its editor tab is", () => {
    const group = codexGroup(1, [OTHER, THREAD]);
    stub.activate(group.tabs[1] as never);
    expect(codexPanel.isActive(view({ id: THREAD, agent: "codex" }))).toBe(true);
    expect(codexPanel.isActive(view({ id: OTHER, agent: "codex" }))).toBe(false);
  });
});
