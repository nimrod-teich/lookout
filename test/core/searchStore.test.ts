import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRANSCRIPT_LINES } from "../../src/core/agents/claude/history";
import { closeStores, runScan } from "../../src/core/agents/lineReaders";
import { HistoryIndex, readThroughStore, scanFile } from "../../src/core/history";
import { searchWithStore, type Searchable } from "../../src/core/search";
import { loadSqlite } from "../../src/core/sqlite";
import { ConversationStore } from "../../src/core/store";
import { parseQuery } from "../../src/core/terms";
import { appendEntries, tempConfigDir } from "./helpers";

const sqlite = loadSqlite() !== undefined;
const BUILD = "build-1";
const NOW = Date.UTC(2026, 9, 26, 12);

function transcript(name: string, text: string, at = NOW - 3_600_000): string {
  const file = path.join(tempConfigDir(), name);
  appendEntries(file, [
    { type: "user", timestamp: new Date(at).toISOString(), message: { content: text } },
    { type: "assistant", timestamp: new Date(at + 1000).toISOString(), message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/api/Billing.ts" } }] } },
    { type: "assistant", timestamp: new Date(at + 2000).toISOString(), message: { content: [{ type: "text", text: `Done with the ${text.split(" ").pop()}.` }] } },
  ]);
  return file;
}

/** A store, with every index reading through it from now on, as the controller has it while a store is open. */
function openStore(): ConversationStore {
  const store = ConversationStore.open(path.join(tempConfigDir(), "history.sqlite"));
  if (!store) throw new Error("no store");
  readThroughStore({ scan: runScan, store: { file: store.file, build: BUILD } });
  return store;
}

/** A conversation as a provider lists one: its file, and an index read on demand (`held`, to look into). */
function conversation(id: string, file: string, more: Partial<Searchable> = {}): Searchable & { held: HistoryIndex } {
  const held = new HistoryIndex(file, TRANSCRIPT_LINES);
  return { id, cwd: "/work/api", file, ...more, index: () => held, held };
}

describe.skipIf(!sqlite)("searchWithStore", () => {
  beforeEach(() => readThroughStore(undefined));
  // The reads through the store keep a connection of their own: closed, so the temporary files can go.
  afterEach(() => {
    readThroughStore(undefined);
    closeStores();
  });

  it("answers from the store for the files it holds, reads the others through it, and leaves out what nothing matches", () => {
    const store = openStore();
    const held = transcript("held.jsonl", "fix the billing webhook");
    const fresh = transcript("fresh.jsonl", "write the retag recipe");
    store.record({ file: held, reader: TRANSCRIPT_LINES.name!, from: 0 }, scanFile(held, TRANSCRIPT_LINES, 0, "")!, BUILD);
    const a = conversation("a", held);
    const b = conversation("b", fresh);
    const query = parseQuery("retag", NOW);
    const outcome = searchWithStore([a, b], query, 3, 1000, undefined, undefined, store);
    expect(outcome.pending).toBe(0);
    expect(outcome.results.map((r) => [r.id, r.count, r.hits.map((hit) => hit.role)])).toEqual([["b", 1, ["you"]]]);
    // The fresh file went into the store on the way, and its index holds it too.
    expect(store.has(fresh)).toBe(true);
    expect(b.held.messages).toHaveLength(2);
    // Every term in one message; the files asked for.
    expect(searchWithStore([a, b], parseQuery("billing webhook", NOW), 3, 1000, undefined, undefined, store).results.map((r) => r.id)).toEqual(["a"]);
    expect(searchWithStore([a, b], parseQuery("retag file:billing.ts", NOW), 3, 1000, undefined, undefined, store).results.map((r) => r.id)).toEqual(["b"]);
    expect(searchWithStore([a, b], parseQuery("retag file:other.ts", NOW), 3, 1000, undefined, undefined, store).results).toEqual([]);
    store.close();
  });

  it("lists by operators alone, by project and branch, and by the times of the messages", () => {
    const store = openStore();
    const old = transcript("old.jsonl", "the old billing talk", NOW - 10 * 86_400_000);
    const recent = transcript("recent.jsonl", "the recent billing talk");
    for (const file of [old, recent]) store.record({ file, reader: TRANSCRIPT_LINES.name!, from: 0 }, scanFile(file, TRANSCRIPT_LINES, 0, "")!, BUILD);
    const a = conversation("a", old, { pastModifiedAt: NOW - 10 * 86_400_000, branch: "main" });
    const b = conversation("b", recent, { cwd: "/work/web", branch: "fix-x" });
    const run = (text: string) => searchWithStore([a, b], parseQuery(text, NOW), 3, 1000, undefined, undefined, store).results.map((r) => [r.id, r.count]);
    expect(run("since:3d")).toEqual([["b", 0]]);
    expect(run("before:3d")).toEqual([["a", 0]]);
    expect(run("project:web")).toEqual([["b", 0]]);
    expect(run("branch:main")).toEqual([["a", 0]]);
    expect(run("billing since:3d")).toEqual([["b", 1]]);
    expect(run("billing branch:main")).toEqual([["a", 1]]);
    expect(run("file:billing.ts")).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
    store.close();
  });

  it("counts a conversation it cannot read yet as pending, and one with no index or file as nothing", () => {
    const store = openStore();
    const file = transcript("t.jsonl", "fix the billing webhook");
    const a = conversation("a", file);
    const none: Searchable = { id: "n", cwd: "/w", index: () => undefined };
    // No budget: the file is not read now.
    const first = searchWithStore([a, none], parseQuery("billing", NOW), 3, -1, undefined, undefined, store);
    expect(first).toEqual({ results: [], pending: 1 });
    // With budget: read through the store, then found.
    const second = searchWithStore([a, none], parseQuery("billing", NOW), 3, 1000, undefined, undefined, store);
    expect(second.results.map((r) => r.id)).toEqual(["a"]);
    expect(second.pending).toBe(0);
    // A purged session: a file the store holds and no index.
    fs.unlinkSync(file);
    const purged: Searchable = { id: "p", cwd: "/work/api", file, index: () => undefined };
    expect(searchWithStore([purged], parseQuery("billing", NOW), 3, 0, undefined, undefined, store).results.map((r) => [r.id, r.count])).toEqual([["p", 1]]);
    store.close();
  });

  it("follows a conversation that grows, through the store", () => {
    const store = openStore();
    const file = transcript("t.jsonl", "fix the billing webhook");
    const a = conversation("a", file);
    searchWithStore([a], parseQuery("billing", NOW), 3, 1000, undefined, undefined, store);
    appendEntries(file, [{ type: "user", message: { content: "and the retag recipe" } }]);
    const found = searchWithStore([a], parseQuery("retag", NOW), 3, 1000, undefined, undefined, store);
    expect(found.results.map((r) => [r.id, r.count])).toEqual([["a", 1]]);
    expect(store.messages(file)).toHaveLength(3);
    expect(a.held.messages).toHaveLength(3);
    store.close();
  });
});

describe.skipIf(!sqlite)("the store as the index", () => {
  beforeEach(() => readThroughStore(undefined));
  afterEach(() => {
    readThroughStore(undefined);
    closeStores();
  });

  /** A store the indexes keep no messages beside: they read them from it, as the controller has it. */
  function leanStore(): ConversationStore {
    const store = ConversationStore.open(path.join(tempConfigDir(), "history.sqlite"));
    if (!store) throw new Error("no store");
    readThroughStore({ scan: runScan, store: { file: store.file, build: BUILD }, messages: (file) => store.messages(file) });
    return store;
  }

  it("keeps no messages in an index: a read writes the store and answers with no lines, and the messages come from the store", () => {
    const store = leanStore();
    const file = transcript("a.jsonl", "write the retag recipe");
    const index = new HistoryIndex(file, TRANSCRIPT_LINES);
    expect(index.lean).toBe(true);
    const job = index.scan()!;
    expect(job.lean).toBe(true);
    const scanned = runScan({ ...job, store: { file: store.file, build: BUILD } })!;
    expect(scanned.lines).toEqual([]);
    expect(index.apply(scanned, job)).toBe(true);
    expect(index.ready).toBe(true);
    expect(store.has(file)).toBe(true);
    expect(index.messages.map((m) => m.text)).toEqual(["write the retag recipe", "Done with the recipe."]);
    // What the file gains goes the same way.
    appendEntries(file, [{ type: "user", timestamp: new Date(NOW).toISOString(), message: { content: "and the rollback" } }]);
    index.refresh();
    expect(index.messages.map((m) => m.text).at(-1)).toBe("and the rollback");
    // A reader without a name (a chat log replayed whole) keeps its messages in memory all the same.
    expect(new HistoryIndex(file, { mayHold: () => false, facts: () => undefined }).lean).toBe(false);
  });

  it("searches every stored conversation from the store, and reads again one whose rows the store let go", () => {
    const store = leanStore();
    const a = conversation("a", transcript("a.jsonl", "fix the billing webhook"));
    const b = conversation("b", transcript("b.jsonl", "write the retag recipe"));
    const query = parseQuery("retag", NOW);
    expect(searchWithStore([a, b], query, 3, 1000, undefined, undefined, store).results.map((r) => [r.id, r.count])).toEqual([["b", 1]]);
    // The store lets go of b (its session forgotten): the next search reads it again from the start.
    store.rememberSession({ id: "b", agent: "claude-code", file: b.file!, title: "b", cwd: "/work/api" });
    store.forget(["b"]);
    expect(store.has(b.file!)).toBe(false);
    expect(searchWithStore([a, b], query, 3, 1000, undefined, undefined, store).results.map((r) => [r.id, r.count])).toEqual([["b", 1]]);
    expect(store.has(b.file!)).toBe(true);
  });

  it("does not look at a past conversation's file again while its listing says it was last written when it was read", () => {
    const store = leanStore();
    const file = transcript("a.jsonl", "write the retag recipe");
    const a = conversation("a", file);
    searchWithStore([a], parseQuery("retag", NOW), 3, 1000, undefined, undefined, store);
    const listed = Math.round(fs.statSync(file).mtimeMs);
    expect(a.held.seenAt(listed)).toBe(true);
    // The file grows behind the listing's back: a past conversation the listing still shows unchanged is not read.
    appendEntries(file, [{ type: "user", timestamp: new Date(NOW).toISOString(), message: { content: "grown since" } }]);
    const unchanged = { ...a, pastModifiedAt: listed };
    expect(searchWithStore([unchanged], parseQuery("grown", NOW), 3, 1000, undefined, undefined, store).results).toEqual([]);
    // Once the listing shows the new time, it is.
    const relisted = { ...a, pastModifiedAt: Math.round(fs.statSync(file).mtimeMs) };
    expect(searchWithStore([relisted], parseQuery("grown", NOW), 3, 1000, undefined, undefined, store).results.map((r) => r.id)).toEqual(["a"]);
  });

  it("finds a phrase, its words in a row, and not the same words apart", () => {
    const store = leanStore();
    const together = conversation("t", transcript("t.jsonl", "the staging migrate failed again"));
    const apart = conversation("p", transcript("p.jsonl", "migrate went fine, staging failed later"));
    const found = searchWithStore([together, apart], parseQuery('"staging migrate" failed', NOW), 3, 1000, undefined, undefined, store);
    expect(found.results.map((r) => r.id)).toEqual(["t"]);
    expect(found.results[0]!.hits[0]!.ranges.length).toBeGreaterThan(0);
  });

  it("asks the store once for which files it holds", () => {
    const store = leanStore();
    const a = transcript("a.jsonl", "one");
    store.record({ file: a, reader: TRANSCRIPT_LINES.name!, from: 0 }, scanFile(a, TRANSCRIPT_LINES, 0, "")!, BUILD);
    expect(store.held([a, path.join(tempConfigDir(), "missing.jsonl")])).toEqual(new Set([a]));
    expect(store.held([])).toEqual(new Set());
  });
});
