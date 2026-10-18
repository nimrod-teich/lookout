import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HistoryIndex, snippetOf, type HistoryMessage, type LineFacts } from "../../src/core/history";
import { tempConfigDir } from "./helpers";

/** The test file format: one `{ role, text, at?, paths? }` per line. */
function parse(line: string): LineFacts | undefined {
  try {
    const e = JSON.parse(line) as Partial<HistoryMessage> & { paths?: string[] };
    const message = typeof e.text === "string" && (e.role === "you" || e.role === "agent") ? { role: e.role, at: e.at, text: e.text } : undefined;
    return message || e.paths ? { message, paths: e.paths } : undefined;
  } catch {
    return undefined;
  }
}

function file(messages: unknown[]): string {
  const f = path.join(tempConfigDir(), "h.jsonl");
  fs.writeFileSync(f, messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
  return f;
}


describe("snippetOf", () => {
  it("cuts around the first match, collapses whitespace, and marks every term without overlap", () => {
    const text = `${"x".repeat(100)}\n\nThe Billing   webhook failed, so the billing\tretry ran. ${"y".repeat(100)}`;
    const { snippet, ranges } = snippetOf(text, ["billing", "bill"]);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("The Billing webhook failed, so the billing retry ran.");
    expect(ranges.map(([a, b]) => snippet.slice(a, b))).toEqual(["Billing", "billing"]);
  });

  it("keeps a short message whole", () => {
    expect(snippetOf("Fix the cache", ["cache"])).toEqual({ snippet: "Fix the cache", ranges: [[8, 13]] });
  });
});

describe("HistoryIndex", () => {
  it("finds the messages holding every term, newest first, and counts them all", () => {
    const index = new HistoryIndex(
      file([
        { role: "you", text: "Fix the billing webhook" },
        { role: "agent", text: "Looking at the webhook now" },
        { not: "a message" },
        { role: "agent", at: 5, text: "The Billing webhook retries twice" },
        { role: "you", text: "Thanks" },
      ]),
      parse,
    );
    index.refresh();
    expect(index.messages).toHaveLength(4);
    const { count, hits } = index.search(["billing", "webhook"], 1);
    expect(count).toBe(2);
    expect(hits).toEqual([{ index: 2, role: "agent", at: 5, snippet: "The Billing webhook retries twice", ranges: [[4, 11], [12, 19]] }]);
    expect(index.search([], 3)).toEqual({ count: 0, hits: [] });
  });

  it("reads only what was appended, and starts over when the file shrinks", () => {
    const f = file([{ role: "you", text: "one" }]);
    const index = new HistoryIndex(f, parse);
    index.refresh();
    fs.appendFileSync(f, `${JSON.stringify({ role: "agent", text: "two" })}\n${JSON.stringify({ role: "you", text: "unfinished three" })}`);
    index.refresh();
    expect(index.messages.map((m) => m.text)).toEqual(["one", "two"]);
    fs.appendFileSync(f, "\n");
    index.refresh();
    expect(index.messages.map((m) => m.text)).toEqual(["one", "two", "unfinished three"]);
    fs.writeFileSync(f, `${JSON.stringify({ role: "you", text: "fresh" })}\n`);
    index.refresh();
    expect(index.messages.map((m) => m.text)).toEqual(["fresh"]);
  });

  it("finds matches written within a time, and keeps the paths the tool calls worked on", () => {
    const index = new HistoryIndex(
      file([
        { role: "you", at: 1_000, text: "deploy the api" },
        { paths: ["/work/app/src/Deploy.ts", "C:\\Work\\App\\infra.tf"] },
        { role: "agent", at: 5_000, text: "deploy done" },
        { role: "agent", text: "deploy, no time" },
      ]),
      parse,
    );
    index.refresh();
    expect(index.search(["deploy"], 5).count).toBe(3);
    expect(index.search(["deploy"], 5, { since: 2_000 }).hits.map((h) => h.at)).toEqual([5_000]);
    expect(index.search(["deploy"], 5, { before: 5_000 }).hits.map((h) => h.at)).toEqual([1_000]);
    expect(index.hasMessageIn({ since: 6_000 })).toBe(false);
    expect(index.hasMessageIn({ since: 4_000, before: 6_000 })).toBe(true);
    expect([...index.paths]).toEqual(["/work/app/src/deploy.ts", "c:/work/app/infra.tf"]);
    expect(index.touched(["src/deploy"])).toBe(true);
    expect(index.touched(["app/infra"])).toBe(true);
    expect(index.touched(["readme"])).toBe(false);
  });

  it("forgets the paths of a file that was cut short or replaced", () => {
    const f = file([{ paths: ["/work/app/old.ts"] }, { paths: ["/work/app/older.ts"] }]);
    const index = new HistoryIndex(f, parse);
    index.refresh();
    expect(index.touched(["old.ts"])).toBe(true);
    fs.writeFileSync(f, `${JSON.stringify({ paths: ["/work/app/new.ts"] })}\n`);
    index.refresh();
    expect([...index.paths]).toEqual(["/work/app/new.ts"]);
    // Another file moved into its place, the same size.
    const other = `${f}.next`;
    fs.writeFileSync(other, `${JSON.stringify({ paths: ["/work/app/out.ts"] })}\n`);
    fs.renameSync(other, f);
    index.refresh();
    expect([...index.paths]).toEqual(["/work/app/out.ts"]);
  });

  it("handles a file that is missing or larger than one read chunk", () => {
    const index = new HistoryIndex(path.join(tempConfigDir(), "missing.jsonl"), parse);
    index.refresh();
    expect(index.messages).toEqual([]);
    const big = file(Array.from({ length: 3000 }, (_, i) => ({ role: "agent", text: `line ${i} ${"z".repeat(500)}` })));
    const bigIndex = new HistoryIndex(big, parse);
    bigIndex.refresh();
    expect(bigIndex.messages).toHaveLength(3000);
    expect(bigIndex.search(["line 2999"], 1).hits[0]?.snippet.startsWith("line 2999")).toBe(true);
  });
});
