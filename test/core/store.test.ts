import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_LINES } from "../../src/core/agents/claude/history";
import { runScan } from "../../src/core/agents/lineReaders";
import { scanFile } from "../../src/core/history";
import { loadSqlite } from "../../src/core/sqlite";
import { ConversationStore, ftsQuery } from "../../src/core/store";
import { parseQuery } from "../../src/core/terms";
import { appendEntries, tempConfigDir } from "./helpers";

const sqlite = loadSqlite() !== undefined;
const BUILD = "build-1";

/** A transcript as Claude Code writes one: messages with times, a tool call naming a path, a tool result. */
function transcript(name = "t.jsonl", day = 0): string {
  const file = path.join(tempConfigDir(), name);
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1 + day, 10, i)).toISOString();
  appendEntries(file, [
    { type: "user", timestamp: at(0), message: { content: "Fix the billing webhook for Stripe" } },
    { type: "assistant", timestamp: at(1), message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/api/Billing.ts" } }] } },
    { type: "user", timestamp: at(2), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(2000) }] } },
    { type: "assistant", timestamp: at(3), message: { content: [{ type: "text", text: "The billing webhook retries twice; retagging the invoice is separate." }] } },
    { type: "user", timestamp: at(4), message: { content: "And the retag recipe?" } },
  ]);
  return file;
}

function openStore(): ConversationStore {
  const store = ConversationStore.open(path.join(tempConfigDir(), "history.sqlite"));
  if (!store) throw new Error("no store");
  return store;
}

/** Reads a file whole into the store, as the reading thread does. */
function readInto(store: ConversationStore, file: string): void {
  const scanned = scanFile(file, TRANSCRIPT_LINES, 0, "")!;
  store.record({ file, reader: TRANSCRIPT_LINES.name! }, scanned, BUILD);
}

describe("ftsQuery", () => {
  it("asks for every term at a word's start, a phrase whole, quotes doubled", () => {
    expect(ftsQuery(["retag", "recipe"])).toBe('"retag"* "recipe"*');
    expect(ftsQuery(["retag recipe"])).toBe('"retag recipe"*');
    expect(ftsQuery(['say "hi"', ""])).toBe('"say ""hi"""*');
    expect(ftsQuery([])).toBe("");
  });
});

describe.skipIf(!sqlite)("ConversationStore", () => {
  it("opens once per file, makes its tables, and is nothing where the file cannot be opened", () => {
    const dir = tempConfigDir();
    const store = ConversationStore.open(path.join(dir, "deeper", "history.sqlite"));
    expect(store).toBeDefined();
    expect(store!.size()).toEqual({ files: 0, messages: 0 });
    store!.close();
    fs.writeFileSync(path.join(dir, "a-file"), "x");
    expect(ConversationStore.open(path.join(dir, "a-file", "history.sqlite"))).toBeUndefined();
  });

  it("keeps a conversation's messages and paths, in order, with how far the file was read", () => {
    const store = openStore();
    const file = transcript();
    expect(store.has(file)).toBe(false);
    expect(store.messages(file)).toBeUndefined();
    readInto(store, file);
    expect(store.has(file)).toBe(true);
    expect(store.messages(file)!.map((m) => [m.role, m.text])).toEqual([
      ["you", "Fix the billing webhook for Stripe"],
      ["agent", "The billing webhook retries twice; retagging the invoice is separate."],
      ["you", "And the retag recipe?"],
    ]);
    expect(store.messages(file)![0]!.at).toBe(Date.UTC(2026, 9, 1, 10, 0));
    const progress = store.progress(file)!;
    expect(progress).toMatchObject({ messages: 3, build: BUILD, end: fs.statSync(file).size });
    expect(progress.tail).toBeTypeOf("string");
    expect(store.touched([file], ["billing.ts"])).toEqual(new Set([file]));
    expect(store.touched([file], ["other"])).toEqual(new Set());
    expect(store.size()).toEqual({ files: 1, messages: 3 });
    store.close();
  });

  it("takes in what a file gained after the store stopped, and starts over when it was replaced or read by another build", () => {
    const store = openStore();
    const file = transcript();
    readInto(store, file);
    const held = store.progress(file)!;
    appendEntries(file, [{ type: "assistant", message: { content: [{ type: "text", text: "Here it is." }] } }]);
    const more = scanFile(file, TRANSCRIPT_LINES, held.end, held.identity)!;
    expect(more.reset).toBe(false);
    store.record({ file, reader: TRANSCRIPT_LINES.name! }, more, BUILD);
    expect(store.messages(file)!.map((m) => m.text).at(-1)).toBe("Here it is.");
    expect(store.progress(file)!.messages).toBe(4);
    // Another build read it: its rows replace the old ones.
    store.record({ file, reader: TRANSCRIPT_LINES.name! }, scanFile(file, TRANSCRIPT_LINES, 0, "")!, "build-2");
    expect(store.progress(file)).toMatchObject({ messages: 4, build: "build-2" });
    expect(store.messages(file)).toHaveLength(4);
    // Replaced: read anew.
    fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: "Fresh start" } }) + "\n");
    const fresh = scanFile(file, TRANSCRIPT_LINES, held.end, held.identity)!;
    expect(fresh.reset).toBe(true);
    store.record({ file, reader: TRANSCRIPT_LINES.name! }, fresh, "build-2");
    expect(store.messages(file)!.map((m) => m.text)).toEqual(["Fresh start"]);
    expect(store.touched([file], ["billing"])).toEqual(new Set());
    store.close();
  });

  it("finds the messages holding every term at a word's start, newest first per file, counted whole and cut to the limit", () => {
    const store = openStore();
    const a = transcript("a.jsonl");
    const b = transcript("b.jsonl", 10);
    readInto(store, a);
    readInto(store, b);
    const found = store.search([a, b], ["retag"], 1);
    expect([...found.keys()].sort()).toEqual([a, b].sort());
    expect(found.get(a)).toMatchObject({ count: 2 });
    expect(found.get(a)!.hits).toHaveLength(1);
    // The newest match: the question, index 2, with the term marked.
    expect(found.get(a)!.hits[0]).toMatchObject({ index: 2, role: "you", snippet: "And the retag recipe?", ranges: [[8, 13]] });
    // Every term must appear in one message; a phrase holds its words in a row.
    expect(store.search([a], ["billing", "stripe"], 3).get(a)).toMatchObject({ count: 1, hits: [{ index: 0 }] });
    expect(store.search([a], ["retag recipe"], 3).get(a)).toMatchObject({ count: 1, hits: [{ index: 2 }] });
    expect(store.search([a], ["recipe retag"], 3).size).toBe(0);
    // A word's start, not any part of it, and without regard to case.
    expect(store.search([a], ["etag"], 3).size).toBe(0);
    expect(store.search([a], ["RETAG"], 3).get(a)!.count).toBe(2);
    // Only the files asked for.
    expect(store.search([b], ["retag"], 3).has(a)).toBe(false);
    expect(store.search([], ["retag"], 3).size).toBe(0);
    expect(store.search([a], [], 3).size).toBe(0);
    store.close();
  });

  it("bounds matches and files by time, as the in-memory index does", () => {
    const store = openStore();
    const a = transcript("a.jsonl");
    const b = transcript("b.jsonl", 10);
    readInto(store, a);
    readInto(store, b);
    const cut = Date.UTC(2026, 9, 5);
    expect([...store.search([a, b], ["retag"], 3, { since: cut }).keys()]).toEqual([b]);
    expect([...store.search([a, b], ["retag"], 3, { before: cut }).keys()]).toEqual([a]);
    expect(store.withMessagesIn([a, b], { since: cut })).toEqual(new Set([b]));
    expect(store.withMessagesIn([a, b], { before: cut })).toEqual(new Set([a]));
    expect(store.withMessagesIn([a, b], {})).toEqual(new Set([a, b]));
    // A message of unknown time falls within no bounded range.
    const c = path.join(tempConfigDir(), "c.jsonl");
    appendEntries(c, [{ type: "user", message: { content: "undated retag" } }]);
    readInto(store, c);
    expect(store.search([c], ["retag"], 3, { since: 0 }).size).toBe(0);
    expect(store.search([c], ["retag"], 3).get(c)!.count).toBe(1);
    store.close();
  });

  it("remembers the sessions, marks one purged when its transcript goes, and forgets it with its conversation on request", () => {
    const store = openStore();
    const a = transcript("a.jsonl");
    const b = transcript("b.jsonl");
    readInto(store, a);
    readInto(store, b);
    store.rememberSession({ id: "s-a", agent: "claude-code", file: a, title: "Billing", cwd: "/work/api", branch: "main", modifiedAt: 1000 });
    store.rememberSession({ id: "s-b", agent: "claude-code", file: b, title: "Other", cwd: "/work/web" });
    store.rememberSession({ id: "s-c", agent: "codex", file: path.join(tempConfigDir(), "never-read.jsonl"), title: "Unread", cwd: "/w" });
    expect(store.session("s-a")).toEqual({ id: "s-a", agent: "claude-code", file: a, title: "Billing", cwd: "/work/api", branch: "main", modifiedAt: 1000 });
    expect(store.sweep(5000, true)).toEqual({ purged: [], returned: [], forgotten: ["s-c"] });
    fs.unlinkSync(a);
    expect(store.sweep(6000, true)).toEqual({ purged: ["s-a"], returned: [], forgotten: [] });
    expect(store.purged().map((s) => [s.id, s.purgedAt])).toEqual([["s-a", 6000]]);
    // Its conversation is still there to read and search.
    expect(store.messages(a)).toHaveLength(3);
    expect(store.search([a], ["retag"], 3).get(a)!.count).toBe(2);
    // Seen again, as when a transcript is restored: no longer purged.
    fs.writeFileSync(a, "");
    expect(store.sweep(7000, true)).toEqual({ purged: [], returned: ["s-a"], forgotten: [] });
    expect(store.purged()).toEqual([]);
    fs.unlinkSync(a);
    store.sweep(8000, true);
    // A title that changed is written down, and the purge mark cleared with it.
    store.rememberSession({ id: "s-a", agent: "claude-code", file: a, title: "Billing, again", cwd: "/work/api", branch: "main", modifiedAt: 1000 });
    expect(store.session("s-a")).toMatchObject({ title: "Billing, again" });
    expect(store.purged()).toEqual([]);
    store.sweep(9000, true);
    expect(store.forgetPurged()).toBe(1);
    expect(store.session("s-a")).toBeUndefined();
    expect(store.messages(a)).toBeUndefined();
    expect(store.size()).toEqual({ files: 1, messages: 3 });
    // With nothing kept, a transcript gone takes its conversation with it.
    fs.unlinkSync(b);
    expect(store.sweep(10_000, false)).toEqual({ purged: [], returned: [], forgotten: ["s-b"] });
    expect(store.size()).toEqual({ files: 0, messages: 0 });
    store.close();
  });

  it("is read into by the reading code: a first read goes on from where the store stopped, when the file is still the one it read", () => {
    const store = openStore();
    const file = transcript();
    const job = { file, reader: TRANSCRIPT_LINES.name!, from: 0, identity: "", store: { file: store.file, build: BUILD } };
    const first = runScan(job)!;
    expect(first.reset).toBe(true);
    expect(first.lines.filter((line) => line.facts.message)).toHaveLength(3);
    expect(store.messages(file)).toHaveLength(3);
    appendEntries(file, [{ type: "assistant", message: { content: [{ type: "text", text: "Here it is." }] } }]);
    // Another window's first read: the file is read from where the store stopped, and the whole conversation comes back, the held part from the store.
    const again = runScan(job)!;
    expect(again.reset).toBe(true);
    expect(again.restored).toBe(first.end);
    expect(again.lines.filter((line) => line.facts.message).map((line) => line.facts.message!.text)).toEqual(["Fix the billing webhook for Stripe", "The billing webhook retries twice; retagging the invoice is separate.", "And the retag recipe?", "Here it is."]);
    expect(again.lines.slice(0, 3).every((line) => line.start === 0 && line.length === 0)).toBe(true);
    expect(store.messages(file)).toHaveLength(4);
    // Rewritten in place with the same size: the tail tells, and it is read whole.
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace("Here it is.", "Not at all."));
    const whole = runScan(job)!;
    expect(whole.reset).toBe(true);
    expect(whole.restored).toBeUndefined();
    expect(store.messages(file)!.map((m) => m.text).at(-1)).toBe("Not at all.");
    expect(store.progress(file)!.messages).toBe(4);
    // Another build: read whole too.
    const other = runScan({ ...job, store: { file: store.file, build: "build-2" } })!;
    expect(other.reset).toBe(true);
    expect(store.progress(file)!.build).toBe("build-2");
    store.close();
  });

  it("takes the operators of a parsed query as the search does", () => {
    const store = openStore();
    const a = transcript("a.jsonl");
    readInto(store, a);
    const query = parseQuery("retag file:billing.ts", Date.now());
    expect(store.touched([a], query.files)).toEqual(new Set([a]));
    expect(store.search([a], query.terms, 3).get(a)!.count).toBe(2);
    store.close();
  });
});
