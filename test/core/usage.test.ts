import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeSettingsEnv, envFlag, isStale, metersOf, NONESSENTIAL_TRAFFIC, parseUsageCache, readUsageCache, resetPassed, UsageCache, usageCacheFile, wantsRefresh } from "../../src/core/usage";
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
      { key: "session", label: "Session (5hr)", percent: 18, resetsAt: Date.parse("2026-10-15T12:10:00.068962+00:00"), windowMs: 5 * 3_600_000 },
      { key: "weekly_all", label: "Weekly (7 day)", percent: 18, resetsAt: Date.parse("2026-10-20T23:00:00.068981+00:00"), windowMs: 7 * 24 * 3_600_000 },
      { key: "weekly_scoped:Fable", label: "Weekly Fable", percent: 31, resetsAt: Date.parse("2026-10-20T23:00:00.069190+00:00"), windowMs: 7 * 24 * 3_600_000 },
    ]);
  });

  it("falls back to the five-hour and seven-day fields, and copes with garbage", () => {
    expect(metersOf({ five_hour: { utilization: 5 }, seven_day: { utilization: 9, resets_at: "soon" } })).toEqual([
      { key: "session", label: "Session (5hr)", percent: 5, resetsAt: undefined, windowMs: 5 * 3_600_000 },
      { key: "weekly_all", label: "Weekly (7 day)", percent: 9, resetsAt: undefined, windowMs: 7 * 24 * 3_600_000 },
    ]);
    expect(metersOf({ limits: [{ kind: "other", percent: 50 }, { kind: "broken" }, 7] })).toEqual([{ key: "other", label: "other", percent: 50, resetsAt: undefined, windowMs: undefined }]);
    expect(metersOf(null)).toEqual([]);
    expect(metersOf({ limits: [] })).toEqual([]);
  });

  it("reads the per-model weekly limits the cache carries next to the five-hour and seven-day ones", () => {
    expect(metersOf({ five_hour: { utilization: 5 }, seven_day: { utilization: 9 }, seven_day_opus: { utilization: 40, resets_at: "2026-10-20T23:00:00Z" }, seven_day_sonnet: null, seven_day_oauth_apps: { utilization: 3 } })).toEqual([
      { key: "session", label: "Session (5hr)", percent: 5, resetsAt: undefined, windowMs: 5 * 3_600_000 },
      { key: "weekly_all", label: "Weekly (7 day)", percent: 9, resetsAt: undefined, windowMs: 7 * 24 * 3_600_000 },
      { key: "weekly_scoped:Opus", label: "Weekly Opus", percent: 40, resetsAt: Date.parse("2026-10-20T23:00:00Z"), windowMs: 7 * 24 * 3_600_000 },
    ]);
  });
});

describe("parseUsageCache", () => {
  it("reads Claude Code's cached usage when it belongs to the signed-in account", () => {
    const config = { oauthAccount: { accountUuid: "acc-1" }, cachedUsageUtilization: { fetchedAtMs: 1_000, accountUuid: "acc-1", utilization: LIMITS } };
    expect(parseUsageCache(config)).toMatchObject({ fetchedAt: 1_000, meters: [{ key: "session" }, { key: "weekly_all" }, { key: "weekly_scoped:Fable" }] });
    expect(parseUsageCache({ cachedUsageUtilization: { fetchedAtMs: 1_000, utilization: LIMITS } })?.meters).toHaveLength(3);
  });

  it("says why there are no numbers to show", () => {
    expect(readUsageCache({ oauthAccount: { accountUuid: "acc-2" }, cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: "acc-1", utilization: LIMITS } })).toEqual({ snapshot: undefined, why: "other account" });
    expect(readUsageCache({})).toEqual({ snapshot: undefined, why: "missing" });
    expect(readUsageCache({ cachedUsageUtilization: { fetchedAtMs: 1, utilization: { nothing: 1 } } })).toEqual({ snapshot: undefined, why: "unreadable" });
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
  it("calls numbers stale when older than half an hour, or from before a window reset", () => {
    expect(isStale({ fetchedAt: 0, meters: [] }, 30 * 60_000)).toBe(false);
    expect(isStale({ fetchedAt: 0, meters: [] }, 30 * 60_000 + 1)).toBe(true);
    const meters = [{ key: "session", label: "5h", percent: 92, resetsAt: 20 * 60_000 }];
    expect(resetPassed({ fetchedAt: 0, meters }, 19 * 60_000)).toBe(false);
    expect(isStale({ fetchedAt: 0, meters }, 20 * 60_000)).toBe(true);
    // A reset already over when the numbers were fetched does not count.
    expect(resetPassed({ fetchedAt: 30 * 60_000, meters }, 40 * 60_000)).toBe(false);
  });

  it("wants an automatic refresh in auto mode only: no numbers, numbers older than 10 minutes, or from before a reset", () => {
    const now = 20 * 60_000;
    expect(wantsRefresh("auto", undefined, now)).toBe(true);
    expect(wantsRefresh("auto", { fetchedAt: 0, meters: [] }, now)).toBe(true);
    expect(wantsRefresh("auto", { fetchedAt: now - 60_000, meters: [] }, now)).toBe(false);
    expect(wantsRefresh("auto", { fetchedAt: now - 60_000, meters: [{ key: "session", label: "5h", percent: 90, resetsAt: now - 1 }] }, now)).toBe(true);
    expect(wantsRefresh("manual", { fetchedAt: 0, meters: [] }, now)).toBe(false);
    expect(wantsRefresh("off", undefined, now)).toBe(false);
  });
});

describe("the switch for nonessential traffic", () => {
  it("counts a variable as set unless it is empty, 0, false, no or off", () => {
    for (const on of ["1", "true", "yes", " TRUE ", 1, true]) expect(envFlag(on)).toBe(true);
    for (const off of [undefined, null, "", "  ", "0", "false", "No", "OFF", 0, false, {}]) expect(envFlag(off)).toBe(false);
  });

  it("reads Claude Code's settings file, never writing it, and notices when it changes", () => {
    const dir = tempConfigDir();
    const file = path.join(dir, "settings.json");
    const env = new ClaudeSettingsEnv(file);
    expect(env.get(NONESSENTIAL_TRAFFIC)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ env: { [NONESSENTIAL_TRAFFIC]: "1" } }));
    expect(envFlag(env.get(NONESSENTIAL_TRAFFIC))).toBe(true);
    // Rewritten with another size: read again.
    fs.writeFileSync(file, JSON.stringify({ env: {}, model: "opus" }));
    expect(env.get(NONESSENTIAL_TRAFFIC)).toBeUndefined();
    fs.writeFileSync(file, "{ not json");
    expect(env.get(NONESSENTIAL_TRAFFIC)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ env: { [NONESSENTIAL_TRAFFIC]: "true" } }));
    expect(env.get(NONESSENTIAL_TRAFFIC)).toBe("true");
    fs.rmSync(file);
    expect(env.get(NONESSENTIAL_TRAFFIC)).toBeUndefined();
    expect(fs.readdirSync(dir).sort()).toEqual(["projects", "sessions"]);
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

    // Still broken once it settled: nothing to show, rather than the last numbers.
    fs.writeFileSync(file, "{ not json");
    const settled = new Date(Date.now() - 10_000);
    fs.utimesSync(file, settled, settled);
    expect(cache.readWithReason()).toEqual({ snapshot: undefined, why: "unreadable" });

    fs.rmSync(file);
    expect(cache.read()).toBeUndefined();
  });
});
