import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "../../../../src/core/agents/claude/provider";
import { applyLine, emptyTranscript, pulseMarksOf, pulseOf } from "../../../../src/core/agents/claude/transcript";
import { lineStartAtOrAfter } from "../../../../src/core/jsonlTail";
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


describe("compaction times", () => {
  it("takes the recorded /compact once, from its boundary and its summary", () => {
    const state = emptyTranscript();
    for (const line of recorded()) applyLine(state, line);
    expect(state.compactedAt).toEqual([Date.parse("2026-10-16T19:39:01.228Z")]);
  });

  it("takes each compaction, however Claude Code marked it, in any order, and keeps two compactions apart", () => {
    const state = emptyTranscript();
    // Only a summary, as older transcripts have it; then both marks, the summary first; then only a boundary.
    applyLine(state, summary(T));
    applyLine(state, summary(T + 20 * MIN - 400));
    applyLine(state, boundary(T + 20 * MIN));
    applyLine(state, boundary(T + 40 * MIN));
    expect(state.compactedAt).toEqual([T, T + 20 * MIN - 400, T + 40 * MIN]);
    // Two compactions half a minute apart are two.
    applyLine(state, boundary(T + 60 * MIN));
    applyLine(state, boundary(T + 60 * MIN + 30_000));
    expect(state.compactedAt).toHaveLength(5);
  });

  it("leaves out subagents' compactions, lines that only mention one, and marks without a time", () => {
    const state = emptyTranscript();
    applyLine(state, boundary(T, { isSidechain: true }));
    applyLine(state, JSON.stringify({ type: "user", timestamp: at(T), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: '{"type":"system","subtype":"compact_boundary"}' }] } }));
    applyLine(state, JSON.stringify({ type: "user", timestamp: at(T), message: { content: 'grep "isCompactSummary":true' } }));
    applyLine(state, JSON.stringify({ ...JSON.parse(boundary(T)), timestamp: undefined }));
    expect(state.compactedAt).toEqual([]);
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

describe("lineStartAtOrAfter", () => {
  it("finds the line start at or after an offset", () => {
    const file = path.join(tempConfigDir(), "t.jsonl");
    fs.writeFileSync(file, "aaa\nbbbb\ncc");
    // 11 bytes: lines start at 0, 4 and 9; past the last newline comes the end of the file.
    expect([0, 1, 4, 5, 9, 10, 11, 20].map((offset) => lineStartAtOrAfter(file, offset))).toEqual([0, 4, 4, 9, 9, 11, 11, 11]);
  });
});

describe("ClaudeProvider", () => {
  it("pins a compaction on the pulse of a large transcript it reads from near the end", () => {
    const configDir = tempConfigDir();
    const proc = new FakeProc();
    const provider = new ClaudeProvider(configDir, proc);
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id, cwd: "/work/app", status: "idle" });
    const file = transcriptPath(configDir, "/work/app", id);
    const filler = Array.from({ length: 1500 }, () => ({ type: "progress", data: "x".repeat(1000) }));
    appendEntries(file, [{ type: "user", cwd: "/work/app", timestamp: at(T - MIN), message: { content: "go" } }, ...filler, { type: "cost-state", totalCostUSD: 1, modelUsage: {} }]);
    const now = T + 5 * MIN;
    expect(provider.poll(now)[0]).toMatchObject({ pulseMarks: [] });
    appendEntries(file, [JSON.parse(boundary(now - 30_000)), JSON.parse(summary(now - 30_400))]);
    expect(provider.poll(now)[0]).toMatchObject({ pulseMarks: [14] });
  });
});
