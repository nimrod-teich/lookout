import { describe, expect, it } from "vitest";
import type { SearchOutcome } from "../../src/core/agents/agent";
import { withNotes, type NotedSession } from "../../src/core/notes";
import { parseQuery } from "../../src/core/terms";

const NOW = new Date(2026, 9, 26, 12, 0).getTime();
const DAY = 86_400_000;

const NOTED: NotedSession[] = [
  { id: "a", notes: [{ id: "a1", text: "Has the retag recipe for the dashboard", at: NOW - 1 * DAY }], cwd: "/work/dashboard", branch: "main" },
  { id: "b", notes: [{ id: "b1", text: "Superseded by the cache PR", at: NOW - 10 * DAY }], cwd: "/work/api", branch: "fix-cache" },
];

/** A result as a conversation search gives it: one message hit. */
function result(id: string, count = 1): SearchOutcome["results"][number] {
  return { id, count, hits: Array.from({ length: count }, (_, i) => ({ index: i, role: "agent" as const, snippet: `message ${i}`, ranges: [] })) };
}

describe("withNotes", () => {
  it("adds a note that holds every word as its session's first match, and lists a session whose conversation has none", () => {
    const outcome: SearchOutcome = { results: [result("a"), result("c")], pending: 2 };
    const merged = withNotes(outcome, NOTED, parseQuery("retag recipe", NOW), 3);
    expect(merged.pending).toBe(2);
    expect(merged.results.map((r) => [r.id, r.count])).toEqual([
      ["a", 2],
      ["c", 1],
    ]);
    const first = merged.results[0]!.hits[0]!;
    expect(first).toMatchObject({ role: "note", at: NOW - DAY, snippet: "Has the retag recipe for the dashboard" });
    expect(first.index).toBeUndefined();
    expect(first.ranges).toEqual([
      [8, 13],
      [14, 20],
    ]);
    expect(merged.results[0]!.hits[1]).toMatchObject({ role: "agent", index: 0 });
    // The note alone matches: the session is listed for it.
    const alone = withNotes({ results: [], pending: 0 }, NOTED, parseQuery("superseded", NOW), 3);
    expect(alone.results).toEqual([{ id: "b", count: 1, hits: [expect.objectContaining({ role: "note", ranges: [[0, 10]] })] }]);
    // The input is left as it was.
    expect(outcome.results[0]!.hits).toHaveLength(1);
  });

  it("keeps the number of matches shown, the note first", () => {
    const merged = withNotes({ results: [result("a", 3)], pending: 0 }, NOTED, parseQuery("retag", NOW), 3);
    expect(merged.results[0]!.count).toBe(4);
    expect(merged.results[0]!.hits.map((hit) => hit.role)).toEqual(["note", "agent", "agent"]);
  });

  it("keeps only the sessions with a note for has:note, and alone lists each with its note", () => {
    const outcome: SearchOutcome = { results: [result("a"), result("c")], pending: 0 };
    const words = withNotes(outcome, NOTED, parseQuery("has:note message", NOW), 3);
    expect(words.results.map((r) => r.id)).toEqual(["a"]);
    // "message" is in a's conversation, not in its note: no note hit, the conversation's own stays.
    expect(words.results[0]!.hits.map((hit) => hit.role)).toEqual(["agent"]);
    const alone = withNotes({ results: [result("a", 0), result("c", 0)], pending: 0 }, NOTED, parseQuery("has:note", NOW), 3);
    expect(alone.results.map((r) => [r.id, r.count, r.hits.map((hit) => hit.role)])).toEqual([
      ["a", 0, ["note"]],
      ["b", 0, ["note"]],
    ]);
    expect(alone.results[1]!.hits[0]).toMatchObject({ snippet: "Superseded by the cache PR", ranges: [] });
  });

  it("shows the note of a session that operators alone list, and not of one they leave out", () => {
    const merged = withNotes({ results: [result("a", 0)], pending: 0 }, NOTED, parseQuery("project:dashboard", NOW), 3);
    expect(merged.results).toEqual([{ id: "a", count: 0, hits: [expect.objectContaining({ role: "note", ranges: [] })] }]);
  });

  it("holds the notes to project:, branch:, since: and before: like messages", () => {
    const none = { results: [], pending: 0 };
    expect(withNotes(none, NOTED, parseQuery("has:note project:api", NOW), 3).results.map((r) => r.id)).toEqual(["b"]);
    expect(withNotes(none, NOTED, parseQuery("has:note branch:main", NOW), 3).results.map((r) => r.id)).toEqual(["a"]);
    expect(withNotes(none, NOTED, parseQuery("has:note since:3d", NOW), 3).results.map((r) => r.id)).toEqual(["a"]);
    expect(withNotes(none, NOTED, parseQuery("has:note before:3d", NOW), 3).results.map((r) => r.id)).toEqual(["b"]);
    // A note from before the times falls outside a bounded range, and within an open one.
    const old = [{ id: "u", notes: [{ id: "u1", text: "retag", at: 0 }], cwd: "/w" }];
    expect(withNotes(none, old, parseQuery("retag since:3d", NOW), 3).results).toEqual([]);
    expect(withNotes(none, old, parseQuery("retag", NOW), 3).results.map((r) => r.id)).toEqual(["u"]);
  });

  it("leaves a search without notes as it was", () => {
    const outcome: SearchOutcome = { results: [result("a")], pending: 1 };
    expect(withNotes(outcome, [], parseQuery("retag", NOW), 3)).toEqual(outcome);
  });
});

describe("withNotes, the operators a note has nothing for", () => {
  it("gives a note no files: with file: it rides only a session the conversation search listed", () => {
    const none = { results: [], pending: 0 };
    expect(withNotes(none, NOTED, parseQuery("has:note file:zzz", NOW), 3).results).toEqual([]);
    expect(withNotes(none, NOTED, parseQuery("retag file:zzz", NOW), 3).results).toEqual([]);
    const listed = withNotes({ results: [result("a", 0)], pending: 0 }, NOTED, parseQuery("has:note file:src/app.ts", NOW), 3);
    expect(listed.results.map((r) => [r.id, r.hits.map((hit) => hit.role)])).toEqual([["a", ["note"]]]);
  });

  it("drops a session has:note asked for whose note falls outside the times, though its conversation was listed", () => {
    const merged = withNotes({ results: [result("b", 0)], pending: 0 }, NOTED, parseQuery("has:note since:3d", NOW), 3);
    expect(merged.results.map((r) => [r.id, r.hits.map((hit) => hit.role)])).toEqual([["a", ["note"]]]);
    // Without has:note the session stays for its messages, without the note.
    const words = withNotes({ results: [result("b", 1)], pending: 0 }, NOTED, parseQuery("message since:3d", NOW), 3);
    expect(words.results.map((r) => [r.id, r.hits.map((hit) => hit.role)])).toEqual([["b", ["agent"]]]);
  });
});

describe("withNotes, a thread of notes", () => {
  const THREAD: NotedSession[] = [
    {
      id: "t",
      cwd: "/work/api",
      notes: [
        { id: "t1", text: "Started on the cache layer", at: NOW - 9 * DAY },
        { id: "t2", text: "The cache needed a TTL per tenant", at: NOW - 2 * DAY },
        { id: "t3", text: "Shipped, see the release notes", at: NOW - 1 * DAY },
      ],
    },
  ];

  it("gives each note that holds the words a match of its own, the newest first, before the messages, and counts them all", () => {
    const merged = withNotes({ results: [result("t", 2)], pending: 0 }, THREAD, parseQuery("cache", NOW), 5);
    expect(merged.results[0]!.count).toBe(4);
    expect(merged.results[0]!.hits.map((hit) => [hit.role, hit.snippet])).toEqual([
      ["note", "The cache needed a TTL per tenant"],
      ["note", "Started on the cache layer"],
      ["agent", "message 0"],
      ["agent", "message 1"],
    ]);
    // Within the number shown, the notes first.
    expect(withNotes({ results: [result("t", 2)], pending: 0 }, THREAD, parseQuery("cache", NOW), 2).results[0]!.hits.map((hit) => hit.role)).toEqual(["note", "note"]);
  });

  it("lists every note for has:note, newest first, and holds each to the times", () => {
    const none = { results: [], pending: 0 };
    expect(withNotes(none, THREAD, parseQuery("has:note", NOW), 5).results[0]!.hits.map((hit) => hit.snippet)).toEqual(["Shipped, see the release notes", "The cache needed a TTL per tenant", "Started on the cache layer"]);
    expect(withNotes(none, THREAD, parseQuery("has:note since:3d", NOW), 5).results[0]!.hits.map((hit) => hit.snippet)).toEqual(["Shipped, see the release notes", "The cache needed a TTL per tenant"]);
    // has:note keeps a session listed for its messages as long as one of its notes falls within the times.
    const listed = withNotes({ results: [result("t", 0)], pending: 0 }, THREAD, parseQuery("has:note before:5d", NOW), 5);
    expect(listed.results.map((r) => [r.id, r.hits.map((hit) => hit.snippet)])).toEqual([["t", ["Started on the cache layer"]]]);
  });

  it("passes over a session whose thread is empty", () => {
    const empty = [{ id: "e", notes: [], cwd: "/w" }];
    expect(withNotes({ results: [], pending: 0 }, empty, parseQuery("has:note", NOW), 3).results).toEqual([]);
  });
});
