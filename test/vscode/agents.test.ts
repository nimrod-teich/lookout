import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextAttention } from "../../src/core/model";
import type { UsageGroup } from "../../src/core/usageGroups";
import { Board } from "../../src/vscode/board";
import { toItem } from "../../src/vscode/quickPick";
import { StatusBar, type StatusBarInput } from "../../src/vscode/statusBar";
import { view } from "./helpers";
import { createWebviewView, stub } from "./stub-vscode";

const HOUR = 3_600_000;
const ITEM = "statusBar:lookout.status";

function lastSet(prop: string): unknown {
  return stub.ops.filter(([target, action]) => target === ITEM && action === `set:${prop}`).at(-1)?.[2];
}

const claude: UsageGroup = {
  agent: "claude-code",
  fetchedAt: 0,
  stale: false,
  canRefresh: true,
  meters: [
    { agent: "claude-code", key: "session", label: "Session (5hr)", percent: 18, windowMs: 5 * HOUR },
    { agent: "claude-code", key: "weekly_scoped:Fable", label: "Weekly Fable", percent: 84, windowMs: 168 * HOUR },
  ],
};
const codex: UsageGroup = {
  agent: "codex",
  fetchedAt: 0,
  stale: false,
  meters: [
    { agent: "codex", key: "primary", label: "5h limit", percent: 64, windowMs: 5 * HOUR },
    { agent: "codex", key: "secondary", label: "Weekly limit", percent: 22, windowMs: 168 * HOUR },
  ],
};

function input(overrides: Partial<StatusBarInput> = {}): StatusBarInput {
  return { usage: undefined, enabled: true, showUsage: true, showReset: false, canRefreshUsage: true, ...overrides };
}

describe("the status bar with more than one agent", () => {
  let bar: StatusBar;

  beforeEach(() => {
    vi.useFakeTimers();
    stub.reset();
    bar = new StatusBar("lookout.showBoard");
  });

  afterEach(() => {
    bar.dispose();
    vi.useRealTimers();
  });

  it("shows the window under the most pressure, with its agent's boat before the bar, and every group in the hover", () => {
    bar.render(input({ usageGroups: [claude, codex] }), 0);
    expect(lastSet("text")).toBe("$(lookout-lighthouse) $(lookout-cutter) ▰▰▰▰▰▰▱▱▱▱ 64%");
    expect(lastSet("color")).toMatchObject({ id: "charts.yellow" });
    const tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).toContain("$(lookout-sloop)</span> **Claude usage**");
    expect(tip).toContain("$(lookout-cutter)</span> **Codex usage**");
    expect(tip.indexOf("Claude usage")).toBeLessThan(tip.indexOf("Codex usage"));
    expect(tip).toContain("5h limit: 64%");
    expect((lastSet("accessibilityInformation") as { label: string }).label).toBe("Lookout: usage Codex 5h limit 64%");
  });

  it("shows the agent the setting pins, and leaves the bar to auto while that agent reports nothing", () => {
    bar.render(input({ usageGroups: [claude, codex], usageAgent: "claude" }), 0);
    expect(lastSet("text")).toMatch(/\$\(lookout-sloop\) ▰▰▱▱▱▱▱▱▱▱ 18%$/);
    bar.render(input({ usageGroups: [claude, { ...codex, meters: [] }], usageAgent: "codex" }), 0);
    // Claude alone reports numbers: no mark, as with Claude alone.
    expect(lastSet("text")).toBe("$(lookout-lighthouse) ▰▰▱▱▱▱▱▱▱▱ 18%");
  });

  it("marks the usage with the agent's boat while the markers show, and not otherwise", () => {
    bar.render(input({ usageGroups: [claude], markers: true }), 0);
    let tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).toContain("$(lookout-sloop)</span> **Claude usage**");
    expect(lastSet("text")).toBe("$(lookout-lighthouse) $(lookout-sloop) ▰▰▱▱▱▱▱▱▱▱ 18%");
    bar.render(input({ usageGroups: [claude], markers: false }), 0);
    tip = (lastSet("tooltip") as { value: string }).value;
    expect(tip).not.toContain("lookout-sloop");
    expect(tip.startsWith("**Claude usage**")).toBe(true);
  });
});

describe("the jump list with markers", () => {
  it("leads with the agent's boat and names the agent", () => {
    expect(toItem(view({ agent: "codex", state: "working", host: "terminal" }), 60_000, true)).toMatchObject({ label: "$(lookout-cutter) $(loading~spin) Wire the cache", description: "Codex · app" });
    expect(toItem(view({ state: "working" }), 60_000, false)).toMatchObject({ label: "$(loading~spin) Wire the cache", description: "app" });
  });
});

describe("the board with markers", () => {
  beforeEach(() => stub.reset());

  it("sends every agent's usage, the bar the status bar shows, and whether to tell the agents apart", () => {
    const groups = [claude, codex].map((group) => ({ ...group, canRefresh: group.canRefresh ?? false }));
    const actions = {
      sessions: () => [view()],
      usage: () => groups,
      usageBar: () => "codex",
      markers: () => true,
      jump: vi.fn(() => Promise.resolve()),
      rename: vi.fn(() => Promise.resolve()),
      markSeen: vi.fn(),
      markAllSeen: vi.fn(),
      dismiss: vi.fn(),
      refreshUsage: vi.fn(),
      search: vi.fn(() => ({ results: [], pending: 0 })),
      openHit: vi.fn(),
      openSearch: vi.fn(),
      past: () => [],
      resume: vi.fn(),
      earlier: () => ({ scope: "folders" as const, limit: 500, capped: false }),
      setEarlierScope: vi.fn(),
      favourites: () => ({ ids: [], past: [] }),
      toggleFavourite: vi.fn(),
    };
    const board = new Board({ fsPath: "/ext" } as never, actions);
    const webviewView = createWebviewView();
    board.resolveWebviewView(webviewView as never);
    expect(webviewView.posted[0]).toMatchObject({ type: "sessions", usage: groups, usageBar: "codex", markers: true });
  });
});

describe("nextAttention", () => {
  it("skips a session its agent does not let Lookout bring forward", () => {
    const tab = view({ id: "a", agent: "copilot", state: "waiting", host: "panel", since: 1 });
    const terminal = view({ id: "b", agent: "codex", state: "waiting", host: "terminal", since: 2 });
    expect(nextAttention([tab, terminal], undefined)?.id).toBe("b");
    expect(nextAttention([tab], undefined)).toBeUndefined();
  });
});
