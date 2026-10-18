import { describe, expect, it } from "vitest";
import type { UsageMeter } from "../../src/core/usage";
import { barMeter, chosenGroup, groupHeading, peakMeter, pickBar, sortGroups, type UsageGroup } from "../../src/core/usageGroups";

const HOUR = 3_600_000;

function meter(key: string, percent: number, windowMs?: number): UsageMeter {
  return { key, label: key, percent, windowMs };
}

function group(agent: string, meters: UsageMeter[], stale = false): UsageGroup {
  return { agent, fetchedAt: 0, stale, meters };
}

describe("barMeter", () => {
  it("takes the session window, else the shortest, else the first", () => {
    expect(barMeter([meter("weekly_all", 90, 168 * HOUR), meter("session", 10, 5 * HOUR)])?.key).toBe("session");
    expect(barMeter([meter("secondary", 90, 168 * HOUR), meter("primary", 10, 5 * HOUR)])?.key).toBe("primary");
    expect(barMeter([meter("a", 1), meter("b", 2)])?.key).toBe("a");
    expect(barMeter([])).toBeUndefined();
  });
});

describe("pickBar", () => {
  const claude = group("claude-code", [meter("session", 18, 5 * HOUR), meter("weekly_scoped:Fable", 84, 168 * HOUR)]);
  const codex = group("codex", [meter("primary", 64, 5 * HOUR), meter("secondary", 22, 168 * HOUR)]);

  it("shows the window under the most pressure across the agents' bars", () => {
    expect(pickBar([claude, codex])).toMatchObject({ group: { agent: "codex" }, meter: { key: "primary" } });
    expect(pickBar([claude])).toMatchObject({ group: { agent: "claude-code" }, meter: { key: "session", percent: 18 } });
  });

  it("goes by fresh numbers before stale ones, and by the catalog's order on a tie", () => {
    expect(pickBar([claude, { ...codex, stale: true }])?.group.agent).toBe("claude-code");
    const even = group("codex", [meter("primary", 18, 5 * HOUR)]);
    expect(pickBar([even, claude])?.group.agent).toBe("claude-code");
  });

  it("shows a pinned agent's bar, and leaves the bar to auto while that agent reports none", () => {
    expect(pickBar([claude, codex], "claude")?.group.agent).toBe("claude-code");
    expect(pickBar([claude, codex], "copilot")?.group.agent).toBe("codex");
    expect(pickBar([claude, group("codex", [])], "codex")?.group.agent).toBe("claude-code");
  });

  it("has no bar while no agent reports numbers", () => {
    expect(pickBar([group("claude-code", [])])).toBeUndefined();
    expect(pickBar([])).toBeUndefined();
  });
});

describe("usage groups", () => {
  it("come in the catalog's order, a group without an agent counted as Claude's, and are headed by the agent's name", () => {
    expect(sortGroups([{ agent: "copilot" }, { agent: "unlisted" }, { agent: "codex" }, { agent: "claude-code" }]).map((g) => g.agent)).toEqual(["claude-code", "codex", "copilot", "unlisted"]);
    expect(sortGroups([{ agent: "codex" }, {}]).map((g) => g.agent)).toEqual([undefined, "codex"]);
    expect(groupHeading("claude-code")).toBe("Claude usage");
    expect(groupHeading("codex")).toBe("Codex usage");
  });
});

describe("peakMeter", () => {
  it("is the limit with the highest share used, the first of equals, and none without limits", () => {
    expect(peakMeter([meter("session", 3), meter("weekly", 61), meter("weekly-fable", 81)])?.key).toBe("weekly-fable");
    expect(peakMeter([meter("five", 40), meter("weekly", 40)])?.key).toBe("five");
    expect(peakMeter([])).toBeUndefined();
  });
});

describe("chosenGroup", () => {
  const groups = [group("claude-code", [meter("session", 3)]), group("codex", [meter("five", 0)])];

  it("is the group picked last, else the status bar's, else the first", () => {
    expect(chosenGroup(groups, "codex", "claude-code")?.agent).toBe("codex");
    expect(chosenGroup(groups, undefined, "codex")?.agent).toBe("codex");
    expect(chosenGroup(groups)?.agent).toBe("claude-code");
  });

  it("passes over a pick whose agent shows no usage now", () => {
    expect(chosenGroup(groups, "copilot", "codex")?.agent).toBe("codex");
    expect(chosenGroup(groups, "copilot")?.agent).toBe("claude-code");
    expect(chosenGroup([], "codex")).toBeUndefined();
  });
});
