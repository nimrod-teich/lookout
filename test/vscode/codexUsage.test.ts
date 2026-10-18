import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../../src/extension";
import { stub } from "./stub-vscode";

// The extension with Codex on and a Codex home holding one rollout of today: its limits reach the status bar and the alerts.

const WAIT = { timeout: 20_000, interval: 100 };
let root: string;
let subscriptions: { dispose(): void }[];

function context() {
  const saved: Record<string, unknown> = {};
  const memento = {
    get: (key: string, fallback: unknown) => saved[key] ?? fallback,
    update: (key: string, value: unknown) => {
      saved[key] = value;
      return Promise.resolve();
    },
  };
  return { subscriptions, globalStorageUri: { fsPath: path.join(root, "global-storage") }, extensionUri: { fsPath: "/ext" }, workspaceState: memento, globalState: memento } as never;
}

/** A rollout written now, whose last token_count records the 5-hour window at `percent`. */
function writeRollout(home: string, percent: number): void {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dir = path.join(home, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const id = "01a1aaaa-0000-7000-8000-000000000001";
  const lines = [
    { timestamp: now.toISOString(), type: "session_meta", payload: { id, cwd: "/work/elsewhere", originator: "codex-tui", timestamp: now.toISOString() } },
    { timestamp: now.toISOString(), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: percent, window_minutes: 300, resets_at: Math.floor(now.getTime() / 1000) + 3 * 3600 }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: Math.floor(now.getTime() / 1000) + 4 * 86400 } } } },
  ];
  fs.writeFileSync(path.join(dir, `rollout-2026-10-18T10-00-00-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function statusText(): string | undefined {
  return stub.ops.filter(([target, action]) => target === "statusBar:lookout.status" && action === "set:text").at(-1)?.[2] as string | undefined;
}

beforeEach(() => {
  stub.reset();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-codex-usage-"));
  fs.mkdirSync(path.join(root, "claude", "sessions"), { recursive: true });
  stub.config["lookout.claudeConfigDir"] = path.join(root, "claude");
  stub.config["lookout.usage.refresh"] = "off";
  stub.config["lookout.agents.codex"] = true;
  stub.config["lookout.codexHome"] = path.join(root, "codex");
  subscriptions = [];
});

afterEach(() => {
  for (const subscription of subscriptions) subscription.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Codex's limits", () => {
  it("show in the status bar's bar and hover, and a threshold is announced once, named for Codex", async () => {
    writeRollout(path.join(root, "codex"), 72);
    activate(context());
    await vi.waitFor(() => expect(statusText()).toMatch(/^\$\(lookout-lighthouse\) ▰▰▰▰▰▰▰▱▱▱ 72% · (2h59m|3h00m)$/), WAIT);
    const tip = (stub.ops.filter(([target, action]) => target === "statusBar:lookout.status" && action === "set:tooltip").at(-1)?.[2] as { value: string }).value;
    expect(tip).toContain("**Codex usage**");
    expect(tip).toContain("5h limit: 72%");
    expect(tip).toContain("Weekly limit: 12%");
    const warnings = () => stub.ops.filter(([target, action]) => target === "window" && action === "warning").map(([, , text]) => String(text));
    await vi.waitFor(() => expect(warnings()).toEqual([expect.stringMatching(/^Lookout: Your Codex 5-hour limit is at 72%; it resets at /)]), WAIT);
    // Read again and again: still one.
    stub.configChange.fire({ affectsConfiguration: () => true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(warnings()).toHaveLength(1);
  }, 40_000);
});
