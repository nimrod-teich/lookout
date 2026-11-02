import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { pricesFor, replyCost } from "../../../../src/core/agents/claude/pricing";
import { ClaudeProvider } from "../../../../src/core/agents/claude/provider";
import { applyLine, emptyTranscript, spendOf } from "../../../../src/core/agents/claude/transcript";
import { findLastLine, JsonlTail } from "../../../../src/core/jsonlTail";
import { appendEntries, FakeProc, sessionId, tempConfigDir, transcriptPath, writeSession } from "../../helpers";

const M = 1_000_000;

describe("pricing", () => {
  it("knows the current models, with or without the 1M suffix, and nothing else", () => {
    expect(pricesFor("claude-fable-5-1")).toMatchObject({ input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 });
    expect(pricesFor("claude-opus-5-5[1m]")).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 });
    expect(pricesFor("claude-fable-5")).toMatchObject({ input: 10, output: 50, cacheRead: 1 });
    expect(pricesFor("claude-opus-5")).toMatchObject({ input: 5, output: 25 });
    expect(pricesFor("claude-opus-4-7")).toMatchObject({ input: 5, output: 25, cacheRead: 0.5 });
    expect(pricesFor("claude-sonnet-5-5")).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 });
    expect(pricesFor("claude-sonnet-5")).toMatchObject({ input: 2, output: 10, cacheRead: 0.2 });
    expect(pricesFor("claude-haiku-5-5")).toMatchObject({ input: 0.1, output: 0.5, cacheRead: 0.01 });
    expect(pricesFor("claude-haiku-4-5-20251001")).toMatchObject({ input: 1, output: 5 });
    expect(pricesFor("gpt-6")).toBeUndefined();
  });

  it("knows the older models still on Anthropic's price list, by alias or dated id", () => {
    expect(pricesFor("claude-opus-4-5-20251101")).toMatchObject({ input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 });
    for (const id of ["claude-opus-4-1-20250805", "claude-opus-4-1", "claude-opus-4-20250514", "claude-opus-4-0"]) {
      expect(pricesFor(id), id).toMatchObject({ input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 });
    }
    for (const id of ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5", "claude-sonnet-4-20250514", "claude-sonnet-4-0"]) {
      expect(pricesFor(id), id).toMatchObject({ input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 });
    }
    expect(pricesFor("claude-3-5-haiku-20241022")).toMatchObject({ input: 0.8, output: 4, cacheRead: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6 });
    // Retired before Anthropic's current list: no price, rather than a guess.
    expect(pricesFor("claude-3-7-sonnet-20250219")).toBeUndefined();
    expect(pricesFor("claude-3-opus-20240229")).toBeUndefined();
  });

  const tokens = (input: number, output = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0) => ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h });

  it("prices a reply", () => {
    expect(replyCost("claude-opus-5-5", tokens(M, M, M, M, M))).toBe(4 + 20 + 0.2 + 5 + 8);
    expect(replyCost("unknown-model", tokens(M))).toBeUndefined();
  });

  it("prices a Haiku 5.5 reply whose prompt, cache included, is over 100,000 tokens at the long rates", () => {
    expect(replyCost("claude-haiku-5-5", tokens(100_000, M))).toBeCloseTo(0.01 + 0.5, 9);
    expect(replyCost("claude-haiku-5-5", tokens(1, M, 90_000, 10_000))).toBeCloseTo((1 * 0.5 + M * 2.5 + 90_000 * 0.05 + 10_000 * 0.625) / M, 9);
    expect(replyCost("claude-haiku-4-5", tokens(200_000))).toBeCloseTo(0.2, 9);
  });

  it("prices fast mode on the models that have it, cache multipliers on top", () => {
    expect(replyCost("claude-opus-5-5", tokens(M, M, M, M, M), { speed: "fast" })).toBeCloseTo(8 + 40 + 0.4 + 10 + 16, 9);
    expect(replyCost("claude-opus-4-8", tokens(M, M), { speed: "fast" })).toBeCloseTo(10 + 50, 9);
    expect(replyCost("claude-opus-5-5", tokens(M, M), { speed: "standard" })).toBeCloseTo(4 + 20, 9);
    expect(replyCost("claude-sonnet-5-5", tokens(M, M), { speed: "fast" })).toBeCloseTo(2 + 10, 9);
  });

  it("prices US-only inference at 1.1×", () => {
    expect(replyCost("claude-sonnet-5-5", tokens(M, M, M), { inferenceGeo: "us" })).toBeCloseTo(1.1 * (2 + 10 + 0.1), 9);
    expect(replyCost("claude-opus-5-5", tokens(0, M), { speed: "fast", inferenceGeo: "us" })).toBeCloseTo(1.1 * 40, 9);
    expect(replyCost("claude-sonnet-5-5", tokens(M), { inferenceGeo: "global" })).toBeCloseTo(2, 9);
  });
});

describe("spend from the transcript", () => {
  const assistant = (id: string, model: string, usage: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", message: { id, model, usage, content: [{ type: "text", text: "." }] } });
  const checkpoint = (modelUsage: Record<string, unknown>, totalCostUSD: number) => JSON.stringify({ type: "cost-state", totalCostUSD, modelUsage });

  it("is unknown until something was used", () => {
    expect(spendOf(emptyTranscript())).toBeUndefined();
  });

  it("sums usage once per message, splitting cache writes by lifetime, and prices it", () => {
    const state = emptyTranscript();
    const usage = { input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: M, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } };
    applyLine(state, assistant("m1", "claude-opus-5-5", usage));
    applyLine(state, assistant("m1", "claude-opus-5-5", usage));
    applyLine(state, assistant("m1", "claude-opus-5-5", usage));
    const spend = spendOf(state)!;
    expect(spend).toMatchObject({ input: 100, output: 1000, cacheRead: M, cacheWrite: 3000, estimated: true, partial: false });
    expect(spend.costUsd).toBeCloseTo((100 * 4 + 1000 * 20 + M * 0.2 + 1000 * 5 + 2000 * 8) / M, 6);
  });

  it("prices each reply as it was served: its own prompt's length, its speed and where it ran", () => {
    const state = emptyTranscript();
    // Two 60,000-token Haiku prompts: each under the long-prompt threshold, though their sum is over it.
    applyLine(state, assistant("h1", "claude-haiku-5-5", { input_tokens: 60_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    applyLine(state, assistant("h2", "claude-haiku-5-5", { input_tokens: 60_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    applyLine(state, assistant("f1", "claude-opus-5-5", { input_tokens: 0, output_tokens: M, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed: "fast", inference_geo: "global" }));
    applyLine(state, assistant("u1", "claude-opus-5-5", { input_tokens: 0, output_tokens: M, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed: "standard", inference_geo: "us" }));
    const spend = spendOf(state)!;
    expect(spend).toMatchObject({ input: 120_000, output: 2 * M, estimated: true });
    expect(spend.costUsd).toBeCloseTo(120_000 * 0.1 / M + 40 + 1.1 * 20, 6);
  });

  it("starts from the agent's checkpoint and resets what came before", () => {
    const state = emptyTranscript();
    applyLine(state, assistant("old", "claude-opus-5-5", { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    applyLine(state, checkpoint({ "claude-opus-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 1.5 }, "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } }, 1.51));
    expect(spendOf(state)).toMatchObject({ input: 11, output: 21, cacheRead: 30, cacheWrite: 40, costUsd: 1.51, estimated: false });

    applyLine(state, assistant("new", "claude-fable-5-1", { input_tokens: 0, output_tokens: M, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    const spend = spendOf(state)!;
    expect(spend).toMatchObject({ output: 21 + M, estimated: true });
    expect(spend.costUsd).toBeCloseTo(1.51 + 50, 6);
  });

  it("has no price when a model after the checkpoint is unknown, and ignores synthetic messages", () => {
    const state = emptyTranscript();
    applyLine(state, checkpoint({ "claude-opus-5-5": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 } }, 0.5));
    applyLine(state, assistant("s", "<synthetic>", { input_tokens: 999, output_tokens: 0 }));
    expect(spendOf(state)?.costUsd).toBe(0.5);
    applyLine(state, assistant("x", "some-new-model", { input_tokens: 1, output_tokens: 1 }));
    expect(spendOf(state)?.costUsd).toBeUndefined();
  });
});

describe("findLastLine", () => {
  it("finds the start of the last matching line across chunk boundaries", () => {
    const file = path.join(tempConfigDir(), "t.jsonl");
    const filler = `{"type":"user","text":"${"x".repeat(600_000)}"}\n`;
    const marker = '{"type":"cost-state","n":';
    const body = `${marker}1}\n${filler}${marker}2}\n${filler}${filler}{"type":"assistant"}\n`;
    fs.writeFileSync(file, body);
    const expected = body.indexOf(`${marker}2}`);
    expect(findLastLine(file, '"type":"cost-state"', 64 * 1024 * 1024)).toBe(expected);
    expect(findLastLine(file, '"type":"cost-state"', 100)).toBeUndefined();
    expect(findLastLine(file, '"type":"nothing"', 64 * 1024 * 1024)).toBeUndefined();
    expect(findLastLine(path.join(tempConfigDir(), "missing"), "x", 10)).toBeUndefined();
  });

  it("finds a match on the first line of the file", () => {
    const file = path.join(tempConfigDir(), "t.jsonl");
    fs.writeFileSync(file, '{"type":"cost-state"}\n{"type":"user"}\n');
    expect(findLastLine(file, '"type":"cost-state"', 1024)).toBe(0);
  });
});

describe("JsonlTail from an explicit offset", () => {
  it("reads from the given line start, then only what is appended", () => {
    const file = path.join(tempConfigDir(), "t.jsonl");
    fs.writeFileSync(file, "a\nb\nc\n");
    const tail = new JsonlTail(file, { startAt: 2 });
    expect(tail.read()?.lines).toEqual(["b", "c"]);
    fs.appendFileSync(file, "d\n");
    expect(tail.read()?.lines).toEqual(["d"]);
  });
});

describe("ClaudeProvider spend", () => {
  function setup() {
    const configDir = tempConfigDir();
    const proc = new FakeProc();
    return { configDir, proc, provider: new ClaudeProvider(configDir, proc) };
  }
  const usage = (output: number) => ({ input_tokens: 1, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

  it("reads from the agent's last checkpoint even when it lies beyond the usual tail window", () => {
    const { configDir, proc, provider } = setup();
    const id = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: id });
    const file = transcriptPath(configDir, "/work/app", id);
    appendEntries(file, [
      { type: "assistant", message: { id: "before", model: "claude-opus-5-5", usage: usage(M), content: [] } },
      { type: "cost-state", totalCostUSD: 2, modelUsage: { "claude-opus-5-5": { inputTokens: 1, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 2 } } },
      { type: "assistant", message: { id: "after", model: "claude-opus-5-5", usage: usage(1000), content: [] } },
      { type: "user", text: "x".repeat(2 * 1024 * 1024) },
    ]);
    const spend = provider.poll(0)[0]!.spend!;
    expect(spend).toMatchObject({ input: 2, output: 1010, estimated: true, partial: false });
    expect(spend.costUsd).toBeCloseTo(2 + (1 * 4 + 1000 * 20) / M, 6);
  });

  it("reads a small transcript from its start, and marks a large one without a checkpoint partial", () => {
    const { configDir, proc, provider } = setup();
    const small = sessionId(1);
    writeSession(configDir, proc, { pid: 11, sessionId: small });
    appendEntries(transcriptPath(configDir, "/work/app", small), [{ type: "assistant", message: { id: "a", model: "claude-sonnet-5-5", usage: usage(500), content: [] } }]);
    const large = sessionId(2);
    writeSession(configDir, proc, { pid: 12, sessionId: large });
    appendEntries(transcriptPath(configDir, "/work/app", large), [{ type: "user", text: "x".repeat(2 * 1024 * 1024) }, { type: "assistant", message: { id: "b", model: "claude-sonnet-5-5", usage: usage(500), content: [] } }]);
    const byId = new Map(provider.poll(0).map((s) => [s.id, s.spend]));
    expect(byId.get(small)).toMatchObject({ output: 500, partial: false });
    expect(byId.get(large)).toMatchObject({ output: 500, partial: true });
  });
});
