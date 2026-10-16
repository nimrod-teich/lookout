// Pure text helpers shared by the extension and the webviews; nothing from Node here.

/**
 * A search, parsed: the words every matching message must contain, and the
 * operators that narrow it. `since:` and `before:` bound the time of the
 * messages; `project:`, `branch:` and `file:` pick sessions, any of their
 * values (`project:api project:web` is either).
 */
export interface Query {
  /** Lowercased. */
  terms: string[];
  /** Epoch ms: messages at or after it. */
  since?: number;
  /** Epoch ms: messages before it. */
  before?: number;
  /** Parts of the project or worktree name, lowercased. */
  projects: string[];
  /** Parts of the git branch, lowercased. */
  branches: string[];
  /** Parts of a path a tool call worked on, lowercased, with forward slashes. */
  files: string[];
}

const OPERATOR = /^(since|before|project|branch|file):(.*)$/is;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const UNITS: Record<string, number> = { h: HOUR, d: DAY, w: 7 * DAY };

/** The tokens of a query: runs of non-space; an operator's value in quotes may hold spaces. */
function tokensOf(query: string): string[] {
  return query.match(/(?:since|before|project|branch|file):"[^"]*"?|\S+/gi) ?? [];
}

/**
 * Midnight starting a calendar day: in this process's time zone, or in the
 * zone `zone` minutes behind UTC (as `Date.getTimezoneOffset` gives it).
 * Undefined for a day that does not exist: "2026-02-31" would roll over.
 */
function midnight(year: number, month: number, day: number, zone: number | undefined): number | undefined {
  if (zone === undefined) {
    const at = new Date(year, month, day);
    return at.getFullYear() === year && at.getMonth() === month && at.getDate() === day ? at.getTime() : undefined;
  }
  const at = new Date(Date.UTC(year, month, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month && at.getUTCDate() === day ? at.getTime() + zone * 60_000 : undefined;
}

/**
 * The time a value names: "today" and "yesterday" from their midnight,
 * "12h", "3d", "2w" back from now, "2026-10-01" from its midnight. Days go
 * by this process's time zone, or by `zone` (minutes behind UTC) when given.
 * Undefined when it names none.
 */
export function timeOf(value: string, now: number, zone?: number): number | undefined {
  const v = value.trim().toLowerCase();
  const relative = /^(\d+)([hdw])$/.exec(v);
  if (relative) return now - Number(relative[1]) * UNITS[relative[2]!]!;
  // The calendar day it is now, where the days are counted.
  const clock = zone === undefined ? new Date(now) : new Date(now - zone * 60_000);
  const [year, month, day] = zone === undefined ? [clock.getFullYear(), clock.getMonth(), clock.getDate()] : [clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate()];
  if (v === "today") return midnight(year, month, day, zone);
  if (v === "yesterday") {
    const before = zone === undefined ? new Date(year, month, day - 1) : new Date(Date.UTC(year, month, day - 1));
    return zone === undefined ? midnight(before.getFullYear(), before.getMonth(), before.getDate(), zone) : midnight(before.getUTCFullYear(), before.getUTCMonth(), before.getUTCDate(), zone);
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return date ? midnight(Number(date[1]), Number(date[2]) - 1, Number(date[3]), zone) : undefined;
}

/** A stretch of time, either end open. */
export interface TimeRange {
  since?: number;
  before?: number;
}

/** A message written at `at` falls within the range; one of unknown time falls within no bounded range. */
export function inRange(at: number | undefined, range: TimeRange | undefined): boolean {
  if (!range || (range.since === undefined && range.before === undefined)) return true;
  if (at === undefined) return false;
  return (range.since === undefined || at >= range.since) && (range.before === undefined || at < range.before);
}

/**
 * Parses a search. An operator whose value names nothing (`since:soon`, or
 * `file:` with nothing after it) stays a plain word, so a search never
 * quietly drops a filter it was given. Days go by `zone` when given (see
 * `timeOf`): the time zone of whoever typed the search.
 */
export function parseQuery(query: string, now: number = Date.now(), zone?: number): Query {
  const parsed: Query = { terms: [], projects: [], branches: [], files: [] };
  for (const token of tokensOf(query)) {
    const operator = OPERATOR.exec(token);
    const key = operator?.[1]?.toLowerCase();
    const value = (operator?.[2] ?? "").replace(/^"|"$/g, "").trim().toLowerCase();
    if (!key || value === "") {
      parsed.terms.push(token.toLowerCase());
      continue;
    }
    if (key === "since" || key === "before") {
      const at = timeOf(value, now, zone);
      if (at === undefined) parsed.terms.push(token.toLowerCase());
      else if (key === "since") parsed.since = Math.max(parsed.since ?? at, at);
      else parsed.before = Math.min(parsed.before ?? at, at);
    } else if (key === "project") parsed.projects.push(value);
    else if (key === "branch") parsed.branches.push(value);
    else parsed.files.push(value.replace(/\\/g, "/"));
  }
  return parsed;
}

/** The query narrows the sessions or the time, not only the words. */
export function hasFilters(query: Query): boolean {
  return query.since !== undefined || query.before !== undefined || query.projects.length > 0 || query.branches.length > 0 || query.files.length > 0;
}

/** The words of a query, lowercased, without its operators. A message matches when it contains every one of them. */
export function termsOf(query: string): string[] {
  return parseQuery(query).terms;
}

/** [start, end) of every term in the text, in order, overlaps merged. */
export function matchRanges(text: string, terms: string[]): [number, number][] {
  const lower = text.toLowerCase();
  const found: [number, number][] = [];
  for (const term of terms) {
    if (term === "") continue;
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) found.push([at, at + term.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const ranges: [number, number][] = [];
  for (const range of found) {
    const last = ranges.at(-1);
    if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([range[0], range[1]]);
  }
  return ranges;
}

/** The text holds every term. */
export function matchesAll(text: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
}
