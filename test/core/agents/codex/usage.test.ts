import { describe, expect, it } from "vitest";
import { replyCost } from "../../../../src/core/agents/codex/pricing";
import { applyRolloutLine, emptyRollout } from "../../../../src/core/agents/codex/rollout";
import { metersOf, windowOf } from "../../../../src/core/agents/codex/usage";
import { reachedThresholds } from "../../../../src/core/usageAlerts";
import { fixtureFile, fixtureLines, IDLE } from "./fixtures";

const HOUR = 3_600_000;

function tokenCount(rateLimits: unknown, timestamp = "2026-10-18T12:03:45.201Z"): string {
  return JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: rateLimits } });
}

describe("Codex's limits", () => {
  it("are read from the last token_count that carries them, the reset as epoch seconds", () => {
    const state = emptyRollout();
    for (const line of fixtureLines(fixtureFile(IDLE))) applyRolloutLine(state, line);
    expect(state.rateLimits).toEqual({
      at: Date.parse("2026-10-18T12:03:45.201Z"),
      primary: { usedPercent: 0, windowMinutes: 300, resetsAt: 1792343023000 },
      secondary: { usedPercent: 0, windowMinutes: 10_080, resetsAt: 1792929823000 },
    });
  });

  it("keep the last reading when a token_count carries none, and take a reset given in seconds from the record's time", () => {
    const state = emptyRollout();
    applyRolloutLine(state, tokenCount({ primary: { used_percent: 40, window_minutes: 300, resets_in_seconds: 600 } }));
    applyRolloutLine(state, tokenCount(null, "2026-10-18T12:10:00.000Z"));
    expect(state.rateLimits).toEqual({ at: Date.parse("2026-10-18T12:03:45.201Z"), primary: { usedPercent: 40, windowMinutes: 300, resetsAt: Date.parse("2026-10-18T12:13:45.201Z") }, secondary: undefined });
    applyRolloutLine(state, tokenCount({ primary: { window_minutes: 300 } }));
    expect(state.rateLimits?.primary?.usedPercent).toBe(40);
  });

  it("become meters labelled as Codex labels them, under the keys Claude's windows use", () => {
    expect(windowOf(300, "primary")).toEqual({ key: "session", label: "5h limit", windowMs: 5 * HOUR });
    expect(windowOf(10_080, "secondary")).toEqual({ key: "weekly_all", label: "Weekly limit", windowMs: 168 * HOUR });
    expect(windowOf(60, "primary")).toMatchObject({ key: "window:60", label: "1h limit" });
    expect(windowOf(2880, "secondary").label).toBe("2d limit");
    expect(windowOf(90, "primary").label).toBe("90m limit");
    expect(windowOf(undefined, "secondary")).toEqual({ key: "secondary", label: "Second limit" });
    expect(metersOf({ primary: { usedPercent: 64, windowMinutes: 300, resetsAt: 9 }, secondary: undefined })).toEqual([{ key: "session", label: "5h limit", windowMs: 5 * HOUR, percent: 64, resetsAt: 9 }]);
    expect(metersOf({})).toEqual([]);
  });

  it("reach the same alert thresholds as Claude's, each named for Codex and its window", () => {
    const meters = metersOf({ primary: { usedPercent: 91, windowMinutes: 300, resetsAt: 1_800_000_000_000 }, secondary: { usedPercent: 50, windowMinutes: 10_080 } });
    expect(reachedThresholds(meters, "codex").map((a) => a.id)).toEqual(["codex-session-90-30000000"]);
  });
});

describe("Codex's API-equivalent price", () => {
  it("prices a reply at the model's list rates, the long-context rates past 272K input tokens", () => {
    expect(replyCost("gpt-6.1-sol", { input: 15_000, cached: 12_000, cacheWrite: 0, output: 1_000 })).toBeCloseTo((3_000 * 2 + 12_000 * 0.1 + 1_000 * 10) / 1e6, 10);
    expect(replyCost("gpt-6.1-sol", { input: 300_000, cached: 200_000, cacheWrite: 10_000, output: 2_000 })).toBeCloseTo((90_000 * 4 + 200_000 * 0.2 + 10_000 * 5 + 2_000 * 15) / 1e6, 10);
    expect(replyCost("gpt-unknown", { input: 1, cached: 0, cacheWrite: 0, output: 1 })).toBeUndefined();
    expect(replyCost(undefined, { input: 1, cached: 0, cacheWrite: 0, output: 1 })).toBeUndefined();
  });

  it("sums each reply once, and gives up when a reply's model has no price", () => {
    const state = emptyRollout();
    for (const line of fixtureLines(fixtureFile(IDLE))) applyRolloutLine(state, line);
    // One reply: 14,900 input of which 12,160 cached, 5 output.
    expect(state.costUsd).toBeCloseTo((2_740 * 2 + 12_160 * 0.1 + 5 * 10) / 1e6, 12);
    const record = fixtureLines(fixtureFile(IDLE)).find((line) => line.includes('"type":"token_usage_record"'))!;
    applyRolloutLine(state, record);
    expect(state.priced.size).toBe(1);
    applyRolloutLine(state, JSON.stringify({ type: "turn_context", payload: { model: "gpt-unknown" } }));
    applyRolloutLine(state, JSON.stringify({ type: "token_usage_record", payload: { response_id: "r2", usage: { input_tokens: 10, output_tokens: 1 } } }));
    expect(state.unpriced).toBe(true);
  });
});
