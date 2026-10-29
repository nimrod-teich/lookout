import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_SPACING_MS, MAX_BACKOFF_MS, MIN_REFRESH_GAP_MS, RefreshLedger } from "../../src/core/refreshLedger";
import { tempConfigDir } from "./helpers";

const T = 1_800_000_000_000;

describe("RefreshLedger", () => {
  it("lets one refresh start every 180 s on the host, across windows", () => {
    const dir = path.join(tempConfigDir(), "refresh");
    const a = new RefreshLedger(dir);
    const b = new RefreshLedger(dir);
    expect(a.nextAt("s-1", false)).toBe(-Infinity);
    expect(a.claim("s-1", T)).toBe(true);
    // The other window sees the attempt: the same numbers wait for the backoff, any others for the gap.
    expect(b.nextAt("s-1", false)).toBe(T + 2 * MIN_REFRESH_GAP_MS);
    expect(b.nextAt("s-2", false)).toBe(T + MIN_REFRESH_GAP_MS);
    expect(b.nextAt("s-1", true)).toBe(T + MIN_REFRESH_GAP_MS);
  });

  it("keeps the 180 s gap per source, and only a short spacing between two sources' automatic refreshes", () => {
    const dir = path.join(tempConfigDir(), "refresh");
    const a = new RefreshLedger(dir);
    const b = new RefreshLedger(dir);
    expect(a.claim("work-1", T, false, "work")).toBe(true);
    // Another account: the spacing, not the gap; asked for, not even that.
    expect(b.nextAt("home-1", false, "home")).toBe(T + HOST_SPACING_MS);
    expect(b.nextAt("home-1", true, "home")).toBe(-Infinity);
    expect(b.claim("home-1", T + HOST_SPACING_MS - 1, false, "home")).toBe(false);
    expect(b.claim("home-1", T + HOST_SPACING_MS, false, "home")).toBe(true);
    // The same account waits for its own gap, the user's refresh too.
    expect(a.nextAt("work-2", true, "work")).toBe(T + MIN_REFRESH_GAP_MS);
    expect(a.nextAt("work-2", false, "work")).toBe(T + MIN_REFRESH_GAP_MS);
    // A caller that names no source still waits 180 s after any refresh: a window of an older Lookout.
    expect(a.nextAt("work-2", false)).toBe(T + HOST_SPACING_MS + MIN_REFRESH_GAP_MS);
  });

  it("gives each attempt to exactly one window, and only when it is due", () => {
    const dir = path.join(tempConfigDir(), "refresh");
    const a = new RefreshLedger(dir);
    const b = new RefreshLedger(dir);
    expect([a.claim("s-1", T), b.claim("s-1", T)]).toEqual([true, false]);
    expect(a.attempts("s-1")).toEqual({ count: 1, lastAt: T });
    // Not before the gap, even asked for; then the user's refresh may go, an automatic one waits for the backoff.
    expect(b.claim("s-1", T + MIN_REFRESH_GAP_MS - 1, true)).toBe(false);
    expect(b.claim("s-1", T + MIN_REFRESH_GAP_MS, false)).toBe(false);
    expect(b.claim("s-1", T + MIN_REFRESH_GAP_MS, true)).toBe(true);
    // A window that counted one attempt while another made the second loses the race for that file.
    fs.writeFileSync(path.join(dir, "fetch-s-2-0"), "");
    expect(a.attempts("s-2").count).toBe(1);
  });

  it("counts failed attempts at the same numbers, doubling the wait up to 30 minutes; new numbers start over", () => {
    const ledger = new RefreshLedger(path.join(tempConfigDir(), "refresh"));
    let now = T;
    expect(ledger.claim("s-1", now)).toBe(true);
    for (let failed = 1; failed <= 6; failed++) {
      const next = ledger.nextAt("s-1", false);
      expect(next).toBe(now + Math.min(MAX_BACKOFF_MS, MIN_REFRESH_GAP_MS * 2 ** failed));
      expect(ledger.claim("s-1", next - 1)).toBe(false);
      expect(ledger.claim("s-1", next)).toBe(true);
      now = next;
    }
    expect(ledger.attempts("s-1")).toEqual({ count: 7, lastAt: now });
    expect(ledger.nextAt("s-1", false)).toBe(now + MAX_BACKOFF_MS);
    // The user's own refresh waits only for the gap.
    expect(ledger.nextAt("s-1", true)).toBe(now + MIN_REFRESH_GAP_MS);
    expect(ledger.attempts("s-2")).toEqual({ count: 0 });
    expect(ledger.nextAt("s-2", false)).toBe(now + MIN_REFRESH_GAP_MS);
  });

  it("holds off every refresh of one source until the time the endpoint asked for, in every window", () => {
    const dir = path.join(tempConfigDir(), "refresh");
    const a = new RefreshLedger(dir);
    const b = new RefreshLedger(dir);
    expect(b.heldUntil("acct")).toBe(-Infinity);
    a.hold("acct", T + 600_000);
    expect(b.heldUntil("acct")).toBe(T + 600_000);
    // Another config directory's numbers are not held.
    expect(b.heldUntil("other")).toBe(-Infinity);
    // A later 429 replaces the wait; a hold that does not parse holds nothing.
    a.hold("acct", T + 60_000);
    expect(b.heldUntil("acct")).toBe(T + 60_000);
    fs.writeFileSync(path.join(dir, "hold-acct"), "soon");
    expect(b.heldUntil("acct")).toBe(-Infinity);
  });

  it("forgets holds that are over", () => {
    const dir = path.join(tempConfigDir(), "refresh");
    const ledger = new RefreshLedger(dir);
    ledger.hold("done", T);
    ledger.hold("running", T + 60_000);
    ledger.prune(T);
    expect(fs.readdirSync(dir).sort()).toEqual(["hold-running"]);
    expect(ledger.heldUntil("running")).toBe(T + 60_000);
  });

  it("forgets attempts at numbers long gone, and survives a missing folder", () => {
    const dir = path.join(tempConfigDir(), "refresh");
    const ledger = new RefreshLedger(dir);
    ledger.claim("old", T);
    ledger.claim("new", T + 2 * 24 * 3_600_000);
    ledger.prune(T + 2 * 24 * 3_600_000);
    expect(fs.readdirSync(dir).sort()).toEqual(["fetch-new-0", "last"]);
    new RefreshLedger(path.join(dir, "missing")).prune(T);
    expect(new RefreshLedger(path.join(dir, "missing")).attempts("x")).toEqual({ count: 0 });
  });
});
