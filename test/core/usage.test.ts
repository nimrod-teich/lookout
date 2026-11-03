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

  it("reads an account without a 5-hour window, a verified Ultra one, and names a row scoped to a surface", () => {
    const week = "2026-11-03T23:00:00.140323+00:00";
    const ultra = {
      five_hour: null,
      seven_day: { utilization: 41, resets_at: week },
      limits: [
        { kind: "weekly_all", group: "weekly", percent: 41, severity: "normal", resets_at: week, scope: null, is_active: false },
        { kind: "weekly_scoped", group: "weekly", percent: 51, severity: "normal", resets_at: week, scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
        { kind: "weekly_scoped", group: "weekly", percent: 7, severity: "normal", resets_at: week, scope: { model: null, surface: { display_name: "Cowork" } }, is_active: false },
      ],
    };
    expect(metersOf(ultra).map(({ key, label, percent }) => ({ key, label, percent }))).toEqual([
      { key: "weekly_all", label: "Weekly (7 day)", percent: 41 },
      { key: "weekly_scoped:Fable", label: "Weekly Fable", percent: 51 },
      { key: "weekly_scoped:Cowork", label: "Weekly Cowork", percent: 7 },
    ]);
    expect(metersOf({ five_hour: null, seven_day: { utilization: 41, resets_at: week } }).map((meter) => meter.key)).toEqual(["weekly_all"]);
  });

  it("reads the per-model weekly limits the cache carries next to the five-hour and seven-day ones", () => {
    expect(metersOf({ five_hour: { utilization: 5 }, seven_day: { utilization: 9 }, seven_day_opus: { utilization: 40, resets_at: "2026-10-20T23:00:00Z" }, seven_day_sonnet: null, seven_day_oauth_apps: { utilization: 3 } })).toEqual([
      { key: "session", label: "Session (5hr)", percent: 5, resetsAt: undefined, windowMs: 5 * 3_600_000 },
      { key: "weekly_all", label: "Weekly (7 day)", percent: 9, resetsAt: undefined, windowMs: 7 * 24 * 3_600_000 },
      { key: "weekly_scoped:Opus", label: "Weekly Opus", percent: 40, resetsAt: Date.parse("2026-10-20T23:00:00Z"), windowMs: 7 * 24 * 3_600_000 },
    ]);
  });
});

describe("the usage credits", () => {
  /** Extra usage as the cache carries it: on, $100.00 a month, nothing spent yet. */
  const EXTRA = { is_enabled: true, monthly_limit: 10000, used_credits: 0, utilization: null, currency: "USD", decimal_places: 2, disabled_reason: null, user_disabled: false, spend_limit_reached: false };
  const FETCHED = new Date(2026, 10, 3, 11, 12).getTime();
  const credits = (extra: unknown, fetchedAt: number | undefined = FETCHED) => metersOf({ ...LIMITS, extra_usage: extra }, fetchedAt).find((meter) => meter.key === "extra_usage");

  it("follows the plan's limits while they are on, with the money, resetting on the first of the next month", () => {
    expect(metersOf({ ...LIMITS, extra_usage: EXTRA }, FETCHED).map((meter) => meter.key)).toEqual(["session", "weekly_all", "weekly_scoped:Fable", "extra_usage"]);
    expect(credits(EXTRA)).toEqual({ key: "extra_usage", label: "Usage credits", percent: 0, resetsAt: new Date(2026, 11, 1).getTime(), spent: { used: 0, limit: 100, currency: "USD" } });
    expect(credits({ ...EXTRA, used_credits: 1240 })).toMatchObject({ percent: 12.4, spent: { used: 12.4, limit: 100 } });
    // The server's own share wins over the one Lookout works out.
    expect(credits({ ...EXTRA, used_credits: 1240, utilization: 13 })?.percent).toBe(13);
    expect(credits(EXTRA, new Date(2026, 11, 31, 23, 59).getTime())?.resetsAt).toBe(new Date(2027, 0, 1).getTime());
    expect(metersOf({ ...LIMITS, extra_usage: EXTRA }).at(-1)).toMatchObject({ key: "extra_usage", resetsAt: undefined });
    expect(credits({ ...EXTRA, currency: "jpy", decimal_places: undefined, monthly_limit: 5000, used_credits: 1200 })?.spent).toEqual({ used: 1200, limit: 5000, currency: "JPY" });
  });

  it("reads full once used up, which the server reports as off", () => {
    expect(credits({ ...EXTRA, is_enabled: false, used_credits: 10000, spend_limit_reached: true })?.percent).toBe(100);
    expect(credits({ ...EXTRA, is_enabled: false, used_credits: 4000, disabled_reason: "out_of_credits" })?.percent).toBe(100);
    expect(credits({ ...EXTRA, used_credits: 10350, utilization: 103.5 })?.percent).toBe(103.5);
    // A limit lowered below what was spent: past 100, so the bar can show the limit inside it.
    expect(credits({ ...EXTRA, used_credits: 13000 })?.percent).toBe(130);
  });

  it("is not there when they are off, unlimited, or there are no plan limits", () => {
    // Turned off by you: the server keeps their last numbers, and says so.
    expect(credits({ ...EXTRA, is_enabled: false, user_disabled: true, spend_limit_reached: true })).toBeUndefined();
    expect(credits({ is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null, user_disabled: true })).toBeUndefined();
    expect(credits({ ...EXTRA, is_enabled: false })).toBeUndefined();
    expect(credits({ ...EXTRA, monthly_limit: null })).toBeUndefined();
    expect(credits(null)).toBeUndefined();
    expect(credits("on")).toBeUndefined();
    expect(metersOf({ five_hour: null, limits: [], extra_usage: EXTRA }, FETCHED)).toEqual([]);
  });

  it("comes from the cache, dated by its fetch", () => {
    const config = { cachedUsageUtilization: { fetchedAtMs: FETCHED, utilization: { ...LIMITS, extra_usage: { ...EXTRA, used_credits: 2500 } } } };
    expect(parseUsageCache(config)?.meters.at(-1)).toMatchObject({ key: "extra_usage", percent: 25, resetsAt: new Date(2026, 11, 1).getTime() });
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
