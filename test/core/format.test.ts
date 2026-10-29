import { describe, expect, it } from "vitest";
import { clockTime, countStates, describeAlert, describeEvidence, describeLocation, describeReason, describeSpan, shortSpan, describeState, formatCountdown, formatElapsed, formatResetIn, formatTokens, formatUntil, formatUsd, noticeBody, quietFor, shortModel, windowName } from "../../src/core/format";
import { view } from "../vscode/helpers";

describe("format", () => {
  it("formats elapsed time at each scale", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(12 * 60_000)).toBe("12m");
    expect(formatElapsed((3 * 60 + 5) * 60_000)).toBe("3h 05m");
    expect(formatElapsed(49 * 3_600_000)).toBe("2d");
  });

  it("describes state with how long it has lasted, and location", () => {
    const now = 12 * 60_000;
    expect(describeState(view({ state: "waiting", reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt" } }), now)).toBe("Needs you for 12m: Permission · Bash: npm test");
    expect(describeState(view({ state: "waiting", reason: { kind: "permission", ask: "permission prompt", raw: "permission prompt" } }), now)).toBe("Needs you for 12m: Permission prompt");
    expect(describeState(view({ state: "waiting", since: undefined }), now)).toBe("Needs you: input");
    expect(describeState(view({ state: "working" }), now)).toBe("Working for 12m");
    expect(describeState(view({ state: "done", since: now - 3 * 60_000 }), now)).toBe("Finished 3m ago");
    expect(describeState(view({ state: "idle" }), now)).toBe("Idle for 12m");
    expect(describeState(view({ state: "unknown" }), now)).toBe("State unknown");
    expect(describeLocation(view({ worktree: "fix-x" }))).toBe("app · fix-x");
    expect(describeLocation(view())).toBe("app");
  });

  it("says what a waiting session asks, by kind", () => {
    expect(describeReason({ kind: "question", ask: "Which color?", options: ["Red", "Blue"], raw: "input needed" })).toBe("Question · Which color? (Red / Blue)");
    expect(describeReason({ kind: "plan", ask: "Cache the specs", raw: "permission prompt" })).toBe("Plan approval · Cache the specs");
    expect(describeReason({ kind: "dialog", ask: "choose: retry on fallback model or edit prompt", raw: "dialog open" })).toBe("Dialog · choose: retry on fallback model or edit prompt");
    expect(describeReason({ kind: "dialog", ask: "sandbox request", raw: "sandbox request" })).toBe("Sandbox request");
    expect(describeReason({ kind: "typed", ask: "Want me to open the PR?" })).toBe("Asked you a question · Want me to open the PR?");
    expect(describeReason(undefined)).toBe("input");
  });

  it("marks a working session quiet when its transcript has been silent for more than 10 minutes", () => {
    const now = 60 * 60_000;
    expect(quietFor(view({ state: "working", lastWriteAt: now - 10 * 60_000 }), now)).toBeUndefined();
    expect(quietFor(view({ state: "working", lastWriteAt: now - 12 * 60_000 }), now)).toBe(12 * 60_000);
    expect(quietFor(view({ state: "working" }), now)).toBeUndefined();
    expect(quietFor(view({ state: "idle", lastWriteAt: 0 }), now)).toBeUndefined();
    expect(describeState(view({ state: "working", since: 0, lastWriteAt: now - 12 * 60_000 }), now)).toBe("Working, quiet 12m");
    expect(describeState(view({ state: "working", since: 0, lastWriteAt: now - 60_000 }), now)).toBe("Working for 1h 00m");
    // A turn that has just started is not quiet, however old the transcript's last write.
    expect(quietFor(view({ state: "working", since: now - 5_000, lastWriteAt: now - 2 * 3_600_000 }), now)).toBeUndefined();
  });

  it("says where a state comes from and how old it is", () => {
    const now = 100_000;
    expect(describeEvidence({ source: "session file", at: now - 4_000 }, now)).toBe("From the session file, written 4s ago");
    expect(describeEvidence({ source: "process", at: now - 12_000, note: "no state recorded yet" }, now)).toBe("From the process, started 12s ago: no state recorded yet");
    expect(describeEvidence({ source: "session file", note: "it cannot be read" }, now)).toBe("From the session file: it cannot be read");
    expect(describeEvidence(undefined, now)).toBeUndefined();
  });

  it("says in a desktop notification why a session needs the user", () => {
    expect(noticeBody(view({ state: "waiting", reason: { kind: "permission", ask: "Bash: npm test", raw: "permission prompt" } }), false)).toBe("Needs you: Permission · Bash: npm test");
    expect(noticeBody(view({ state: "waiting", reason: { kind: "typed", ask: "Want me to open the PR?" } }), false)).toBe("Asked you a question: Want me to open the PR?");
    expect(noticeBody(view({ state: "done" }), true)).toBe("Finished its turn");
  });

  it("counts down compactly for the status bar", () => {
    expect([formatCountdown(0), formatCountdown(59_000), formatCountdown(45 * 60_000), formatCountdown(72 * 60_000), formatCountdown(26 * 3_600_000)]).toEqual(["0m", "1m", "45m", "1h12m", "1d"]);
    // The board and the hover round up the same way, so they agree with the status bar.
    expect([formatUntil(59_000), formatUntil(148 * 60_000 + 30_000), formatUntil(149 * 60_000), formatUntil(-5)]).toEqual(["1m", "2h 29m", "2h 29m", "0s"]);
    expect(formatCountdown(148 * 60_000 + 30_000)).toBe("2h29m");
  });

  it("writes a time of day, with the weekday when it is not today", () => {
    const now = new Date(2026, 9, 16, 10, 0).getTime();
    expect(clockTime(new Date(2026, 9, 16, 15, 40).getTime(), now)).toBe("15:40");
    expect(clockTime(new Date(2026, 9, 17, 9, 5).getTime(), now)).toBe("Sat 09:05");
    expect(clockTime(new Date(2026, 9, 30, 9, 5).getTime(), now)).toBe("Oct 30, 09:05");
  });

  it("names a usage window", () => {
    expect(windowName({ key: "session", label: "5h", percent: 1 })).toBe("5-hour limit");
    expect(windowName({ key: "weekly_all", label: "Week", percent: 1 })).toBe("weekly limit");
    expect(windowName({ key: "weekly_scoped:Fable", label: "Week · Fable", percent: 1 })).toBe("weekly Fable limit");
    expect(windowName({ key: "other", label: "other", percent: 1 })).toBe("other limit");
  });

  it("says when a conversation started and when it was last active", () => {
    const a = new Date(2026, 9, 4, 11, 46).getTime();
    const b = new Date(2026, 9, 6, 9, 12).getTime();
    expect(describeSpan(a, b)).toMatch(/^started .*4.*11:46.* · last active .*6.*09:12/);
    expect(describeSpan(a, a)).toMatch(/^started [^·]+$/);
    expect(describeSpan(undefined, undefined)).toBe("");
  });

  it("says the days a conversation spans and how long ago it moved", () => {
    const now = new Date(2026, 9, 18, 13, 45).getTime();
    expect(shortSpan(new Date(2026, 9, 16, 19, 22).getTime(), now - 3 * 3_600_000, now)).toMatch(/^Oct 16 → Oct 18 · active 3h ago$/);
    expect(shortSpan(now - 600_000, now - 30_000, now)).toMatch(/^Oct 18 · active now$/);
    expect(shortSpan(now - 9 * 86_400_000, now - 5 * 86_400_000, now)).toMatch(/ · active 5d ago$/);
    expect(shortSpan(undefined, undefined, now)).toBe("");
  });

  it("says when a limit resets as Claude Code's panel says it", () => {
    expect(formatResetIn(30_000)).toBe("in 0m");
    expect(formatResetIn(42 * 60_000)).toBe("in 42m");
    expect(formatResetIn((3 * 60 + 28) * 60_000)).toBe("in 3h");
    expect(formatResetIn(23.9 * 3_600_000)).toBe("in 23h");
    expect(formatResetIn(2.5 * 86_400_000)).toBe("in 2d");
  });

  it("says which usage limit reached a threshold, and when it resets", () => {
    const now = new Date(2026, 9, 16, 12, 0).getTime();
    expect(describeAlert({ key: "session", label: "5h", percent: 72, resetsAt: new Date(2026, 9, 16, 17, 5).getTime() }, now)).toEqual({
      text: "Your 5-hour limit is at 72%; it resets at 17:05.",
      title: "5-hour limit at 72%",
      body: "It resets at 17:05.",
    });
    expect(describeAlert({ key: "weekly_all", label: "Week", percent: 91, resetsAt: new Date(2026, 9, 20, 23, 0).getTime() }, now).text).toBe("Your weekly limit is at 91%; it resets at Tue 23:00.");
    expect(describeAlert({ key: "session", label: "5h", percent: 90 }, now)).toEqual({ text: "Your 5-hour limit is at 90%.", title: "5-hour limit at 90%", body: "Usage" });
    // One account's of several says which.
    expect(describeAlert({ key: "session", label: "5h", percent: 90, account: "personal" }, now)).toEqual({ text: "Your 5-hour limit (personal) is at 90%.", title: "5-hour limit (personal) at 90%", body: "Usage" });
  });

  it("counts sessions per state", () => {
    expect(countStates([view({ state: "working" }), view({ state: "working" }), view({ state: "done" })])).toEqual({
      waiting: 0,
      done: 1,
      working: 2,
      unknown: 0,
      idle: 0,
    });
  });

  it("formats token counts and model names", () => {
    expect([formatTokens(850), formatTokens(189_585), formatTokens(1_250_000)]).toEqual(["850", "190k", "1.3M"]);
    expect(shortModel("claude-fable-5-1[1m]")).toBe("Fable 5.1");
    expect(shortModel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModel("gpt-6")).toBe("gpt-6");
  });

  it("formats money", () => {
    expect([formatUsd(0.004), formatUsd(0.42), formatUsd(9.99), formatUsd(117.47), formatUsd(1234)]).toEqual(["$0.00", "$0.42", "$9.99", "$117", "$1.2k"]);
  });
});
