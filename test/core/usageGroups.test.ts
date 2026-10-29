import { describe, expect, it } from "vitest";
import type { UsageMeter } from "../../src/core/usage";
import { barMeter, chosenGroup, groupHeading, groupKey, parsePin, peakMeter, pickBar, sortGroups, tabMeters, type UsageGroup } from "../../src/core/usageGroups";

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
    expect(groupHeading({ agent: "claude-code" })).toBe("Claude usage");
    expect(groupHeading({ agent: "codex" })).toBe("Codex usage");
    expect(groupHeading({ agent: "claude-code", account: "personal" })).toBe("Claude usage · personal");
    expect(groupHeading({ agent: "claude-code", account: "default", also: ["spare"] })).toBe("Claude usage · default (also spare)");
  });
});

describe("peakMeter", () => {
  it("is the limit with the highest share used, the first of equals, and none without limits", () => {
    expect(peakMeter([meter("session", 3), meter("weekly", 61), meter("weekly-fable", 81)])?.key).toBe("weekly-fable");
    expect(peakMeter([meter("five", 40), meter("weekly", 40)])?.key).toBe("five");
    expect(peakMeter([])).toBeUndefined();
  });
});

describe("tabMeters", () => {
  it("shows the session window, and names a limit closer to its end for the hover", () => {
    expect(tabMeters([meter("session", 18), meter("weekly", 31), meter("weekly-fable", 84)])).toMatchObject({ shown: { key: "session" }, closest: { key: "weekly-fable" } });
    expect(tabMeters([meter("session", 90), meter("weekly", 40)])).toEqual({ shown: expect.objectContaining({ key: "session" }), closest: undefined });
    expect(tabMeters([meter("session", 40), meter("weekly", 40)]).closest).toBeUndefined();
    expect(tabMeters([])).toEqual({ shown: undefined, closest: undefined });
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

describe("several accounts of one agent", () => {
  const account = (name: string, percent: number, stale = false): UsageGroup => ({ agent: "claude-code", key: `claude-code:${name}`, account: name, fetchedAt: 0, stale, meters: [meter("session", percent, 5 * HOUR)] });
  const work = account("default", 18);
  const personal = account("personal", 64);
  const codex = group("codex", [meter("primary", 40, 5 * HOUR)]);

  it("names each group by its key, else by its agent", () => {
    expect(groupKey(personal)).toBe("claude-code:personal");
    expect(groupKey(codex)).toBe("codex");
    expect(groupKey({})).toBe("claude-code");
  });

  it("reads a pin of an agent, or of one of its accounts", () => {
    expect(parsePin("auto")).toBeUndefined();
    expect(parsePin("claude")).toEqual({ agent: "claude-code" });
    expect(parsePin("claude:personal")).toEqual({ agent: "claude-code", account: "personal" });
    expect(parsePin("claude:")).toEqual({ agent: "claude-code" });
    expect(parsePin("gemini:x")).toBeUndefined();
  });

  it("pins an account, or the agent's account under the most pressure, and falls back when the pin shows none", () => {
    expect(pickBar([work, personal, codex], "claude:default")?.group.account).toBe("default");
    expect(pickBar([work, personal, codex], "claude")?.group.account).toBe("personal");
    expect(pickBar([work, account("personal", 64, true), codex], "claude")?.group.account).toBe("default");
    expect(pickBar([work, personal, codex], "claude:spare")?.group.account).toBe("personal");
    expect(pickBar([work, personal, codex])?.group.account).toBe("personal");
    expect(pickBar([work, codex], "codex")?.group.agent).toBe("codex");
  });

  it("chooses a tab by its key; one picked before the accounts names the agent's first", () => {
    expect(chosenGroup([work, personal, codex], "claude-code:personal")?.account).toBe("personal");
    expect(chosenGroup([work, personal, codex], undefined, "claude-code:personal")?.account).toBe("personal");
    expect(chosenGroup([work, personal, codex], "claude-code", "codex")?.agent).toBe("codex");
    expect(chosenGroup([work, personal, codex], "claude-code")?.account).toBe("default");
    expect(chosenGroup([work, personal, codex], "codex")?.agent).toBe("codex");
  });
});
