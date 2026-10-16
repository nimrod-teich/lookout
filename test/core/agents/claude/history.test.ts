import { describe, expect, it } from "vitest";
import { messageOf } from "../../../../src/core/agents/claude/history";

const line = (entry: unknown) => JSON.stringify(entry);

describe("messageOf", () => {
  it("takes what the user typed and what the agent said, with the time", () => {
    expect(messageOf(line({ type: "user", timestamp: "2026-10-16T10:00:00Z", message: { content: "Fix the cache" } }))).toEqual({ role: "you", at: Date.parse("2026-10-16T10:00:00Z"), text: "Fix the cache" });
    expect(messageOf(line({ type: "user", message: { content: [{ type: "text", text: "One" }, { type: "text", text: "Two" }] } }))).toEqual({ role: "you", at: undefined, text: "One\nTwo" });
    expect(messageOf(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }, { type: "text", text: " Done. " }] } }))).toEqual({ role: "agent", at: undefined, text: "Done." });
  });

  it("leaves out tool traffic, subagents, meta entries, interrupts and command echoes", () => {
    expect(messageOf(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "cache hit" }] } }))).toBeUndefined();
    expect(messageOf(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "cache.ts" } }] } }))).toBeUndefined();
    expect(messageOf(line({ type: "user", isSidechain: true, message: { content: "cache" } }))).toBeUndefined();
    expect(messageOf(line({ type: "user", isMeta: true, message: { content: "cache" } }))).toBeUndefined();
    expect(messageOf(line({ type: "user", message: { content: "[Request interrupted by user]" } }))).toBeUndefined();
    expect(messageOf(line({ type: "user", message: { content: "<command-name>/help</command-name>" } }))).toBeUndefined();
    expect(messageOf(line({ type: "user", message: { content: "<local-command-stdout>ok</local-command-stdout>" } }))).toBeUndefined();
    expect(messageOf(line({ type: "ai-title", aiTitle: "cache" }))).toBeUndefined();
    expect(messageOf("not json")).toBeUndefined();
  });
});
