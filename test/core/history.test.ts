import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HistoryIndex, HistoryIndexes, PAGE_SNIPPET, readerOf, scanFile, snippetOf, type HistoryMessage, type LineFacts, type LineReader } from "../../src/core/history";
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

/** Reads every line of the test format. */
const READER: LineReader = { mayHold: () => true, facts: parse };

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

  it("cuts wider for the search page", () => {
    const text = `${"a ".repeat(200)}the billing webhook${" b".repeat(400)}`;
    const card = snippetOf(text, ["billing"]).snippet;
    const page = snippetOf(text, ["billing"], PAGE_SNIPPET).snippet;
    expect(card.length).toBeLessThan(130);
    expect(page.length).toBeGreaterThan(400);
    expect(page.indexOf("billing")).toBeGreaterThan(100);
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
      READER,
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
    const index = new HistoryIndex(f, READER);
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
      READER,
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
    const index = new HistoryIndex(f, READER);
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
    const index = new HistoryIndex(path.join(tempConfigDir(), "missing.jsonl"), READER);
    index.refresh();
    expect(index.messages).toEqual([]);
    const big = file(Array.from({ length: 3000 }, (_, i) => ({ role: "agent", text: `line ${i} ${"z".repeat(500)}` })));
    const bigIndex = new HistoryIndex(big, READER);
    bigIndex.refresh();
    expect(bigIndex.messages).toHaveLength(3000);
    expect(bigIndex.search(["line 2999"], 1).hits[0]?.snippet.startsWith("line 2999")).toBe(true);
    // One line longer than two chunks, between short ones.
    const long = file([{ role: "you", text: "before" }, { role: "agent", text: `long ${"w".repeat(2_500_000)} end` }, { role: "you", text: "after" }]);
    const longIndex = new HistoryIndex(long, READER);
    longIndex.refresh();
    expect(longIndex.messages.map((m) => m.text.length)).toEqual([6, 2_500_009, 5]);
    expect(longIndex.search(["end"], 1).count).toBe(1);
  });

  it("never decodes a line its reader rules out", () => {
    const decoded: string[] = [];
    const reader: LineReader = {
      mayHold: (line) => !line.includes("noise"),
      facts: (line) => {
        decoded.push(line);
        return parse(line);
      },
    };
    const index = new HistoryIndex(
      file([
        { role: "you", text: "Fix the cache" },
        { role: "agent", text: "noise: a request record the size of a book" },
        { role: "agent", text: "Done" },
      ]),
      reader,
    );
    index.refresh();
    expect(index.messages.map((m) => m.text)).toEqual(["Fix the cache", "Done"]);
    expect(decoded).toHaveLength(2);
    expect(decoded.some((line) => line.includes("noise"))).toBe(false);
  });

  it("skips a line its reader cannot take, and reads on", () => {
    const reader: LineReader = {
      mayHold: () => true,
      facts: (line) => {
        if (line.includes("broken")) throw new TypeError("cannot read properties of null");
        return parse(line);
      },
    };
    const index = new HistoryIndex(file([{ role: "you", text: "one" }, { role: "agent", text: "broken" }, { role: "you", text: "three" }]), reader);
    index.refresh();
    expect(index.messages.map((m) => m.text)).toEqual(["one", "three"]);
  });

  it("matches without regard to case, also after its messages are replaced", () => {
    class Replaced extends HistoryIndex {
      take(messages: HistoryMessage[]): void {
        this.replaceMessages(messages);
      }
    }
    const index = new Replaced(path.join(tempConfigDir(), "none.jsonl"), READER);
    index.take([{ role: "you", text: "Fix the BILLING webhook" }]);
    expect(index.search(["billing"], 3).count).toBe(1);
    index.take([{ role: "agent", text: "Something else" }]);
    expect(index.search(["billing"], 3).count).toBe(0);
    expect(index.search(["else"], 3).hits.map((hit) => hit.snippet)).toEqual(["Something else"]);
  });
});

describe("readerOf", () => {
  it("lets through the lines with any of its needles", () => {
    const reader = readerOf("test", ['"type":"message"', '"FileChange"'], () => undefined);
    expect(reader.mayHold(Buffer.from('{"type":"message","text":"hi"}'))).toBe(true);
    expect(reader.mayHold(Buffer.from('{"item":"FileChange"}'))).toBe(true);
    expect(reader.mayHold(Buffer.from('{"type":"token_count"}'))).toBe(false);
  });
});

describe("HistoryIndexes", () => {
  it("keeps one index per file until the file is no longer wanted", () => {
    const indexes = new HistoryIndexes(READER);
    const a = file([{ role: "you", text: "one" }]);
    const first = indexes.of(a);
    first.refresh();
    // The same file, whoever asks: a session that ends or resumes keeps what was read of it.
    expect(indexes.of(a)).toBe(first);
    indexes.keepOnly([a]);
    expect(indexes.of(a)).toBe(first);
    indexes.keepOnly([]);
    const again = indexes.of(a);
    expect(again).not.toBe(first);
    expect(again.ready).toBe(false);
  });
});

describe("scanFile", () => {
  it("reads from where the last read stopped, and from the start when the file was replaced or cut short", () => {
    const f = file([{ role: "you", text: "one" }]);
    const first = scanFile(f, READER, 0, "")!;
    expect(first).toMatchObject({ reset: true, end: fs.statSync(f).size });
    expect(first.facts.map((facts) => facts.message?.text)).toEqual(["one"]);
    fs.appendFileSync(f, `${JSON.stringify({ role: "agent", text: "two" })}\n${JSON.stringify({ role: "you", text: "unfinished" })}`);
    const next = scanFile(f, READER, first.end, first.identity)!;
    expect(next.reset).toBe(false);
    expect(next.facts.map((facts) => facts.message?.text)).toEqual(["two"]);
    // The unfinished line is read again next time, once it ends.
    expect(next.end).toBeLessThan(next.size);
    // Nothing new.
    expect(scanFile(f, READER, next.end, next.identity)?.facts).toEqual([]);
    fs.writeFileSync(f, `${JSON.stringify({ role: "you", text: "short" })}\n`);
    const cut = scanFile(f, READER, next.end, next.identity)!;
    expect(cut.reset).toBe(true);
    expect(cut.facts.map((facts) => facts.message?.text)).toEqual(["short"]);
    expect(scanFile(path.join(tempConfigDir(), "missing.jsonl"), READER, 0, "")).toBeUndefined();
  });
});

describe("HistoryIndex.apply", () => {
  it("takes in a read only from where the index stands", () => {
    const f = file([{ role: "you", text: "one" }, { role: "agent", text: "two" }]);
    const index = new HistoryIndex(f, { ...READER, name: "test" });
    const job = index.scan()!;
    expect(job).toMatchObject({ file: f, reader: "test", from: 0, identity: "" });
    const scanned = scanFile(f, READER, job.from, job.identity)!;
    index.apply(scanned, job);
    expect(index.messages.map((m) => m.text)).toEqual(["one", "two"]);
    // The same read again comes from where the index no longer is.
    index.apply(scanned, job);
    expect(index.messages).toHaveLength(2);
    expect(new HistoryIndex(f, READER).scan()).toBeUndefined();
  });
});
