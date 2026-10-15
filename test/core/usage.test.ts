import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isStale, metersOf, parseUsageCache, shouldAutoRefresh, UsageCache, usageCacheFile } from "../../src/core/usage";
import { tempConfigDir } from "./helpers";

const LIMITS = {
  five_hour: { utilization: 18, resets_at: "2026-10-15T12:10:00.068962+00:00" },
  seven_day: { utilization: 18, resets_at: "2026-10-20T23:00:00.068981+00:00" },
  limits: [
    { kind: "session", group: "session", percent: 18, resets_at: "2026-10-15T12:10:00.068962+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 18, resets_at: "2026-10-20T23:00:00.068981+00:00", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 31, resets_at: "2026-10-20T23:00:00.069190+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
  ],
};

describe("metersOf", () => {
  it("reads the limits array with its windows and reset times", () => {
    expect(metersOf(LIMITS)).toEqual([
      { key: "session", label: "5h", percent: 18, resetsAt: Date.parse("2026-10-15T12:10:00.068962+00:00"), windowMs: 5 * 3_600_000 },
      { key: "weekly_all", label: "Week", percent: 18, resetsAt: Date.parse("2026-10-20T23:00:00.068981+00:00"), windowMs: 7 * 24 * 3_600_000 },
      { key: "weekly_scoped:Fable", label: "Week · Fable", percent: 31, resetsAt: Date.parse("2026-10-20T23:00:00.069190+00:00"), windowMs: 7 * 24 * 3_600_000 },
    ]);
  });

  it("falls back to the five-hour and seven-day fields, and copes with garbage", () => {
    expect(metersOf({ five_hour: { utilization: 5 }, seven_day: { utilization: 9, resets_at: "soon" } })).toEqual([
      { key: "session", label: "5h", percent: 5, resetsAt: undefined, windowMs: 5 * 3_600_000 },
      { key: "weekly_all", label: "Week", percent: 9, resetsAt: undefined, windowMs: 7 * 24 * 3_600_000 },
    ]);
    expect(metersOf({ limits: [{ kind: "other", percent: 50 }, { kind: "broken" }, 7] })).toEqual([{ key: "other", label: "other", percent: 50, resetsAt: undefined, windowMs: undefined }]);
    expect(metersOf(null)).toEqual([]);
    expect(metersOf({ limits: [] })).toEqual([]);
  });
});

describe("parseUsageCache", () => {
  it("reads Claude Code's cached usage when it belongs to the signed-in account", () => {
    const config = { oauthAccount: { accountUuid: "acc-1" }, cachedUsageUtilization: { fetchedAtMs: 1_000, accountUuid: "acc-1", utilization: LIMITS } };
    expect(parseUsageCache(config)).toMatchObject({ fetchedAt: 1_000, meters: [{ key: "session" }, { key: "weekly_all" }, { key: "weekly_scoped:Fable" }] });
    expect(parseUsageCache({ cachedUsageUtilization: { fetchedAtMs: 1_000, utilization: LIMITS } })?.meters).toHaveLength(3);
  });

  it("ignores another account's numbers, and anything incomplete", () => {
    expect(parseUsageCache({ oauthAccount: { accountUuid: "acc-2" }, cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: "acc-1", utilization: LIMITS } })).toBeUndefined();
    expect(parseUsageCache({ cachedUsageUtilization: { utilization: LIMITS } })).toBeUndefined();
    expect(parseUsageCache({ cachedUsageUtilization: { fetchedAtMs: 1, utilization: {} } })).toBeUndefined();
    expect(parseUsageCache({})).toBeUndefined();
    expect(parseUsageCache("nope")).toBeUndefined();
  });
});

describe("staleness and refresh timing", () => {
  it("calls numbers older than an hour stale", () => {
    expect(isStale({ fetchedAt: 0, meters: [] }, 3_599_000)).toBe(false);
    expect(isStale({ fetchedAt: 0, meters: [] }, 3_600_001)).toBe(true);
  });

  it("refreshes automatically only in auto mode, when old, and not too often", () => {
    const fresh = { fetchedAt: 100_000, meters: [] };
    const old = { fetchedAt: 0, meters: [] };
    const now = 20 * 60_000;
    expect(shouldAutoRefresh("auto", undefined, -Infinity, now)).toBe(true);
    expect(shouldAutoRefresh("auto", old, -Infinity, now)).toBe(true);
    expect(shouldAutoRefresh("auto", { fetchedAt: now - 60_000, meters: [] }, -Infinity, now)).toBe(false);
    expect(shouldAutoRefresh("auto", old, now - 60_000, now)).toBe(false);
    expect(shouldAutoRefresh("manual", old, -Infinity, now)).toBe(false);
    expect(shouldAutoRefresh("off", undefined, -Infinity, now)).toBe(false);
    expect(shouldAutoRefresh("auto", fresh, -Infinity, now)).toBe(true);
  });
});

describe("usageCacheFile", () => {
  it("sits next to the standard config directory, or inside an overridden one", () => {
    expect(usageCacheFile("/home/u/.claude", "/home/u")).toBe(path.join("/home/u", ".claude.json"));
    expect(usageCacheFile("/srv/claude-config", "/home/u")).toBe(path.join("/srv/claude-config", ".claude.json"));
  });
});

describe("UsageCache", () => {
  it("parses the file when it changes and keeps the last good numbers through a torn write", () => {
    const file = path.join(tempConfigDir(), ".claude.json");
    const cache = new UsageCache(file);
    expect(cache.read()).toBeUndefined();

    fs.writeFileSync(file, JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 1, utilization: { five_hour: { utilization: 10 } } } }));
    expect(cache.read()?.meters[0]?.percent).toBe(10);
    expect(cache.read()?.meters[0]?.percent).toBe(10);

    fs.writeFileSync(file, '{"cachedUsageUtilization": {"fetchedAtMs": 2, "utilization": {"five_hour": {"utilization": 2');
    expect(cache.read()?.meters[0]?.percent).toBe(10);

    fs.writeFileSync(file, JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 3, utilization: { five_hour: { utilization: 30 } } } }));
    expect(cache.read()).toMatchObject({ fetchedAt: 3 });

    fs.rmSync(file);
    expect(cache.read()).toBeUndefined();
  });
});
