import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AlertLedger, reachedThresholds, scopeOf } from "../../src/core/usageAlerts";
import type { UsageMeter } from "../../src/core/usage";
import { tempConfigDir } from "./helpers";

/** 2026-10-16T21:10:00Z and 2026-10-20T23:00:00Z, minute 29869750 and 29875620. */
const RESET = Date.parse("2026-10-16T21:10:00.200799+00:00");
const WEEK_RESET = Date.parse("2026-10-20T23:00:00.200826+00:00");
const session = (percent: number, resetsAt = RESET): UsageMeter => ({ key: "session", label: "5h", percent, resetsAt });
const week = (percent: number): UsageMeter => ({ key: "weekly_all", label: "Week", percent, resetsAt: WEEK_RESET });

describe("reachedThresholds", () => {
  it("names the highest threshold each meter reached, for its window", () => {
    expect(reachedThresholds([session(69), week(89)])).toEqual([]);
    expect(reachedThresholds([session(70)]).map((a) => a.id)).toEqual(["session-70-29869750"]);
    expect(reachedThresholds([session(95), week(92)]).map((a) => [a.id, a.threshold])).toEqual([
      ["session-90-29869750", 90],
      ["weekly_all-90-29875620", 90],
    ]);
    expect(reachedThresholds([session(75, RESET + 5 * 3_600_000)]).map((a) => a.id)).toEqual(["session-70-29870050"]);
    expect(reachedThresholds([{ key: "weekly_scoped:Fable", label: "Week · Fable", percent: 99 }])).toEqual([]);
  });

  it("names where the numbers come from, so two accounts' windows never share an alert", () => {
    const work = scopeOf("/home/u/.claude-work/.claude.json");
    expect(work).toMatch(/^[0-9a-z]+$/);
    expect(scopeOf("/home/u/.claude-work/.claude.json")).toBe(work);
    expect(scopeOf("/home/u/.claude.json")).not.toBe(work);
    expect(reachedThresholds([session(72)], work).map((a) => a.id)).toEqual([`${work}-session-70-29869750`]);
  });

  it("gives every fetch of one window the same id, though each reports the reset a fraction of a second apart", () => {
    const later = Date.parse("2026-10-16T21:10:00.731412+00:00");
    expect(reachedThresholds([session(72, later)]).map((a) => a.id)).toEqual(reachedThresholds([session(71)]).map((a) => a.id));
    expect(reachedThresholds([{ key: "session", label: "5h", percent: 80 }]).map((a) => a.id)).toEqual(["session-70-none"]);
  });
});

describe("AlertLedger", () => {
  it("lets exactly one window claim each alert, across instances", () => {
    const dir = path.join(tempConfigDir(), "usage-alerts");
    const a = new AlertLedger(dir);
    const b = new AlertLedger(dir);
    expect(a.claim("session-70-1000")).toBe(true);
    expect(b.claim("session-70-1000")).toBe(false);
    expect(a.claim("session-70-1000")).toBe(false);
    expect(b.claim("session-90-1000")).toBe(true);
  });

  it("forgets old alerts", () => {
    const dir = path.join(tempConfigDir(), "usage-alerts");
    const ledger = new AlertLedger(dir);
    ledger.claim("old");
    ledger.claim("new");
    const old = new Date(Date.now() - 10 * 24 * 3_600_000);
    fs.utimesSync(path.join(dir, "old"), old, old);
    ledger.prune(Date.now());
    expect(fs.readdirSync(dir)).toEqual(["new"]);
    new AlertLedger(path.join(dir, "missing")).prune(Date.now());
  });
});
