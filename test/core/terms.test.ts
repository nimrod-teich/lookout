import { describe, expect, it } from "vitest";
import { hasFilters, inRange, parseQuery, termsOf, timeOf } from "../../src/core/terms";

const NOW = new Date(2026, 9, 16, 15, 30).getTime();
const midnight = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

describe("timeOf", () => {
  it("names days, spans back from now, and dates, in local time", () => {
    expect(timeOf("today", NOW)).toBe(midnight(2026, 9, 16));
    expect(timeOf("Yesterday", NOW)).toBe(midnight(2026, 9, 15));
    expect(timeOf("3d", NOW)).toBe(NOW - 3 * 86_400_000);
    expect(timeOf("2w", NOW)).toBe(NOW - 14 * 86_400_000);
    expect(timeOf("12h", NOW)).toBe(NOW - 12 * 3_600_000);
    expect(timeOf("2026-10-01", NOW)).toBe(midnight(2026, 9, 1));
  });

  it("names nothing for anything else, impossible dates included", () => {
    for (const value of ["soon", "3", "d3", "2026-02-31", "2026-13-01", "26-10-01", ""]) expect(timeOf(value, NOW)).toBeUndefined();
    expect(timeOf("2026-02-31", NOW, 0)).toBeUndefined();
  });

  it("counts days in the searcher's time zone when given one, as minutes behind UTC", () => {
    // 01:30 on 17 October in UTC+3 is still 16 October in UTC and in UTC-5.
    const now = Date.UTC(2026, 9, 16, 22, 30);
    expect(timeOf("today", now, -180)).toBe(Date.UTC(2026, 9, 16, 21, 0));
    expect(timeOf("yesterday", now, -180)).toBe(Date.UTC(2026, 9, 15, 21, 0));
    expect(timeOf("today", now, 0)).toBe(Date.UTC(2026, 9, 16));
    expect(timeOf("today", now, 300)).toBe(Date.UTC(2026, 9, 16, 5, 0));
    expect(timeOf("2026-10-01", now, -180)).toBe(Date.UTC(2026, 8, 30, 21, 0));
    // Across a month's end, and spans that do not care about zones.
    expect(timeOf("yesterday", Date.UTC(2026, 10, 1, 12), 0)).toBe(Date.UTC(2026, 9, 31));
    expect(timeOf("3d", now, -180)).toBe(now - 3 * 86_400_000);
  });
});

describe("inRange", () => {
  it("bounds a time, either end open, and a time unknown falls in no bounded range", () => {
    expect(inRange(5, { since: 5, before: 6 })).toBe(true);
    expect(inRange(6, { since: 5, before: 6 })).toBe(false);
    expect(inRange(4, { since: 5 })).toBe(false);
    expect(inRange(undefined, {})).toBe(true);
    expect(inRange(undefined, { before: 6 })).toBe(false);
    expect(inRange(1, undefined)).toBe(true);
  });
});

describe("parseQuery", () => {
  it("takes the operators out of the words", () => {
    expect(parseQuery("Billing webhook since:3d project:API branch:fix-login file:src/app.ts", NOW)).toEqual({
      terms: ["billing", "webhook"],
      since: NOW - 3 * 86_400_000,
      projects: ["api"],
      branches: ["fix-login"],
      files: ["src/app.ts"],
    });
  });

  it("keeps the narrowest times, any of several projects, and a quoted value whole", () => {
    const query = parseQuery('since:2026-10-01 since:yesterday before:today before:2026-10-20 project:api project:web file:"src/my file.ts" file:C:\\Work\\App.ts', NOW);
    expect(query).toMatchObject({ since: midnight(2026, 9, 15), before: midnight(2026, 9, 16), projects: ["api", "web"], files: ["src/my file.ts", "c:/work/app.ts"], terms: [] });
    expect(hasFilters(query)).toBe(true);
  });

  it("groups quotes only for operators: a word with a colon stays words", () => {
    expect(parseQuery('error:"connection refused" timeout', NOW).terms).toEqual(['error:"connection', 'refused"', "timeout"]);
    expect(parseQuery('note:"remember this', NOW).terms).toEqual(['note:"remember', "this"]);
    expect(parseQuery('project:"my app" deploy', NOW)).toMatchObject({ projects: ["my app"], terms: ["deploy"] });
    expect(parseQuery("see https://example.com TODO:later", NOW).terms).toEqual(["see", "https://example.com", "todo:later"]);
  });

  it("days go by the time zone given", () => {
    const now = Date.UTC(2026, 9, 16, 22, 30);
    expect(parseQuery("since:today", now, -180).since).toBe(Date.UTC(2026, 9, 16, 21, 0));
  });

  it("leaves an operator that names nothing among the words, so no filter is dropped quietly", () => {
    expect(parseQuery("since:soon file: deploy", NOW)).toEqual({ terms: ["since:soon", "file:", "deploy"], projects: [], branches: [], files: [] });
    expect(hasFilters(parseQuery("deploy", NOW))).toBe(false);
  });
});

describe("termsOf", () => {
  it("lowercases the words, drops the blanks, and leaves out the operators", () => {
    expect(termsOf("  Billing  Webhook ")).toEqual(["billing", "webhook"]);
    expect(termsOf("   ")).toEqual([]);
    expect(termsOf("webhook since:3d branch:main")).toEqual(["webhook"]);
  });
});

describe("has:note", () => {
  it("asks for the sessions with a note, counts as a filter, and leaves any other has: a plain word", () => {
    expect(parseQuery("has:note retag", NOW)).toEqual({ terms: ["retag"], projects: [], branches: [], files: [], hasNote: true });
    expect(parseQuery("HAS:Note", NOW)).toMatchObject({ terms: [], hasNote: true });
    expect(hasFilters(parseQuery("has:note", NOW))).toBe(true);
    expect(parseQuery("has:star", NOW)).toEqual({ terms: ["has:star"], projects: [], branches: [], files: [] });
    expect(hasFilters(parseQuery("has:star", NOW))).toBe(false);
    expect(termsOf("has:note cache")).toEqual(["cache"]);
  });
});
