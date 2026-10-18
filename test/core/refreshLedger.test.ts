import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BACKOFF_MS, MIN_REFRESH_GAP_MS, RefreshLedger } from "../../src/core/refreshLedger";
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
