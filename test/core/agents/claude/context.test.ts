import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "../../../../src/core/agents/claude/provider";
import { applyLine, CACHE_TTL_1H_MS, CACHE_TTL_5M_MS, cacheOf, emptyTranscript, pulseMarksOf, pulseOf } from "../../../../src/core/agents/claude/transcript";
import { findLines, LineSearch, lineStartAtOrAfter } from "../../../../src/core/jsonlTail";
import { appendEntries, FakeProc, sessionId, tempConfigDir, transcriptPath, writeSession } from "../../helpers";

// A real Claude Code 2.1.301 session (Haiku 5.5): two prompts, then /compact,
// anonymised. Claude Code writes the boundary first and the summary just
// after, though the summary's timestamp is the earlier of the two.
const FIXTURE = path.join(__dirname, "../../../fixtures/claude/transcripts/compacted.jsonl");
const recorded = () => fs.readFileSync(FIXTURE, "utf8").trimEnd().split("\n");

const MIN = 60_000;
const T = Date.parse("2026-10-16T12:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();
const boundary = (time: number, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: at(time), compactMetadata: { trigger: "auto", preTokens: 968_000, postTokens: 12_800 }, ...extra });
const summary = (time: number, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: at(time), message: { role: "user", content: "This session is being continued…" }, ...extra });
const reply = (time: number, creation?: Record<string, number>, model = "claude-haiku-5-5", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", timestamp: at(time), message: { id: `m${time}`, model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 40_000, ...(creation ? { cache_creation: creation } : {}) } }, ...extra });

describe("compactions", () => {
  it("counts the recorded /compact once, from its boundary and its summary", () => {
    const state = emptyTranscript();
    for (const line of recorded()) applyLine(state, line);
    expect(state.compactions).toBe(1);
    expect(state.compactedAt).toEqual([Date.parse("2026-10-16T19:39:01.228Z")]);
  });

  it("counts each compaction, however Claude Code marked it", () => {
    const state = emptyTranscript();
    // Only a summary, as older transcripts have it; then both marks; then only a boundary.
    applyLine(state, summary(T));
    applyLine(state, boundary(T + 20 * MIN));
    applyLine(state, summary(T + 20 * MIN - 400));
    applyLine(state, boundary(T + 40 * MIN));
    expect(state.compactions).toBe(3);
    expect(state.compactedAt).toEqual([T, T + 20 * MIN, T + 40 * MIN]);
  });

  it("pairs the marks of one compaction in any order, and keeps two compactions apart", () => {
    const state = emptyTranscript();
    // Found newest first, as when the part before a transcript's tail is searched after the tail is read.
    applyLine(state, boundary(T + 30 * MIN));
    applyLine(state, summary(T - 300));
    applyLine(state, boundary(T));
    applyLine(state, summary(T + 30 * MIN - 500));
    expect(state.compactions).toBe(2);
    expect(state.compactedAt).toEqual([T - 300, T + 30 * MIN]);
    // Two compactions half a minute apart are two.
    applyLine(state, boundary(T + 60 * MIN));
    applyLine(state, boundary(T + 60 * MIN + 30_000));
    expect(state.compactions).toBe(4);
  });

  it("pairs marks without a time by kind, next to each other", () => {
    const state = emptyTranscript();
    const untimed = (line: string) => JSON.stringify({ ...JSON.parse(line), timestamp: undefined });
    applyLine(state, untimed(boundary(T)));
    applyLine(state, untimed(summary(T)));
    expect(state.compactions).toBe(1);
    applyLine(state, untimed(summary(T)));
    applyLine(state, untimed(summary(T)));
    expect(state.compactions).toBe(3);
  });

  it("leaves out subagents' compactions and lines that only mention one", () => {
    const state = emptyTranscript();
    applyLine(state, boundary(T, { isSidechain: true }));
    applyLine(state, JSON.stringify({ type: "user", timestamp: at(T), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: '{"type":"system","subtype":"compact_boundary"}' }] } }));
    applyLine(state, JSON.stringify({ type: "user", timestamp: at(T), message: { content: 'grep "isCompactSummary":true' } }));
    expect(state.compactions).toBe(0);
  });
});

describe("the prompt cache", () => {
  it("lasts from the last call for the lifetime of the last call that wrote to it", () => {
    const state = emptyTranscript();
    expect(cacheOf(state)).toBeUndefined();
    applyLine(state, reply(T, { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_200 }));
    expect(cacheOf(state)).toEqual({ lastCallAt: T, ttlMs: CACHE_TTL_1H_MS });
    // A call that only read the cache keeps its entries' lifetime, and moves the last call on.
    applyLine(state, reply(T + MIN));
    expect(cacheOf(state)).toEqual({ lastCallAt: T + MIN, ttlMs: CACHE_TTL_1H_MS });
    applyLine(state, reply(T + 2 * MIN, { ephemeral_5m_input_tokens: 800, ephemeral_1h_input_tokens: 0 }));
    expect(cacheOf(state)).toEqual({ lastCallAt: T + 2 * MIN, ttlMs: CACHE_TTL_5M_MS });
  });

  it("runs from when a call went out: right after the input before its reply", () => {
    const state = emptyTranscript();
    applyLine(state, JSON.stringify({ type: "user", timestamp: at(T), message: { content: "write the report" } }));
    applyLine(state, JSON.stringify({ type: "attachment", timestamp: at(T + 300) }));
    // A long reply, written in two lines two and a half minutes later: one call.
    applyLine(state, reply(T + 150_000, { ephemeral_5m_input_tokens: 900 }));
    applyLine(state, reply(T + 151_000, { ephemeral_5m_input_tokens: 900 }));
    expect(cacheOf(state)).toEqual({ lastCallAt: T + 300, ttlMs: CACHE_TTL_5M_MS });
    // The tool result goes back, the next call goes out.
    applyLine(state, JSON.stringify({ type: "user", timestamp: at(T + 160_000), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }));
    applyLine(state, JSON.stringify({ type: "assistant", timestamp: at(T + 170_000), message: { id: "next", model: "claude-haiku-5-5", content: [{ type: "text", text: "done" }], usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 41_000 } } }));
    expect(cacheOf(state)?.lastCallAt).toBe(T + 160_000);
  });

  it("is not there for calls that neither read nor wrote the cache, and lasts 5 minutes when a call wrote both lifetimes", () => {
    const uncached = emptyTranscript();
    applyLine(uncached, JSON.stringify({ type: "assistant", timestamp: at(T), message: { id: "a", model: "claude-haiku-5-5", content: [], usage: { input_tokens: 40_000, output_tokens: 9 } } }));
    expect(cacheOf(uncached)).toBeUndefined();
    const mixed = emptyTranscript();
    applyLine(mixed, reply(T, { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 9_000 }));
    expect(cacheOf(mixed)?.ttlMs).toBe(CACHE_TTL_5M_MS);
  });

  it("is moved by the main chain's model calls only", () => {
    const state = emptyTranscript();
    applyLine(state, reply(T, { ephemeral_1h_input_tokens: 500 }));
    applyLine(state, reply(T + MIN, undefined, "<synthetic>"));
    applyLine(state, reply(T + 2 * MIN, undefined, "claude-haiku-5-5", { isSidechain: true }));
    applyLine(state, reply(T - MIN));
    expect(cacheOf(state)?.lastCallAt).toBe(T);
  });

  it("reads the recorded session's 1-hour entries", () => {
    const state = emptyTranscript();
    for (const line of recorded()) applyLine(state, line);
    // The second call went out right after its prompt, 19:38:37.174, not when its reply was written two seconds later.
    expect(cacheOf(state)).toEqual({ lastCallAt: Date.parse("2026-10-16T19:38:37.174Z"), ttlMs: CACHE_TTL_1H_MS });
  });
});

describe("pulse marks", () => {
  it("pins the minute of a compaction on the bars the pulse shows", () => {
    const state = emptyTranscript();
    const now = T + 30 * MIN;
    applyLine(state, boundary(now - 20 * MIN));
    applyLine(state, boundary(now - 6.5 * MIN));
    applyLine(state, boundary(now - 30_000));
    expect(pulseOf(state, now)).toHaveLength(15);
    expect(pulseMarksOf(state, now)).toEqual([8, 14]);
    // A young session shows fewer bars, from the left: the marks shift with them.
    expect(pulseOf(state, now, now - 7.5 * MIN)).toHaveLength(8);
    expect(pulseMarksOf(state, now, now - 7.5 * MIN)).toEqual([1, 7]);
    expect(pulseMarksOf(state, now, now - 2 * MIN)).toEqual([2]);
    expect(pulseMarksOf(emptyTranscript(), now)).toEqual([]);
  });
});

describe("findLines", () => {
  it("finds the lines that contain a needle, before the given offset, across chunk boundaries", () => {
    const dir = tempConfigDir();
    const file = path.join(dir, "t.jsonl");
    const big = "x".repeat(1_500_000);
    const lines = ['{"a":1}', `{"pad":"${big}","subtype":"compact_boundary"}`, '{"isCompactSummary":true}', `{"pad":"${big}"}`, '{"subtype":"compact_boundary"}'];
    fs.writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
    const starts = lines.reduce<number[]>((acc, line, i) => [...acc, i === 0 ? 0 : acc[i - 1]! + Buffer.byteLength(lines[i - 1]!) + 1], []);
    const needles = ['"subtype":"compact_boundary"', '"isCompactSummary":true'];
    expect(findLines(file, needles, fs.statSync(file).size)).toEqual([starts[1], starts[2], starts[4]]);
    expect(findLines(file, needles, starts[4]!)).toEqual([starts[1], starts[2]]);
    expect(findLines(path.join(dir, "missing.jsonl"), needles, 100)).toEqual([]);
    // A slice at a time finds the same lines, each once.
    const search = new LineSearch(file, needles, fs.statSync(file).size);
    const found: number[] = [];
    let steps = 0;
    while (!search.done) {
      found.push(...search.step(300_000));
      steps++;
    }
    expect(found).toEqual([starts[1], starts[2], starts[4]]);
    expect(steps).toBeGreaterThan(5);
    expect(search.step(300_000)).toEqual([]);
  });

  it("finds the line start at or after an offset", () => {
    const file = path.join(tempConfigDir(), "t.jsonl");
    fs.writeFileSync(file, "aaa\nbbbb\ncc");
    // 11 bytes: lines start at 0, 4 and 9; past the last newline comes the end of the file.
    expect([0, 1, 4, 5, 9, 10, 11, 20].map((offset) => lineStartAtOrAfter(file, offset))).toEqual([0, 4, 4, 9, 9, 11, 11, 11]);
  });
});

describe("ClaudeProvider", () => {
  it("counts the compactions of a large transcript it starts reading near the end, and the ones that follow", () => {
    const configDir = tempConfigDir();
    const proc = new FakeProc();
    const provider = new ClaudeProvider(configDir, proc);
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, cwd: "/work/app", status: "idle" });
    const file = transcriptPath(configDir, "/work/app", id);
    const filler = Array.from({ length: 1500 }, () => ({ type: "progress", data: "x".repeat(1000) }));
    const early = T - 3 * 60 * MIN;
    appendEntries(file, [
      { type: "user", cwd: "/work/app", timestamp: at(early - MIN), message: { content: "go" } },
      JSON.parse(boundary(early)),
      JSON.parse(summary(early - 300)),
      ...filler,
      { type: "cost-state", totalCostUSD: 1, modelUsage: {} },
      JSON.parse(reply(T, { ephemeral_1h_input_tokens: 900 })),
    ]);
    const now = T + 5 * MIN;
    expect(provider.poll(now)[0]).toMatchObject({ compactions: 1, compactedAt: early, pulseMarks: [], cache: { lastCallAt: T, ttlMs: CACHE_TTL_1H_MS } });
    appendEntries(file, [JSON.parse(boundary(now - 30_000))]);
    expect(provider.poll(now)[0]).toMatchObject({ compactions: 2, compactedAt: now - 30_000, pulseMarks: [14] });
    // Replaced by a copy with one more line: read again from the start of what it holds, earlier compactions included.
    const copy = `${file}.new`;
    fs.copyFileSync(file, copy);
    appendEntries(copy, [{ type: "user", cwd: "/work/app", timestamp: at(now), message: { content: "and now?" } }]);
    fs.renameSync(copy, file);
    expect(provider.poll(now + 1_000)[0]).toMatchObject({ compactions: 2, compactedAt: now - 30_000 });
  });

  it("finds a compaction whose line starts just before the part it reads of a transcript with no checkpoint", () => {
    const configDir = tempConfigDir();
    const proc = new FakeProc();
    const provider = new ClaudeProvider(configDir, proc);
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, cwd: "/work/app", status: "idle" });
    const file = transcriptPath(configDir, "/work/app", id);
    const filler = (n: number) => Array.from({ length: n }, () => ({ type: "progress", data: "x".repeat(1000) }));
    appendEntries(file, [{ type: "user", cwd: "/work/app", timestamp: at(T), message: { content: "go" } }, ...filler(900)]);
    // The boundary line starts before the last megabyte and its mark lies inside it.
    const head = fs.statSync(file).size;
    const padded = { pad: "y".repeat(400_000), ...JSON.parse(boundary(T + MIN)) };
    appendEntries(file, [padded, ...filler(800)]);
    const size = fs.statSync(file).size;
    expect(head < size - 1024 * 1024 && size - 1024 * 1024 < head + 400_000).toBe(true);
    expect(provider.poll(T + 2 * MIN)[0]).toMatchObject({ compactions: 1, compactedAt: T + MIN });
  });
});
