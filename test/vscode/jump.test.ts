import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelNewest, claudeTabLabel } from "../../src/vscode/agents/claudePanel";
import { jumpToSession, renameSession, revealed } from "../../src/vscode/jump";
import { notifyFinished, notifyWaiting } from "../../src/vscode/notifications";
import { Terminals } from "../../src/vscode/terminals";
import { isWatched } from "../../src/vscode/watch";
import { fakeLog, settle, view } from "./helpers";
import { stub } from "./stub-vscode";

const CLAUDE_OPEN = "claude-vscode.editor.open";
const LAST_MESSAGE = "claude-vscode.focusLastMessage";

function commandCalls(): string[] {
  return stub.ops.filter(([target]) => target === "commands").map(([, command]) => command);
}

function messages(kind: "info" | "warning"): string[] {
  return stub.ops.filter(([target, action]) => target === "window" && action === kind).map(([, , text]) => String(text));
}

async function terminals(): Promise<Terminals> {
  const t = new Terminals();
  await settle();
  return t;
}

beforeEach(() => {
  stub.reset();
  // A jump of the test before must not scroll a tab this one brings to the front.
  cancelNewest();
});

describe("claudeTabLabel", () => {
  it("cuts titles the way the Claude Code extension labels its tabs", () => {
    expect(claudeTabLabel("Short title")).toBe("Short title");
    expect(claudeTabLabel("x".repeat(25))).toBe("x".repeat(25));
    expect(claudeTabLabel("Smart-router-infra on-call rotation and alerts")).toBe("Smart-router-infra on-ca…");
  });
});

describe("jumpToSession, panel sessions", () => {
  it("reveals the session through the Claude command without touching its settings", async () => {
    stub.commands.set(CLAUDE_OPEN, () => undefined);
    const v = view();
    const result = await jumpToSession(v, await terminals(), fakeLog());
    expect([result, revealed(result)]).toEqual(["revealed", true]);
    expect(stub.ops).toEqual([
      ["commands", CLAUDE_OPEN, [v.id, undefined, undefined, undefined, undefined, { programmatic: "pin-to-panel" }]],
    ]);
  });

  it("then brings the session's newest message into view, once its tab is in front", async () => {
    const group = stub.addClaudeGroup(["Other", "Wire the cache"]);
    stub.commands.set(CLAUDE_OPEN, () => stub.activate(group.tabs[1]!));
    stub.commands.set(LAST_MESSAGE, () => undefined);
    expect(await jumpToSession(view(), await terminals(), fakeLog())).toBe("revealed");
    await vi.waitFor(() => expect(commandCalls()).toEqual([CLAUDE_OPEN, LAST_MESSAGE]), { timeout: 2_000, interval: 20 });
  });

  it("scrolls no tab when the session's tab does not come to the front", async () => {
    const group = stub.addClaudeGroup(["Other", "Wire the cache"]);
    stub.commands.set(CLAUDE_OPEN, () => undefined);
    stub.commands.set(LAST_MESSAGE, () => undefined);
    expect(await jumpToSession(view(), await terminals(), fakeLog())).toBe("revealed");
    stub.activate(group.tabs[0]!);
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(commandCalls()).toEqual([CLAUDE_OPEN]);
  }, 10_000);

  it("drops the scroll of a jump that a later jump or a rename overtakes", async () => {
    const group = stub.addClaudeGroup(["Wire the cache", "Second"]);
    stub.commands.set(LAST_MESSAGE, () => undefined);
    stub.commands.set("claude-vscode.renameSessionTab", () => undefined);
    stub.commands.set(CLAUDE_OPEN, () => undefined);
    const t = await terminals();
    await jumpToSession(view(), t, fakeLog());
    // The rename brings the first tab forward; the jump's scroll would take the focus from its box.
    stub.commands.set(CLAUDE_OPEN, () => stub.activate(group.tabs[0]!));
    await renameSession(view(), t, fakeLog());
    await jumpToSession(view({ title: "Second" }), t, fakeLog());
    await jumpToSession(view(), t, fakeLog());
    await vi.waitFor(() => expect(commandCalls().filter((c) => c === LAST_MESSAGE)).toHaveLength(1), { timeout: 2_000, interval: 20 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(commandCalls()).toEqual([CLAUDE_OPEN, CLAUDE_OPEN, "claude-vscode.renameSessionTab", CLAUDE_OPEN, CLAUDE_OPEN, LAST_MESSAGE]);
  }, 10_000);

  it("refuses an id that is not a session UUID", async () => {
    stub.commands.set(CLAUDE_OPEN, () => undefined);
    const log = fakeLog();
    const t = await terminals();
    for (const id of ["", "../../etc/passwd", "00000000-0000-4000-8000-000000000001/x", "not-a-uuid"]) {
      expect(await jumpToSession(view({ id }), t, log)).toBe("refused-invalid");
    }
    expect(commandCalls()).toEqual([]);
    expect(log.errors).toHaveLength(4);
  });

  it("falls back to the tab with the session's label when the Claude command is missing", async () => {
    stub.addClaudeGroup(["Other session"]);
    stub.addClaudeGroup(["Another one", "Smart-router-infra on-ca…"]);
    for (const command of ["workbench.action.focusSecondEditorGroup", "workbench.action.openEditorAtIndex"]) stub.commands.set(command, () => undefined);
    const log = fakeLog();

    expect(await jumpToSession(view({ title: "Smart-router-infra on-call rotation and alerts" }), await terminals(), log)).toBe("revealed-by-tab");
    expect(stub.ops.filter(([target]) => target === "commands").slice(1)).toEqual([
      ["commands", "workbench.action.focusSecondEditorGroup", []],
      ["commands", "workbench.action.openEditorAtIndex", [1]],
    ]);
    expect(log.errors[0]).toContain("falling back to the tab label");
  });

  it("falls back when the Claude command throws", async () => {
    stub.commands.set(CLAUDE_OPEN, () => {
      throw new Error("boom");
    });
    stub.addClaudeGroup(["Wire the cache"]);
    for (const command of ["workbench.action.focusFirstEditorGroup", "workbench.action.openEditorAtIndex"]) stub.commands.set(command, () => undefined);
    expect(await jumpToSession(view(), await terminals(), fakeLog())).toBe("revealed-by-tab");
  });

  it("gives up with a warning when the label is ambiguous or absent", async () => {
    stub.addClaudeGroup(["Claude Code", "Claude Code"]);
    const t = await terminals();
    const results = [await jumpToSession(view({ title: "Claude Code" }), t, fakeLog()), await jumpToSession(view({ title: "Nowhere" }), t, fakeLog())];
    expect(results).toEqual(["failed", "failed"]);
    expect(results.map(revealed)).toEqual([false, false]);
    expect(commandCalls().filter((c) => c.startsWith("workbench."))).toEqual([]);
    expect(messages("warning")).toHaveLength(2);
  });

  it("does not match a tab that is not a Claude Code panel", async () => {
    const group = stub.addClaudeGroup(["Wire the cache"]);
    group.tabs[0]!.input = { viewType: "mainThreadWebview-somethingElse" };
    expect(await jumpToSession(view(), await terminals(), fakeLog())).toBe("failed");
  });

  it("fails for an agent that has no panel adapter", async () => {
    expect(await jumpToSession(view({ agent: "some-other-agent" }), await terminals(), fakeLog())).toBe("failed");
    expect(commandCalls()).toEqual([]);
  });
});

describe("jumpToSession, other hosts", () => {
  it("shows and focuses the terminal a session runs in", async () => {
    stub.addTerminal("zsh", 70);
    stub.addTerminal("claude", 71);
    const result = await jumpToSession(view({ host: "terminal", terminalPid: 71 }), await terminals(), fakeLog());
    expect(result).toBe("revealed-terminal");
    expect(stub.ops).toEqual([["terminal:claude", "show", false]]);
  });

  it("fails when the session's terminal is gone", async () => {
    const closing = stub.addTerminal("claude", 71);
    const t = await terminals();
    stub.closeTerminal.fire(closing);
    expect(await jumpToSession(view({ host: "terminal", terminalPid: 71 }), t, fakeLog())).toBe("failed");
    expect(messages("warning")[0]).toContain("could not find the tab or terminal");
  });

  it("never calls an agent command for a session another window hosts, and names the window", async () => {
    stub.commands.set(CLAUDE_OPEN, () => undefined);
    const t = await terminals();
    expect(await jumpToSession(view({ host: "window", windowLabel: "other-project" }), t, fakeLog())).toBe("refused-not-here");
    expect(await jumpToSession(view({ host: "window" }), t, fakeLog())).toBe("refused-not-here");
    expect(await jumpToSession(view({ host: "elsewhere" }), t, fakeLog())).toBe("refused-not-here");
    expect(commandCalls()).toEqual([]);
    expect(messages("info").map((m) => m.split(". ")[0])).toEqual([
      '"Wire the cache" runs in the window "other-project"',
      '"Wire the cache" runs in another window',
      '"Wire the cache" runs outside VS Code',
    ]);
  });
});

describe("Terminals", () => {
  it("tracks terminals that are open, opened later, and closed", async () => {
    stub.addTerminal("first", 70);
    const t = await terminals();
    let changes = 0;
    t.onDidChange(() => changes++);
    expect([...t.pids]).toEqual([70]);

    const second = stub.addTerminal("second", 71);
    stub.openTerminal.fire(second);
    await settle();
    expect([...t.pids]).toEqual([70, 71]);

    stub.closeTerminal.fire(second);
    expect([...t.pids]).toEqual([70]);
    expect(changes).toBe(2);
    expect(t.show(71)).toBe(false);
  });

  it("ignores a terminal without a shell pid and reports the active one", async () => {
    stub.addTerminal("pending", undefined);
    const active = stub.addTerminal("active", 70);
    const t = await terminals();
    expect([...t.pids]).toEqual([70]);
    expect(t.activePid()).toBeUndefined();
    stub.activeTerminal = active;
    expect(t.activePid()).toBe(70);
  });
});

describe("isWatched", () => {
  it("is true for a panel session whose tab is in front of a focused window", async () => {
    const group = stub.addClaudeGroup(["Other", "Wire the cache"]);
    const t = await terminals();
    expect(isWatched(view(), t)).toBe(false);
    stub.activate(group.tabs[0]!);
    expect(isWatched(view(), t)).toBe(false);
    stub.activate(group.tabs[1]!);
    expect(isWatched(view(), t)).toBe(true);
    stub.focused = false;
    expect(isWatched(view(), t)).toBe(false);
  });

  it("is true for a terminal session whose terminal is the active one", async () => {
    const terminal = stub.addTerminal("claude", 71);
    const t = await terminals();
    const v = view({ host: "terminal", terminalPid: 71 });
    expect(isWatched(v, t)).toBe(false);
    stub.activeTerminal = terminal;
    expect(isWatched(v, t)).toBe(true);
    expect(isWatched(view({ host: "elsewhere" }), t)).toBe(false);
  });
});

describe("notifications", () => {
  it("offer a jump and report whether the user took it", async () => {
    expect(await notifyWaiting(view({ reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt" } }))).toBe(false);
    expect(await notifyWaiting(view({ reason: { kind: "typed", ask: "Want me to open the PR?" } }))).toBe(false);
    stub.notificationAnswer = "Jump";
    expect(await notifyFinished(view())).toBe(true);
    expect(messages("info")).toEqual([
      '"Wire the cache" needs you: Permission · Bash: npm test',
      '"Wire the cache" asked you a question: Want me to open the PR?',
      '"Wire the cache" finished.',
    ]);
  });
});

describe("renameSession", () => {
  const RENAME = "claude-vscode.renameSessionTab";

  it("reveals the session, waits for its tab to be in front, then opens the agent's rename", async () => {
    const group = stub.addClaudeGroup(["Other", "Wire the cache"]);
    stub.commands.set(CLAUDE_OPEN, () => stub.activate(group.tabs[1]!));
    stub.commands.set(RENAME, () => undefined);
    expect(await renameSession(view(), await terminals(), fakeLog())).toBe(true);
    expect(commandCalls()).toEqual([CLAUDE_OPEN, RENAME]);
  });

  it("asks for the rename after a short wait even when the tab never reports active", async () => {
    stub.commands.set(CLAUDE_OPEN, () => undefined);
    stub.commands.set(RENAME, () => undefined);
    const started = Date.now();
    expect(await renameSession(view(), await terminals(), fakeLog())).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(commandCalls()).toEqual([CLAUDE_OPEN, RENAME]);
  }, 10_000);

  it("explains instead of renaming sessions outside this window's panel", async () => {
    stub.commands.set(CLAUDE_OPEN, () => undefined);
    const t = await terminals();
    expect(await renameSession(view({ host: "terminal", terminalPid: 70 }), t, fakeLog())).toBe(false);
    expect(await renameSession(view({ host: "window", windowLabel: "api" }), t, fakeLog())).toBe(false);
    expect(commandCalls()).toEqual([]);
    expect(messages("info")).toEqual(['"Wire the cache" runs in a terminal; rename it there with /rename.', '"Wire the cache" runs in the window "api". Lookout renames sessions hosted in this window.']);
  });

  it("warns when the agent's rename is missing", async () => {
    stub.commands.set(CLAUDE_OPEN, () => undefined);
    expect(await renameSession(view(), await terminals(), fakeLog())).toBe(false);
    expect(messages("warning")[0]).toContain("could not open the rename");
  }, 10_000);
});
