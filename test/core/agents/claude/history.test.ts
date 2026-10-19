import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { factsOf, mayHoldFacts, messageOf } from "../../../../src/core/agents/claude/history";

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

describe("factsOf", () => {
  it("takes the paths the tool calls worked on, with the agent's words beside them", () => {
    const calls = [
      { type: "text", text: "Reading both." },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/api/src/cache.ts", limit: 40 } },
      { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "retryAfter", path: "/work/api/src" } },
      { type: "tool_use", id: "t3", name: "NotebookEdit", input: { notebook_path: "/work/api/rates.ipynb", new_source: "x = 1" } },
      { type: "tool_use", id: "t4", name: "Bash", input: { command: "cat /etc/hosts" } },
    ];
    expect(factsOf(line({ type: "assistant", message: { content: calls } }))).toEqual({
      message: { role: "agent", at: undefined, text: "Reading both." },
      paths: ["/work/api/src/cache.ts", "/work/api/src", "retryAfter", "/work/api/rates.ipynb"],
    });
    expect(factsOf(line({ type: "assistant", message: { content: [calls[1]] } }))).toEqual({ paths: ["/work/api/src/cache.ts"] });
  });

  it("does not read paths out of tool results, subagents' calls, or what you typed", () => {
    expect(factsOf(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"file_path":"/etc/passwd"}' }] }] } }))).toBeUndefined();
    expect(factsOf(line({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/work/api/a.ts" } }] } }))).toBeUndefined();
    expect(factsOf(line({ type: "user", message: { content: "look at file_path /work/api/a.ts" } }))).toEqual({ message: { role: "you", at: undefined, text: "look at file_path /work/api/a.ts" } });
    expect(factsOf(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "  " } }] } }))).toBeUndefined();
  });
});

describe("mayHoldFacts", () => {
  const holds = (entry: unknown) => mayHoldFacts(Buffer.from(line(entry)));

  it("rules out on the bytes the lines that hold no message and no path", () => {
    expect(holds({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "4 KB of a file" }] } })).toBe(false);
    expect(holds({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Let me see", signature: "c2ln" }] } })).toBe(false);
    expect(holds({ type: "assistant", message: { content: [{ type: "redacted_thinking", data: "ZW5j" }] } })).toBe(false);
    expect(holds({ type: "assistant", message: { content: [] } })).toBe(false);
    expect(holds({ type: "api-request", body: { messages: [{ role: "user", content: "Fix the cache" }] } })).toBe(false);
    expect(holds({ type: "attachment", attachment: { type: "file", content: "the whole file" } })).toBe(false);
    expect(holds({ type: "ai-title", aiTitle: "Fix the cache" })).toBe(false);
    // A command names no path.
    expect(holds({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls /work/api" } }] } })).toBe(false);
  });

  it("lets through what you wrote, and replies with words or tool calls", () => {
    expect(holds({ type: "user", message: { content: "Fix the cache" } })).toBe(true);
    expect(holds({ type: "user", message: { content: [{ type: "text", text: "Fix the cache" }] } })).toBe(true);
    expect(holds({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Done" }] } })).toBe(true);
    for (const input of [{ file_path: "/a.ts" }, { path: "/work" }, { pattern: "*.ts" }, { notebook_path: "/n.ipynb" }]) {
      expect(holds({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Tool", input }] } })).toBe(true);
    }
    expect(holds({ type: "assistant", message: { content: "Done" } })).toBe(true);
  });

  it("never rules out a line factsOf takes something from, in any fixture transcript", () => {
    const dir = path.join(__dirname, "../../../fixtures/claude/transcripts");
    let taken = 0;
    for (const name of fs.readdirSync(dir)) {
      for (const text of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
        if (text === "" || factsOf(text) === undefined) continue;
        taken++;
        expect(mayHoldFacts(Buffer.from(text)), `${name}: ${text.slice(0, 80)}`).toBe(true);
      }
    }
    expect(taken).toBeGreaterThan(10);
  });
});
