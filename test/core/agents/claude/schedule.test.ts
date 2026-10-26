import { describe, expect, it } from "vitest";
import { CRON_EXPIRY_MS, cronListOf, cronResultOf, cronSchedule, describeCron, firedBy, nextCronRun, parseCron, parseWhen, pendingSchedules, promptLine, scheduleView, type Schedule } from "../../../../src/core/agents/claude/schedule";
import { applyLine, emptyTranscript, schedulesOf } from "../../../../src/core/agents/claude/transcript";

/** Local time, as cron is. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const iso = (t: number) => new Date(t).toISOString();

describe("parseCron and nextCronRun", () => {
  it("finds the next run for the common shapes, in local time", () => {
    const now = at(2026, 10, 26, 13, 42);
    expect(nextCronRun(parseCron("13 9 * * *")!, now)).toBe(at(2026, 10, 27, 9, 13));
    expect(nextCronRun(parseCron("13 9 * * *")!, at(2026, 10, 26, 9, 0))).toBe(at(2026, 10, 26, 9, 13));
    expect(nextCronRun(parseCron("13,43 * * * *")!, now)).toBe(at(2026, 10, 26, 13, 43));
    expect(nextCronRun(parseCron("23 * * * *")!, now)).toBe(at(2026, 10, 26, 14, 23));
    expect(nextCronRun(parseCron("*/15 * * * *")!, now)).toBe(at(2026, 10, 26, 13, 45));
    // 26 October 2026 is a Monday: the weekdays, a weekend day, a day of the month, and either when both are named.
    expect(nextCronRun(parseCron("0 8 * * 1-5")!, now)).toBe(at(2026, 10, 27, 8, 0));
    expect(nextCronRun(parseCron("0 8 * * sat")!, now)).toBe(at(2026, 10, 31, 8, 0));
    expect(nextCronRun(parseCron("0 8 1 * *")!, now)).toBe(at(2026, 11, 1, 8, 0));
    expect(nextCronRun(parseCron("0 8 29 * fri")!, now)).toBe(at(2026, 10, 29, 8, 0));
    expect(nextCronRun(parseCron("0 8 1 jan *")!, now)).toBe(at(2027, 1, 1, 8, 0));
    // The same minute again is not "next".
    expect(nextCronRun(parseCron("42 13 * * *")!, now)).toBe(at(2026, 10, 27, 13, 42));
  });

  it("refuses what is not five fields of cron, and never runs for a day no month has", () => {
    for (const expr of ["", "13 9 * *", "13 9 * * * *", "60 9 * * *", "13 24 * * *", "a b c d e", "*/0 * * * *", "5-1 * * * *", "Every hour at :23"]) expect(parseCron(expr), expr).toBeUndefined();
    expect(nextCronRun(parseCron("0 0 31 feb *")!, at(2026, 10, 26))).toBeUndefined();
  });
});

describe("describeCron", () => {
  it("says the common shapes in words, the rest as cron, and the scheduler's own words as they are", () => {
    expect(describeCron("13 9 * * *")).toBe("every day at 09:13");
    expect(describeCron("0 8,18 * * *")).toBe("every day at 08:00, 18:00");
    expect(describeCron("13,43 * * * *")).toBe("at :13, :43 every hour");
    expect(describeCron("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCron("0 8 * * 1-5")).toBe("weekdays at 08:00");
    expect(describeCron("30 7 * * mon,thu")).toBe("Mon, Thu at 07:30");
    expect(describeCron("0 8 1 * *")).toBe("cron 0 8 1 * *");
    expect(describeCron("Every hour at :23")).toBe("Every hour at :23");
  });
});

describe("the scheduler's answers", () => {
  const from = at(2026, 10, 26, 13, 42);

  it("reads a run's time in local time, the year implied", () => {
    expect(parseWhen("Oct 27 9:43am", from)).toBe(at(2026, 10, 27, 9, 43));
    expect(parseWhen("Oct 22 12:14pm", from)).toBe(at(2026, 10, 22, 12, 14));
    expect(parseWhen("Oct 15 11:43", from)).toBe(at(2026, 10, 15, 11, 43));
    expect(parseWhen("Jan 2 12:05am", from)).toBe(at(2027, 1, 2, 0, 5));
    expect(parseWhen("Dec 31 11:59pm", at(2027, 1, 1, 0, 30))).toBe(at(2026, 12, 31, 23, 59));
    expect(parseWhen("in a while", from)).toBeUndefined();
    expect(parseWhen("Oct 27 25:00", from)).toBeUndefined();
  });

  it("reads the job from a CronCreate result in either of Claude Code's forms, and nothing from a refusal", () => {
    expect(cronResultOf("Scheduled recurring job d00604b0 (Every day at 9:13 AM). Next run: Oct 27 9:43am. Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.", from)).toEqual({ id: "d00604b0", recurring: true, desc: "Every day at 9:13 AM", nextAt: at(2026, 10, 27, 9, 43) });
    expect(cronResultOf("Scheduled one-time job 0a1b2c3d (Oct 27 at 3:00 PM). Next run: Oct 27 3:00pm.", from)).toEqual({ id: "0a1b2c3d", recurring: false, desc: "Oct 27 at 3:00 PM", nextAt: at(2026, 10, 27, 15, 0) });
    expect(cronResultOf("Scheduled recurring job 04d1cc10 (13,43 * * * *). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days.", from)).toEqual({ id: "04d1cc10", recurring: true, desc: "13,43 * * * *" });
    expect(cronResultOf("04d1cc10 — 13,43 * * * * (recurring) [session-only], next run Oct 15 11:43am: MAG-4330 follow-up: check the PR", at(2026, 10, 15, 11, 0))).toEqual({ id: "04d1cc10", recurring: true, desc: "13,43 * * * *", nextAt: at(2026, 10, 15, 11, 43), prompt: "MAG-4330 follow-up: check the PR" });
    expect(cronResultOf("52cb9a8f — Every hour at :23 (recurring) [session-only]: Stack-rebase watch (automated, hourly): run the script", from)).toEqual({ id: "52cb9a8f", recurring: true, desc: "Every hour at :23", prompt: "Stack-rebase watch (automated, hourly): run the script" });
    expect(cronResultOf("Error: invalid cron expression", from)).toBeUndefined();
    expect(cronResultOf("Scheduled check of PR #958 is due", from)).toBeUndefined();
  });

  it("reads a CronList result, one job per line", () => {
    const text = "04d1cc10 — 13,43 * * * * (recurring) [session-only], next run Oct 15 11:43am: MAG-4330 follow-up\n52cb9a8f — Every hour at :23 (one-time) [session-only]: Once\nNo other jobs.";
    expect(cronListOf(text, at(2026, 10, 15, 11, 0))).toEqual([
      { id: "04d1cc10", recurring: true, desc: "13,43 * * * *", nextAt: at(2026, 10, 15, 11, 43), prompt: "MAG-4330 follow-up" },
      { id: "52cb9a8f", recurring: false, desc: "Every hour at :23", prompt: "Once" },
    ]);
    expect(cronListOf("No cron jobs scheduled.", from)).toEqual([]);
  });

  it("makes the schedule from the result: the scheduler's first run, and the shift it shows past the cron minute", () => {
    const daily = cronSchedule({ id: "d0", recurring: true, nextAt: at(2026, 10, 27, 9, 43) }, "13 9 * * *", "Daily check.\nMore.", from);
    expect(daily).toEqual({ id: "d0", kind: "cron", cron: "13 9 * * *", recurring: true, prompt: "Daily check.", fullPrompt: "Daily check.\nMore.", at: from, nextAt: at(2026, 10, 27, 9, 43), shiftMs: 30 * 60_000, expiresAt: from + CRON_EXPIRY_MS });
    // A first run before the cron minute, or far past it, is not the scheduler's shift: the run is kept, the shift not.
    expect(cronSchedule({ id: "d1", recurring: true, nextAt: at(2026, 10, 27, 9, 0) }, "13 9 * * *", "x", from).shiftMs).toBeUndefined();
    expect(cronSchedule({ id: "d2", recurring: true, nextAt: at(2026, 10, 27, 10, 0) }, "13 9 * * *", "x", from).shiftMs).toBeUndefined();
    // No run announced: the cron minute itself.
    expect(cronSchedule({ id: "d3", recurring: true }, "13 9 * * *", "x", from).nextAt).toBe(at(2026, 10, 27, 9, 13));
    // From a listing, with the scheduler's words for the expression: the run it gave, nothing to recompute from.
    expect(cronSchedule({ id: "l0", recurring: true, desc: "Every hour at :23", nextAt: at(2026, 10, 26, 14, 23), prompt: "Watch" }, undefined, undefined, from)).toMatchObject({ cron: "Every hour at :23", prompt: "Watch", fullPrompt: "Watch", nextAt: at(2026, 10, 26, 14, 23) });
  });
});

describe("promptLine and firedBy", () => {
  it("cuts a prompt to a line, says the loop's sentinel in words, and knows a task by the prompt it fires", () => {
    expect(promptLine("Check the PRs.\nThen report.")).toBe("Check the PRs.");
    expect(promptLine("x".repeat(200))).toHaveLength(160);
    expect(promptLine("<<autonomous-loop-dynamic>>")).toBe("(autonomous loop)");
    expect(promptLine(42)).toBe("");
    const task: Schedule = { id: "a", kind: "cron", prompt: "Check", fullPrompt: "Check the PRs.\nThen report." };
    expect(firedBy(task, "Check the PRs.\nThen report.")).toBe(true);
    expect(firedBy(task, "  Check the PRs.\nThen report. (and more)")).toBe(true);
    expect(firedBy(task, "Check the PRs")).toBe(false);
    expect(firedBy({ ...task, fullPrompt: undefined }, "Check")).toBe(false);
  });
});

describe("pendingSchedules", () => {
  const now = at(2026, 10, 26, 13, 42);
  const daily: Schedule = { id: "d0", kind: "cron", cron: "13 9 * * *", recurring: true, prompt: "daily check", at: now - 3_600_000, nextAt: at(2026, 10, 27, 9, 43), shiftMs: 30 * 60_000, expiresAt: now - 3_600_000 + CRON_EXPIRY_MS };

  it("keeps what is still to come, the next first, a recurring cron from now with its shift, and drops what fired or expired", () => {
    const wakeup: Schedule = { id: "wakeup", kind: "wakeup", prompt: "look again", at: now - 60_000, nextAt: now + 25 * 60_000 };
    const once: Schedule = { id: "o1", kind: "cron", cron: "0 15 * * *", recurring: false, prompt: "once", at: now, nextAt: at(2026, 10, 26, 15, 0), expiresAt: now + CRON_EXPIRY_MS };
    const fired: Schedule = { id: "o2", kind: "cron", cron: "0 12 * * *", recurring: false, prompt: "done", at: now - 7_200_000, nextAt: at(2026, 10, 26, 12, 0), expiresAt: now + CRON_EXPIRY_MS };
    const expired: Schedule = { ...daily, id: "old", at: now - 8 * 86_400_000, expiresAt: now - 86_400_000 };
    const woke: Schedule = { id: "wakeup", kind: "wakeup", prompt: "fired", at: now - 3_600_000, nextAt: now - 40 * 60_000 };
    expect(pendingSchedules([daily, once, fired, expired, wakeup], now).map((s) => [s.id, s.nextAt])).toEqual([
      ["wakeup", now + 25 * 60_000],
      ["o1", at(2026, 10, 26, 15, 0)],
      ["d0", at(2026, 10, 27, 9, 43)],
    ]);
    // Past the first run: the next minute the expression names, shifted as the scheduler shifts it.
    expect(pendingSchedules([daily], at(2026, 10, 27, 9, 50))[0]!.nextAt).toBe(at(2026, 10, 28, 9, 43));
    // Between the cron minute and the shifted run, that run is still to come.
    expect(pendingSchedules([daily], at(2026, 10, 27, 9, 30))[0]!.nextAt).toBe(at(2026, 10, 27, 9, 43));
    expect(pendingSchedules([woke], now)).toEqual([]);
    // A wakeup twenty minutes past its time may be held by a long turn: still pending.
    expect(pendingSchedules([{ ...woke, nextAt: now - 20 * 60_000 }], now)).toHaveLength(1);
    // A recurring cron whose next run would fall at or after its expiry is over.
    expect(pendingSchedules([{ ...daily, expiresAt: at(2026, 10, 27, 9, 43) }], now)).toEqual([]);
    // A job known from a listing alone keeps the run the listing gave, then has no time to tell.
    const listed: Schedule = { id: "l0", kind: "cron", cron: "Every hour at :23", recurring: true, prompt: "Watch", nextAt: now + 41 * 60_000 };
    expect(pendingSchedules([listed], now)[0]!.nextAt).toBe(now + 41 * 60_000);
    expect(pendingSchedules([listed], now + 3_600_000)[0]!.nextAt).toBeUndefined();
  });

  it("gives the board its words", () => {
    expect(scheduleView(daily)).toEqual({ kind: "cron", label: "every day at 09:13", prompt: "daily check", nextAt: at(2026, 10, 27, 9, 43), expiresAt: daily.expiresAt });
    expect(scheduleView({ id: "wakeup", kind: "wakeup", prompt: "look", nextAt: 5 })).toEqual({ kind: "wakeup", label: "wakes once", prompt: "look", nextAt: 5 });
    expect(scheduleView({ id: "o", kind: "cron", cron: "0 15 * * *", recurring: false, prompt: "once", nextAt: 5 }).label).toBe("once, every day at 15:00");
    expect(scheduleView({ id: "l", kind: "cron", cron: "Every hour at :23", recurring: true, prompt: "w" }).label).toBe("Every hour at :23");
    expect(scheduleView({ id: "l", kind: "cron", recurring: true, prompt: "w" }).label).toBe("cron job");
  });
});

describe("the transcript's schedules", () => {
  const line = (entry: unknown) => JSON.stringify(entry);
  const call = (id: string, name: string, input: unknown, t: number) => line({ type: "assistant", timestamp: iso(t), message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string, content: unknown, t: number) => line({ type: "user", timestamp: iso(t), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
  const prompt = (content: string, t: number, scheduled: boolean) => line({ type: "user", timestamp: iso(t), ...(scheduled ? { isMeta: true, promptSource: "system", turnOrigin: "scheduled" } : {}), message: { role: "user", content } });
  const t0 = at(2026, 10, 26, 13, 42);

  it("holds a cron job from its result, drops it on CronDelete, and a wakeup until stopped", () => {
    const state = emptyTranscript();
    applyLine(state, call("c1", "CronCreate", { cron: "13 9 * * *", recurring: true, prompt: "Daily Lookout list check.\nRun the script." }, t0));
    // Until the result names the job, nothing is scheduled yet.
    expect(schedulesOf(state, t0)).toEqual([]);
    applyLine(state, result("c1", "Scheduled recurring job d00604b0 (Every day at 9:13 AM). Next run: Oct 27 9:43am. Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.", t0));
    const now = t0 + 60_000;
    const [job] = schedulesOf(state, now);
    expect(job).toEqual({ kind: "cron", label: "every day at 09:13", prompt: "Daily Lookout list check.", nextAt: at(2026, 10, 27, 9, 43), expiresAt: t0 + CRON_EXPIRY_MS });
    // A wakeup beside it, the sooner of the two first; a second wakeup replaces the first; stop drops it.
    applyLine(state, call("w1", "ScheduleWakeup", { delaySeconds: 1800, prompt: "Check the reviewer", reason: "fallback" }, t0));
    expect(schedulesOf(state, now).map((s) => [s.kind, s.nextAt])).toEqual([
      ["wakeup", t0 + 1800_000],
      ["cron", at(2026, 10, 27, 9, 43)],
    ]);
    applyLine(state, call("w2", "ScheduleWakeup", { delaySeconds: 600, prompt: "Sooner" }, t0));
    expect(schedulesOf(state, now)[0]).toMatchObject({ kind: "wakeup", prompt: "Sooner", nextAt: t0 + 600_000 });
    // The runtime clamps the delay to an hour.
    applyLine(state, call("w2b", "ScheduleWakeup", { delaySeconds: 7200, prompt: "Later" }, t0));
    expect(schedulesOf(state, now)[0]).toMatchObject({ kind: "wakeup", nextAt: t0 + 3600_000 });
    applyLine(state, call("w3", "ScheduleWakeup", { stop: true }, t0));
    expect(schedulesOf(state, now).map((s) => s.kind)).toEqual(["cron"]);
    // A refused CronCreate schedules nothing; CronDelete takes the job away.
    applyLine(state, call("c2", "CronCreate", { cron: "bad", prompt: "x" }, t0));
    applyLine(state, result("c2", "Error: invalid cron expression", t0));
    expect(schedulesOf(state, now)).toHaveLength(1);
    applyLine(state, call("d1", "CronDelete", { id: "d00604b0" }, t0));
    expect(schedulesOf(state, now)).toEqual([]);
  });

  it("takes the scheduler's listing as its word on the jobs", () => {
    const state = emptyTranscript();
    applyLine(state, call("c1", "CronCreate", { cron: "13,43 * * * *", prompt: "Follow up" }, t0));
    applyLine(state, result("c1", "Scheduled recurring job 04d1cc10 (13,43 * * * *). Next run: Oct 26 1:58pm.", t0));
    applyLine(state, call("c2", "CronCreate", { cron: "0 15 26 10 *", recurring: false, prompt: "Once" }, t0));
    applyLine(state, result("c2", "Scheduled one-time job 0a1b2c3d (Oct 26 at 3:00 PM). Next run: Oct 26 3:00pm.", t0));
    expect(schedulesOf(state, t0 + 60_000).map((s) => s.nextAt)).toEqual([at(2026, 10, 26, 13, 58), at(2026, 10, 26, 15, 0)]);
    // The listing leaves the one-time job out (it ran), moves the other's next run, and names one the transcript never showed created.
    const t1 = at(2026, 10, 26, 15, 30);
    applyLine(state, call("l1", "CronList", {}, t1));
    applyLine(state, result("l1", "04d1cc10 — 13,43 * * * * (recurring) [session-only], next run Oct 26 3:58pm: Follow up\n52cb9a8f — Every hour at :23 (recurring) [session-only], next run Oct 26 4:23pm: Stack-rebase watch", t1));
    expect(schedulesOf(state, t1 + 60_000)).toEqual([
      { kind: "cron", label: "at :13, :43 every hour", prompt: "Follow up", nextAt: at(2026, 10, 26, 15, 58), expiresAt: t0 + CRON_EXPIRY_MS },
      { kind: "cron", label: "Every hour at :23", prompt: "Stack-rebase watch", nextAt: at(2026, 10, 26, 16, 23), expiresAt: t1 + CRON_EXPIRY_MS },
    ]);
    // A listing that reads as nothing changes nothing.
    applyLine(state, call("l2", "CronList", {}, t1));
    applyLine(state, result("l2", "Something else entirely", t1));
    expect(schedulesOf(state, t1 + 60_000)).toHaveLength(2);
    // One that says there are none clears them.
    applyLine(state, call("l3", "CronList", {}, t1));
    applyLine(state, result("l3", "No cron jobs scheduled.", t1));
    expect(schedulesOf(state, t1 + 60_000)).toEqual([]);
  });

  it("drops a wakeup or a one-time job when the prompt it gave fires, and a wakeup long past its time", () => {
    const state = emptyTranscript();
    applyLine(state, call("w1", "ScheduleWakeup", { delaySeconds: 1200, prompt: "look again" }, t0));
    applyLine(state, call("c1", "CronCreate", { cron: "0 14 26 10 *", recurring: false, prompt: "Run the smoke.\nReport." }, t0));
    applyLine(state, result("c1", "Scheduled one-time job 0a1b2c3d (Oct 26 at 2:00 PM). Next run: Oct 26 2:00pm.", t0));
    applyLine(state, call("c2", "CronCreate", { cron: "13 9 * * *", prompt: "Daily" }, t0));
    applyLine(state, result("c2", "Scheduled recurring job d00604b0 (Every day at 9:13 AM). Next run: Oct 27 9:43am.", t0));
    expect(schedulesOf(state, t0 + 60_000)).toHaveLength(3);
    // The user's own prompt leaves them all, even one typed past a task's time: a task fires only once the session is idle, and says so.
    applyLine(state, prompt("something else", t0 + 600_000, false));
    expect(schedulesOf(state, t0 + 600_000)).toHaveLength(3);
    // The one-time job fires: its prompt, marked scheduled.
    applyLine(state, prompt("Run the smoke.\nReport.", at(2026, 10, 26, 14, 0), true));
    expect(schedulesOf(state, at(2026, 10, 26, 14, 1)).map((s) => s.kind)).toEqual(["wakeup", "cron"]);
    // The recurring job fires: it runs on.
    applyLine(state, prompt("Daily", at(2026, 10, 27, 9, 43), true));
    expect(schedulesOf(state, at(2026, 10, 27, 9, 44)).map((s) => s.kind)).toEqual(["cron"]);
    // The wakeup fires with a prompt no job gave (a sentinel the runtime resolved): the wakeup is over.
    const again = emptyTranscript();
    applyLine(again, call("w1", "ScheduleWakeup", { delaySeconds: 1200, prompt: "<<autonomous-loop-dynamic>>" }, t0));
    expect(schedulesOf(again, t0 + 60_000)).toEqual([{ kind: "wakeup", label: "wakes once", prompt: "(autonomous loop)", nextAt: t0 + 1200_000 }]);
    applyLine(again, prompt("You are in an autonomous loop. Pick the next task.", t0 + 1200_000, true));
    expect(schedulesOf(again, t0 + 1200_000)).toEqual([]);
    // Long past its time with no prompt seen: gone all the same.
    const late = emptyTranscript();
    applyLine(late, call("w1", "ScheduleWakeup", { delaySeconds: 1200, prompt: "look again" }, t0));
    expect(schedulesOf(late, t0 + 1200_000 + 20 * 60_000)).toHaveLength(1);
    expect(schedulesOf(late, t0 + 1200_000 + 31 * 60_000)).toEqual([]);
  });
});
