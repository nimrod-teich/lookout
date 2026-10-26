// The tasks a Claude Code session scheduled for itself: a wakeup
// (`ScheduleWakeup`, once, after a delay) or a cron job (`CronCreate`, at
// the times its expression names, for a week at most), both of them
// session-only: Claude Code keeps them in memory and writes them nowhere
// but the transcript, as the tool calls that made them, the results that
// named them, and the prompts they enqueue when they fire. Read from
// there, they tell the board which session is waiting on its own clock.
import type { ScheduleView } from "../../types";

/** A task a session scheduled, as the transcript records it. */
export interface Schedule {
  /** The job's id as Claude Code named it, for a cron; `wakeup` for the one wakeup a session can hold. */
  id: string;
  kind: "cron" | "wakeup";
  /** The cron expression, five fields, in the machine's local time; or, from a listing, the scheduler's own words for it. */
  cron?: string;
  /** A cron that runs again after each run; else once. */
  recurring?: boolean;
  /** What the session will do, cut to a line. */
  prompt: string;
  /** The prompt whole, to know the task by when it fires. */
  fullPrompt?: string;
  /** Epoch ms it was scheduled. */
  at?: number;
  /** Epoch ms of the next run, when it can be told. */
  nextAt?: number;
  /** Ms the scheduler runs a cron job past its minute: fixed per job, read from the first run it announced. */
  shiftMs?: number;
  /** Epoch ms it expires: a cron job lives a week. */
  expiresAt?: number;
}

/** Claude Code lets a session-scoped cron job live this long. */
export const CRON_EXPIRY_MS = 7 * 24 * 3_600_000;
/** The scheduler runs a cron job at most this long past its minute. */
const CRON_SHIFT_MAX_MS = 30 * 60_000;
/** A wakeup fires once the session is idle, so a long turn holds it past its time; this long past, it is taken as gone. */
const WAKEUP_SLACK_MS = 30 * 60_000;
/** The furthest a cron job's next run is looked for. */
const CRON_HORIZON_DAYS = 400;
const PROMPT_MAX = 160;

/** A cron expression, parsed: the values each field allows. */
export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** The day fields were both left open, or restricted; standard cron runs on a day either names when both are restricted. */
  anyDay: boolean;
  anyWeekday: boolean;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function fieldValue(token: string, field: number): number | undefined {
  const lower = token.toLowerCase();
  if (field === 3 && MONTH_NAMES.includes(lower)) return MONTH_NAMES.indexOf(lower) + 1;
  if (field === 4 && DAY_NAMES.includes(lower)) return DAY_NAMES.indexOf(lower);
  return /^\d+$/.test(token) ? Number(token) : undefined;
}

/** The values one cron field allows, or nothing for a field that cannot be read. */
function parseField(text: string, field: number): Set<number> | undefined {
  const [lo, hi] = RANGES[field]!;
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let from: number;
    let to: number;
    if (range === "*" || range === "?") {
      from = lo;
      to = hi;
    } else if (range!.includes("-")) {
      const [a, b] = range!.split("-");
      const fa = fieldValue(a!, field);
      const fb = fieldValue(b!, field);
      if (fa === undefined || fb === undefined) return undefined;
      from = fa;
      to = fb;
    } else {
      const value = fieldValue(range!, field);
      if (value === undefined) return undefined;
      from = value;
      to = stepText === undefined ? value : hi;
    }
    if (from < lo || to > hi || from > to) return undefined;
    for (let v = from; v <= to; v += step) out.add(field === 4 && v === 7 ? 0 : v);
  }
  return out;
}

/** The expression parsed, or nothing for one that is not five fields of cron. */
export function parseCron(expr: string): CronSpec | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const sets = fields.map((text, field) => parseField(text, field));
  if (sets.some((set) => set === undefined)) return undefined;
  const [minutes, hours, days, months, weekdays] = sets as Set<number>[];
  return { minutes: minutes!, hours: hours!, days: days!, months: months!, weekdays: weekdays!, anyDay: fields[2] === "*", anyWeekday: fields[4] === "*" };
}

/** The first run after `from`, in local time, within a year; nothing when the expression never runs. */
export function nextCronRun(spec: CronSpec, from: number): number | undefined {
  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const dayFits = (d: Date) => {
    const byDay = spec.days.has(d.getDate());
    const byWeekday = spec.weekdays.has(d.getDay());
    if (spec.anyDay && spec.anyWeekday) return true;
    if (spec.anyDay) return byWeekday;
    if (spec.anyWeekday) return byDay;
    return byDay || byWeekday;
  };
  const day = new Date(start);
  for (let n = 0; n < CRON_HORIZON_DAYS; n++) {
    if (spec.months.has(day.getMonth() + 1) && dayFits(day)) {
      const first = n === 0;
      for (const hour of [...spec.hours].sort((a, b) => a - b)) {
        if (first && hour < start.getHours()) continue;
        for (const minute of [...spec.minutes].sort((a, b) => a - b)) {
          if (first && hour === start.getHours() && minute < start.getMinutes()) continue;
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
          // A time a clock change skipped lands on another hour: passed over.
          if (at.getHours() !== hour || at.getMinutes() !== minute) continue;
          return at.getTime();
        }
      }
    }
    day.setDate(day.getDate() + 1);
    day.setHours(0, 0, 0, 0);
  }
  return undefined;
}

/** The first run of a job after `from`, as the scheduler runs it: the first minute the expression names that, shifted, is still to come. */
function nextRunShifted(spec: CronSpec, from: number, shiftMs: number): number | undefined {
  const minute = nextCronRun(spec, from - shiftMs);
  return minute === undefined ? undefined : minute + shiftMs;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** The expression in words for the common shapes, else as it is; the scheduler's own words pass through. */
export function describeCron(expr: string): string {
  const spec = parseCron(expr);
  const fields = expr.trim().split(/\s+/);
  if (!spec || fields.length !== 5) return expr.trim();
  const [m, h] = fields;
  const minutes = [...spec.minutes].sort((a, b) => a - b);
  const hours = [...spec.hours].sort((a, b) => a - b);
  const time = (hour: number, minute: number) => `${two(hour)}:${two(minute)}`;
  const daily = spec.anyDay && spec.months.size === 12 && spec.anyWeekday;
  if (daily && /^\*\/\d+$/.test(m!) && h === "*") return `every ${m!.slice(2)} minutes`;
  if (daily && h === "*" && minutes.length <= 4) return `at ${minutes.map((minute) => `:${two(minute)}`).join(", ")} every hour`;
  if (daily && hours.length === 1 && minutes.length === 1) return `every day at ${time(hours[0]!, minutes[0]!)}`;
  if (daily && hours.length * minutes.length <= 4) return `every day at ${hours.flatMap((hour) => minutes.map((minute) => time(hour, minute))).join(", ")}`;
  if (spec.anyDay && spec.months.size === 12 && !spec.anyWeekday && hours.length === 1 && minutes.length === 1) {
    const names = [...spec.weekdays].sort((a, b) => a - b).map((d) => DAY_NAMES[d]!.replace(/^./, (c) => c.toUpperCase()));
    const when = names.length === 5 && !spec.weekdays.has(0) && !spec.weekdays.has(6) ? "weekdays" : names.join(", ");
    return `${when} at ${time(hours[0]!, minutes[0]!)}`;
  }
  return `cron ${expr.trim()}`;
}

/** A job as a CronCreate result or a CronList line names it. */
export interface CronLine {
  id: string;
  recurring: boolean;
  /** The expression, or the scheduler's words for it. */
  desc?: string;
  /** The next run the scheduler announced, in local time, when it did. */
  nextAt?: number;
  /** The prompt, when the line carries it. */
  prompt?: string;
}

const WHEN = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2}),? (\d{1,2}):(\d{2})\s*(am|pm)?/i;

/** "Oct 27 9:43am" as the scheduler writes a run: that local time in the year that puts it nearest `from`. Nothing for other words. */
export function parseWhen(text: string, from: number): number | undefined {
  const match = WHEN.exec(text);
  if (!match) return undefined;
  const month = MONTH_NAMES.indexOf(match[1]!.toLowerCase());
  const day = Number(match[2]);
  let hour = Number(match[3]);
  const minute = Number(match[4]);
  const half = match[5]?.toLowerCase();
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || day < 1 || day > 31) return undefined;
  const year = new Date(from).getFullYear();
  const candidates = [year - 1, year, year + 1].map((y) => new Date(y, month, day, hour, minute).getTime());
  return candidates.sort((a, b) => Math.abs(a - from) - Math.abs(b - from))[0];
}

/**
 * What Claude Code answered a CronCreate with: "Scheduled recurring job
 * d00604b0 (Every day at 9:13 AM). Next run: Oct 27 9:43am. …", or in an
 * earlier release "d00604b0 — 13,43 * * * * (recurring) [session-only],
 * next run Oct 15 11:43am: <prompt>". Nothing for a refusal.
 */
export function cronResultOf(text: string, from: number): CronLine | undefined {
  const first = text.trim().split("\n")[0] ?? "";
  const created = /^Scheduled (recurring |one-time |)job ([0-9a-f]{6,})(?: \((.*?)\))?\.?(.*)$/i.exec(first);
  if (created) {
    const rest = created[4] ?? "";
    const next = /next run:?\s*([^.]*)/i.exec(rest);
    const line: CronLine = { id: created[2]!, recurring: !/one-time/i.test(created[1]!) };
    if (created[3]) line.desc = created[3];
    const nextAt = next ? parseWhen(next[1]!, from) : undefined;
    if (nextAt !== undefined) line.nextAt = nextAt;
    return line;
  }
  return cronListOf(text, from)[0];
}

/** The jobs a CronList result lists, one per line: "<id> — <desc> (recurring) [session-only], next run Oct 15 11:43am: <prompt>". */
export function cronListOf(text: string, from: number): CronLine[] {
  const out: CronLine[] = [];
  for (const raw of text.split("\n")) {
    const match = /^\s*([0-9a-f]{6,}) [—-] (.*?) \((recurring|one-time|once)\)(.*)$/i.exec(raw);
    if (!match) continue;
    const line: CronLine = { id: match[1]!, recurring: match[3]!.toLowerCase() === "recurring", desc: match[2] };
    const rest = match[4] ?? "";
    const next = /next run:?\s*([^:]*(?::\d{2}\s*(?:am|pm)?)?)/i.exec(rest);
    const nextAt = next ? parseWhen(next[1]!, from) : undefined;
    if (nextAt !== undefined) line.nextAt = nextAt;
    const prompt = /(?:\]|\)|m|\d{2}):\s+(.+)$/.exec(rest);
    if (prompt) line.prompt = prompt[1]!.trim();
    out.push(line);
  }
  return out;
}

/** A prompt as the card's hover shows it: its first line, cut; the loop's sentinel in words. */
export function promptLine(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (/^<<autonomous-loop(-dynamic)?>>$/.test(line)) return "(autonomous loop)";
  return line.length > PROMPT_MAX ? `${line.slice(0, PROMPT_MAX - 1)}…` : line;
}

/** A fired prompt is the task's when it starts with the prompt the task was given. */
export function firedBy(schedule: Schedule, content: string): boolean {
  const own = schedule.fullPrompt?.trim();
  if (!own) return false;
  return content.trim().startsWith(own.slice(0, 200));
}

/**
 * The schedules still to come at `now`: a recurring cron with its next run
 * from now, one that ran its once or expired gone, and a wakeup gone once
 * its time is long past (it fires once the session is idle, so a long
 * turn holds it a while).
 */
export function pendingSchedules(schedules: Iterable<Schedule>, now: number): Schedule[] {
  const out: Schedule[] = [];
  for (const schedule of schedules) {
    if (schedule.expiresAt !== undefined && schedule.expiresAt <= now) continue;
    if (schedule.kind === "wakeup") {
      if (schedule.nextAt === undefined || schedule.nextAt + WAKEUP_SLACK_MS > now) out.push(schedule);
      continue;
    }
    if (!schedule.recurring) {
      if (schedule.nextAt !== undefined && schedule.nextAt > now) out.push(schedule);
      continue;
    }
    const spec = schedule.cron ? parseCron(schedule.cron) : undefined;
    // A job whose expression is not known (listed, never created in view) keeps the run the listing gave, until that passes.
    const nextAt = spec ? nextRunShifted(spec, now, schedule.shiftMs ?? 0) : schedule.nextAt !== undefined && schedule.nextAt > now ? schedule.nextAt : undefined;
    const next: Schedule = { ...schedule };
    if (nextAt === undefined) delete next.nextAt;
    else next.nextAt = nextAt;
    if (spec && nextAt === undefined) continue;
    if (nextAt !== undefined && schedule.expiresAt !== undefined && nextAt >= schedule.expiresAt) continue;
    out.push(next);
  }
  return out.sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
}

/** A cron job as created: its first run as the scheduler announced it when it did, and the shift that run shows. */
export function cronSchedule(line: CronLine, cron: string | undefined, prompt: string | undefined, at: number): Schedule {
  const expr = cron ?? line.desc ?? "";
  const spec = parseCron(expr);
  const schedule: Schedule = { id: line.id, kind: "cron", cron: expr, recurring: line.recurring, prompt: promptLine(prompt ?? line.prompt), at, expiresAt: at + CRON_EXPIRY_MS };
  if (prompt ?? line.prompt) schedule.fullPrompt = prompt ?? line.prompt;
  const minute = spec ? nextCronRun(spec, at) : undefined;
  if (line.nextAt !== undefined) {
    schedule.nextAt = line.nextAt;
    if (minute !== undefined && line.recurring) {
      const shift = line.nextAt - minute;
      if (shift >= 0 && shift <= CRON_SHIFT_MAX_MS) schedule.shiftMs = shift;
    }
  } else if (minute !== undefined) schedule.nextAt = minute;
  return schedule;
}

/** A schedule as the board shows it: with its words. */
export function scheduleView(schedule: Schedule): ScheduleView {
  const words = describeCron(schedule.cron ?? "") || "cron job";
  const view: ScheduleView = { kind: schedule.kind, prompt: schedule.prompt, label: schedule.kind === "wakeup" ? "wakes once" : schedule.recurring ? words : `once, ${words}` };
  if (schedule.nextAt !== undefined) view.nextAt = schedule.nextAt;
  if (schedule.expiresAt !== undefined) view.expiresAt = schedule.expiresAt;
  return view;
}
