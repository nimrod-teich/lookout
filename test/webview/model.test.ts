import { describe, expect, it } from "vitest";
import { cacheChip, cardLine, compactedSinceLastCall, compactionChip, contextLevel, contextPercent, groupSessions, HARBOUR, hostChip, layoutBoats, pulseBars, secondLine, waterline } from "../../src/webview/model";
import { view } from "../vscode/helpers";

describe("groupSessions", () => {
  it("groups by state in display order and drops empty groups", () => {
    const groups = groupSessions([
      view({ id: "w", state: "waiting" }),
      view({ id: "d", state: "done" }),
      view({ id: "b", state: "working" }),
      view({ id: "u", state: "unknown" }),
      view({ id: "i", state: "idle" }),
    ]);
    expect(groups.map((g) => [g.key, g.label, g.views.map((v) => v.id)])).toEqual([
      ["waiting", "Needs you", ["w"]],
      ["done", "Finished", ["d"]],
      ["working", "Working", ["b"]],
      ["idle", "Idle", ["u", "i"]],
    ]);
    expect(groupSessions([view({ state: "working" })]).map((g) => g.key)).toEqual(["working"]);
    expect(groupSessions([])).toEqual([]);
  });
});

describe("card text", () => {
  it("names where a session runs, except the window's own panel", () => {
    expect(hostChip(view())).toBeUndefined();
    expect(hostChip(view({ host: "terminal" }))).toBe("terminal");
    expect(hostChip(view({ host: "window", windowLabel: "api" }))).toBe("window: api");
    expect(hostChip(view({ host: "window" }))).toBe("another window");
    expect(hostChip(view({ host: "elsewhere" }))).toBe("outside VS Code");
  });

  it("picks the second line by state, with the kind of ask as its label", () => {
    const now = 30 * 60_000;
    expect(cardLine(view({ state: "waiting", reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt" } }), now)).toEqual({ label: "Permission", text: "Bash: npm test", options: undefined });
    expect(cardLine(view({ state: "waiting", reason: { kind: "permission", ask: "permission prompt", raw: "permission prompt" } }), now)).toEqual({ label: "Permission", text: undefined, options: undefined });
    expect(cardLine(view({ state: "waiting", reason: { kind: "question", ask: "Which color?", options: ["Red", "Blue"] } }), now)).toEqual({ label: "Question", text: "Which color?", options: ["Red", "Blue"] });
    expect(cardLine(view({ state: "waiting", reason: { kind: "typed", ask: "Want me to open the PR?" } }), now)).toMatchObject({ label: "Asked you a question", text: "Want me to open the PR?" });
    expect(cardLine(view({ state: "waiting" }), now)).toEqual({ text: "input needed" });
    expect(cardLine(view({ state: "working", activity: "Bash · npm test", lastWriteAt: now - 60_000 }), now)).toEqual({ label: undefined, text: "Bash · npm test" });
    expect(cardLine(view({ state: "working", lastWriteAt: now - 12 * 60_000 }), now)).toEqual({ label: "quiet 12m", text: "thinking" });
    expect(cardLine(view({ state: "done", lastReply: "All green." }), now)).toEqual({ text: "All green." });
    expect(cardLine(view({ state: "idle" }), now)).toEqual({ text: undefined });
    expect(cardLine(view({ state: "unknown", lastReply: "x", evidence: { source: "session file", note: "it records no state" } }), now)).toEqual({ text: "it records no state" });
    expect(secondLine(view({ state: "waiting", reason: { kind: "plan", ask: "Cache the specs" } }), now)).toBe("Plan approval · Cache the specs");
    expect(secondLine(view({ state: "idle" }), now)).toBeUndefined();
  });
});

describe("waterline", () => {
  it("rises with the 5-hour usage and clamps", () => {
    expect(waterline(undefined)).toBe(HARBOUR.seaTop);
    expect(waterline(0)).toBe(HARBOUR.seaTop);
    expect(waterline(50)).toBe((HARBOUR.seaTop + HARBOUR.seaTopFull) / 2);
    expect(waterline(100)).toBe(HARBOUR.seaTopFull);
    expect(waterline(250)).toBe(HARBOUR.seaTopFull);
    expect(waterline(-5)).toBe(HARBOUR.seaTop);
  });
});

describe("layoutBoats", () => {
  const water = HARBOUR.seaTop;

  it("floats every boat on the water, by lane, and keeps it inside the harbour", () => {
    const now = 60 * 60_000;
    const boats = layoutBoats(
      [view({ id: "w", state: "waiting", since: now - 60_000 }), view({ id: "b", state: "working", since: now - 60_000 }), view({ id: "i", state: "idle", since: now - 60_000 })],
      now,
      water,
    );
    const byId = Object.fromEntries(boats.map((b) => [b.id, b]));
    expect(byId.w!.y).toBeLessThan(byId.b!.y);
    expect(byId.b!.y).toBeLessThan(byId.i!.y);
    for (const boat of boats) {
      expect(boat.y).toBeGreaterThan(water);
      expect(boat.y).toBeLessThan(HARBOUR.height);
      expect(boat.x).toBeGreaterThanOrEqual(HARBOUR.nearX);
      expect(boat.x).toBeLessThanOrEqual(HARBOUR.farX);
      expect(boat.bearing).toBeGreaterThan(0);
      expect(boat.bearing).toBeLessThan(90);
    }
  });

  it("puts a session farther from the shore the longer it has been in its state, up to the far edge", () => {
    const now = 10 * 3_600_000;
    const [fresh, minute, hour, day] = layoutBoats(
      [
        view({ id: "fresh", state: "working", since: now }),
        view({ id: "minute", state: "working", since: now - 60_000 }),
        view({ id: "hour", state: "working", since: now - 3_600_000 }),
        view({ id: "day", state: "working", since: now - 86_400_000 }),
      ],
      now,
      water,
    );
    expect(fresh!.x).toBeCloseTo(HARBOUR.nearX, 0);
    expect(minute!.x).toBeGreaterThan(fresh!.x);
    expect(hour!.x).toBeGreaterThan(minute!.x);
    expect(day!.x).toBeCloseTo(HARBOUR.farX, 0);
  });

  it("labels the sessions that need the user, at most two", () => {
    const now = 5 * 60_000;
    const boats = layoutBoats(
      [view({ id: "a", state: "waiting", title: "First", since: now - 3 * 60_000 }), view({ id: "b", state: "waiting", title: "Second", since: now - 3 * 60_000 }), view({ id: "c", state: "waiting", title: "Third" }), view({ id: "d", state: "working", title: "Busy" })],
      now,
      water,
    );
    expect(boats.map((b) => b.label)).toEqual(["First · 3m", "Second · 3m", undefined, undefined]);
  });

  it("keeps boats of one lane apart when they started together", () => {
    const now = 60_000;
    const boats = layoutBoats([view({ id: "a", state: "working", since: now - 27_000 }), view({ id: "b", state: "working", since: now - 15_000 }), view({ id: "c", state: "working", since: now - 20_000 })], now, water);
    const xs = boats.map((b) => b.x).sort((p, q) => p - q);
    expect(xs[1]! - xs[0]!).toBeGreaterThanOrEqual(11);
    expect(xs[2]! - xs[1]!).toBeGreaterThanOrEqual(11);
    expect(Math.max(...xs)).toBeLessThanOrEqual(HARBOUR.farX);
  });

  it("follows the tide", () => {
    const low = layoutBoats([view({ state: "working" })], 0, waterline(0))[0]!;
    const high = layoutBoats([view({ state: "working" })], 0, waterline(100))[0]!;
    expect(high.y).toBeLessThan(low.y);
  });
});

describe("card telemetry", () => {
  it("scales the pulse to its busiest minute", () => {
    expect(pulseBars([0, 2, 4, 1])).toEqual([0, 0.5, 1, 0.25]);
    expect(pulseBars([0, 0])).toEqual([0, 0]);
    expect(pulseBars(undefined)).toEqual([]);
  });

  it("gives the context as a percentage only when the window is known", () => {
    expect(contextPercent(view({ contextTokens: 150_000, contextWindow: 200_000 }))).toBe(75);
    expect(contextPercent(view({ contextTokens: 1_200_000, contextWindow: 1_000_000 }))).toBe(100);
    expect(contextPercent(view({ contextTokens: 150_000 }))).toBeUndefined();
    expect(contextPercent(view({ contextWindow: 200_000 }))).toBeUndefined();
  });

  it("turns the context ring amber from 75% and red from 90%", () => {
    expect([0, 74, 75, 89, 90, 100].map(contextLevel)).toEqual(["ok", "ok", "high", "high", "full", "full"]);
  });

  it("says how often the conversation was compacted, and when last", () => {
    const now = new Date(2026, 9, 16, 15, 0).getTime();
    expect(compactionChip(view(), now)).toBeUndefined();
    const once = compactionChip(view({ compactions: 1, compactedAt: new Date(2026, 9, 16, 14, 5).getTime() }), now);
    expect(once?.text).toBe("compacted ×1");
    expect(once?.title).toMatch(/^The agent compacted this conversation once, the last time at 14:05: it replaced the older part with a summary/);
    expect(compactionChip(view({ compactions: 3 }), now)?.title).toMatch(/compacted this conversation 3 times: /);
  });

  it("counts down to when the prompt cache lets the conversation go, then calls it cold", () => {
    const MIN_15 = 15 * 60_000;
    const lastCallAt = new Date(2026, 9, 16, 14, 0).getTime();
    const idle = view({ state: "idle", contextTokens: 142_000, cache: { lastCallAt, ttlMs: 5 * 60_000 } });
    const warm = cacheChip(idle, lastCallAt + 2 * 60_000 + 10_000);
    expect(warm).toMatchObject({ text: "cache warm, full price in 3m", kind: "cache warm" });
    expect(warm?.title).toBe(
      "The model's prompt cache keeps this conversation for 5 minutes after each call; the last went out at 14:00. A message sent before 14:05 reads its 142k tokens from the cache, for a fraction of the input price. After that, the conversation is written to the cache again, which costs more than the input price.",
    );
    const cold = cacheChip(idle, lastCallAt + 5 * 60_000);
    expect(cold).toMatchObject({ text: "cache cold", kind: "cache cold" });
    expect(cold?.title).toBe("The model's prompt cache let this conversation go at 14:05, 5 minutes after the agent's last call went out. The next message writes its 142k tokens to the cache again, which costs more than the input price.");
    expect(cacheChip(view({ state: "waiting", cache: { lastCallAt, ttlMs: 3_600_000 } }), lastCallAt + 10 * 60_000)?.text).toBe("cache warm, full price in 50m");
    // Compacted since the last call: the conversation is shorter than the count.
    const compacted = view({ state: "idle", contextTokens: 142_000, compactions: 1, compactedAt: lastCallAt + 30_000, cache: { lastCallAt, ttlMs: 3_600_000 } });
    expect(compactedSinceLastCall(compacted)).toBe(true);
    expect(cacheChip(compacted, lastCallAt + MIN_15)?.title).toContain("A message sent before 15:00 reads it from the cache");
    expect(compactedSinceLastCall({ ...compacted, compactedAt: lastCallAt - 1 })).toBe(false);
    // While it works, every call keeps the cache warm; before its first call there is none.
    expect(cacheChip(view({ state: "working", cache: { lastCallAt, ttlMs: 3_600_000 } }), lastCallAt)).toBeUndefined();
    expect(cacheChip(view({ state: "idle" }), lastCallAt)).toBeUndefined();
  });
});
