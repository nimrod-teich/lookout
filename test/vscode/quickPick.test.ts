import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../../src/core/types";
import { pickSession, toItem } from "../../src/vscode/quickPick";
import { view } from "./helpers";
import { EventEmitter, stub } from "./stub-vscode";

describe("toItem", () => {
  it("shows state, elapsed time, location and where the session runs", () => {
    const now = 7 * 60_000;
    expect(toItem(view({ state: "working", worktree: "fix-x" }), now)).toMatchObject({
      label: "$(loading~spin) Wire the cache",
      description: "app · fix-x",
      detail: "Working for 7m",
    });
    expect(toItem(view({ state: "waiting", reason: { kind: "question", ask: "Which color?", options: ["Red", "Blue"], raw: "input needed" }, host: "terminal" }), now).detail).toBe("Needs you for 7m: Question · Which color? (Red / Blue) · terminal");
    expect(toItem(view({ state: "waiting", reason: { kind: "typed", ask: "Want me to open the PR?" } }), now)).toMatchObject({ label: "$(comment-discussion) Wire the cache", detail: "Needs you for 7m: Asked you a question · Want me to open the PR?" });
    expect(toItem(view({ state: "working", since: -6 * 60_000, lastWriteAt: -6 * 60_000 }), now)).toMatchObject({ label: "$(clock) Wire the cache", detail: "Working, quiet 13m" });
    // Commands are quoted as written: `$(…)` in them is text, not an icon.
    expect(toItem(view({ state: "waiting", title: "Build $(arch)", reason: { kind: "permission", ask: "Bash: make -j$(nproc)", raw: "permission prompt" } }), now)).toMatchObject({
      label: "$(bell-dot) Build \\$(arch)",
      detail: "Needs you for 7m: Permission · Bash: make -j\\$(nproc)",
    });
    expect(toItem(view({ host: "window", windowLabel: "other" }), now).detail).toBe("Idle for 7m · window: other");
    expect(toItem(view({ host: "window" }), now).detail).toBe("Idle for 7m · another window");
    expect(toItem(view({ host: "elsewhere" }), now).detail).toBe("Idle for 7m · outside VS Code");
  });
});

describe("pickSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    stub.reset();
  });

  afterEach(() => vi.useRealTimers());

  it("resolves with the chosen session and disposes the picker", async () => {
    const changes = new EventEmitter<void>();
    const promise = pickSession(() => [view({ id: "a" }), view({ id: "b" })], changes.event);
    const picker = stub.openPicker!;
    expect(picker.placeholder).toBe("Jump to a session");
    expect(picker.items).toHaveLength(2);
    picker.accept(picker.items[1]);
    expect((await promise)?.id).toBe("b");
    expect(stub.ops.at(-1)).toEqual(["quickPick", "dispose"]);
  });

  it("resolves with nothing when dismissed", async () => {
    const promise = pickSession(() => [view()], new EventEmitter<void>().event);
    stub.openPicker!.hide();
    expect(await promise).toBeUndefined();
  });

  it("follows the sessions and the clock while open, keeping the active row", async () => {
    let sessions: SessionView[] = [view({ id: "a", state: "working" }), view({ id: "b", state: "working" })];
    const changes = new EventEmitter<void>();
    const promise = pickSession(() => sessions, changes.event);
    const picker = stub.openPicker!;
    picker.activeItems = [picker.items[1]!];
    expect((picker.items[0] as { detail: string }).detail).toBe("Working for 1m");

    vi.advanceTimersByTime(60_000);
    expect((picker.items[0] as { detail: string }).detail).toBe("Working for 2m");
    expect((picker.activeItems[0] as { view: SessionView }).view.id).toBe("b");

    sessions = [view({ id: "b", state: "waiting", reason: { kind: "dialog", ask: "input needed", raw: "input needed" } })];
    changes.fire();
    expect(picker.items).toHaveLength(1);
    expect((picker.items[0] as { detail: string }).detail).toBe("Needs you for 2m: Input needed");
    expect((picker.activeItems[0] as { view: SessionView }).view.id).toBe("b");

    picker.hide();
    await promise;
    vi.advanceTimersByTime(5_000);
    expect(picker.items).toHaveLength(1);
  });
});
