import { describe, expect, it } from "vitest";
import { cardLine, contextLevel, contextPercent, formatWhen, groupSessions, HARBOUR, hostChip, isFoldKey, layoutBoats, pageOf, pulseBars, scheduleChip, secondLine, waterline } from "../../src/webview/model";
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
    // Parked last, whatever their state.
    expect(groupSessions([view({ id: "p", state: "idle", parked: true }), view({ id: "w", state: "waiting" })]).map((g) => [g.key, g.label, g.views.map((v) => v.id)])).toEqual([
      ["waiting", "Needs you", ["w"]],
      ["parked", "Parked", ["p"]],
    ]);
    expect(groupSessions([])).toEqual([]);
  });
});

describe("isFoldKey", () => {
  it("takes Favourites, the state groups and the sections by attribute, and nothing else kept in the board's state", () => {
    for (const key of ["favourites", "waiting", "done", "working", "idle", "parked", "project:api", "branch:", "model:Opus 5.5", "agent:Codex", "window:This window"]) expect(isFoldKey(key)).toBe(true);
    for (const key of ["earlier", "archive", "Favourites", "unknown", "", "size:x", "project", 1, null, undefined]) expect(isFoldKey(key)).toBe(false);
  });
});

describe("card text", () => {
  it("names where a session runs, except the window's own panel", () => {
    expect(hostChip(view())).toBeUndefined();
    expect(hostChip(view({ host: "terminal" }))).toBe("terminal");
    expect(hostChip(view({ host: "window", windowLabel: "api" }))).toBe("window: api");
    expect(hostChip(view({ host: "window" }))).toBe("another window");
    expect(hostChip(view({ host: "elsewhere" }))).toBe("outside VS Code");
    expect(hostChip(view({ host: "editor" }))).toBe("window without Lookout");
  });

  it("picks the second line by state, with the kind of ask as its label", () => {
    const now = 30 * 60_000;
    expect(cardLine(view({ state: "waiting", reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt" } }), now)).toEqual({ label: "Permission", text: "Bash: npm test", options: undefined });
    expect(cardLine(view({ state: "waiting", reason: { kind: "permission", ask: "permission prompt", raw: "permission prompt" } }), now)).toEqual({ label: "Permission", text: undefined, options: undefined });
    expect(cardLine(view({ state: "waiting", reason: { kind: "question", ask: "Which color?", options: ["Red", "Blue"] } }), now)).toEqual({ label: "Question", text: "Which color?", options: ["Red", "Blue"] });
    expect(cardLine(view({ state: "waiting", reason: { kind: "typed", ask: "Want me to open the PR?" } }), now)).toMatchObject({ label: "Asked you a question", text: "Want me to open the PR?" });
    expect(cardLine(view({ state: "waiting" }), now)).toEqual({ text: "input needed" });
    expect(cardLine(view({ state: "working", activity: "Bash · npm test", lastWriteAt: now - 60_000 }), now)).toEqual({});
    expect(cardLine(view({ state: "working", lastWriteAt: now - 12 * 60_000 }), now)).toEqual({ label: "quiet 12m" });
    // A finished or idle session's card says nothing more: its state and title say it.
    expect(cardLine(view({ state: "done" }), now)).toEqual({});
    expect(cardLine(view({ state: "idle" }), now)).toEqual({});
    expect(cardLine(view({ state: "working", background: { count: 1, since: now - 2 * 3_600_000, activeMs: 45 * 60_000 } }), now)).toEqual({ label: "1 background job · 2h 00m", text: "busy 45m" });
    expect(cardLine(view({ state: "working", background: { count: 2, activeMs: 0 } }), now)).toEqual({ label: "2 background jobs", text: undefined });
    expect(cardLine(view({ state: "working", background: { count: 1, since: now - 3_600_000, activeMs: 60_000, idleMs: 20 * 60_000 } }), now)).toEqual({ label: "1 background job · 1h 00m", text: "idle 20m: may be stuck", stuck: true });
    expect(cardLine(view({ state: "working", background: { count: 1, activeMs: 0, orphaned: 1 } }), now)).toEqual({ label: "1 background job", text: "orphaned: the agent no longer follows it", stuck: true });
    expect(cardLine(view({ state: "unknown", evidence: { source: "session file", note: "it records no state" } }), now)).toEqual({ text: "it records no state" });
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

  it("gives a parked session no boat", () => {
    const boats = layoutBoats([view({ id: "i", state: "idle", since: 0 }), view({ id: "p", state: "idle", since: 0, parked: true })], 60_000, water);
    expect(boats.map((b) => b.id)).toEqual(["i"]);
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
});

describe("pageOf", () => {
  it("cuts a list into pages and keeps the page shown inside it", () => {
    expect(pageOf(57, 0, 20)).toEqual({ page: 0, pages: 3, first: 0, end: 20 });
    expect(pageOf(57, 2, 20)).toEqual({ page: 2, pages: 3, first: 40, end: 57 });
    // The list shrank under the last page, or a search left fewer: the last page that is left.
    expect(pageOf(25, 2, 20)).toEqual({ page: 1, pages: 2, first: 20, end: 25 });
    expect(pageOf(20, 1, 20)).toEqual({ page: 0, pages: 1, first: 0, end: 20 });
    expect(pageOf(0, 3, 20)).toEqual({ page: 0, pages: 1, first: 0, end: 0 });
    expect(pageOf(5, -1, 20)).toEqual({ page: 0, pages: 1, first: 0, end: 5 });
  });
});

describe("the schedule chip", () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
  const now = at(2026, 10, 26, 13, 42);

  it("says a time to come from now, closer times in more detail", () => {
    expect(formatWhen(now + 30_000, now)).toBe("now");
    expect(formatWhen(now - 30_000, now)).toBe("now");
    expect(formatWhen(now - 5 * 60_000, now)).toBe("due");
    expect(formatWhen(now + 25 * 60_000, now)).toBe("in 25 min");
    expect(formatWhen(at(2026, 10, 26, 15, 0), now)).toBe("at 15:00");
    expect(formatWhen(at(2026, 10, 27, 9, 13), now)).toBe("09:13 tomorrow");
    expect(formatWhen(at(2026, 10, 29, 8, 0), now)).toBe("Thu 08:00");
    expect(formatWhen(at(2026, 11, 2, 9, 13), now)).toBe("Nov 2 09:13");
    // Past midnight but under an hour away: still minutes.
    expect(formatWhen(at(2026, 10, 27, 0, 10), at(2026, 10, 26, 23, 30))).toBe("in 40 min");
  });

  it("shows the next task on the chip, counts the rest, and lists them all in the hover", () => {
    expect(scheduleChip(undefined, now)).toBeUndefined();
    expect(scheduleChip([], now)).toBeUndefined();
    const wakeup = { kind: "wakeup" as const, label: "wakes once", prompt: "Check the reviewer", nextAt: now + 25 * 60_000 };
    const daily = { kind: "cron" as const, label: "every day at 09:13", prompt: "Daily list check", nextAt: at(2026, 10, 27, 9, 13), expiresAt: now + 6 * 86_400_000 };
    const once = { kind: "cron" as const, label: "once, every day at 15:00", prompt: "Run the smoke", nextAt: at(2026, 10, 26, 15, 0) };
    expect(scheduleChip([wakeup], now)).toEqual({ text: "◷ in 25 min", title: "Wakes in 25 min: Check the reviewer\nScheduled by the session for itself; gone when the session ends.", kind: "schedule" });
    const chip = scheduleChip([wakeup, once, daily], now)!;
    expect(chip.text).toBe("◷ in 25 min +2");
    expect(chip.title!.split("\n")).toEqual(["Wakes in 25 min: Check the reviewer", "Runs at 15:00: Run the smoke", "Every day at 09:13, next 09:13 tomorrow: Daily list check", "Scheduled by the session for itself; gone when the session ends."]);
    // A cron whose next run cannot be told, and a prompt that is empty.
    expect(scheduleChip([{ kind: "cron", label: "cron 0 0 31 feb *", prompt: "" }], now)).toMatchObject({ text: "◷ scheduled", title: "Cron 0 0 31 feb *: (no prompt)\nScheduled by the session for itself; gone when the session ends." });
  });
});
