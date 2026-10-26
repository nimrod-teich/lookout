import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRANSCRIPT_LINES, toolFactsOf as claudeTools } from "../../src/core/agents/claude/history";
import { toolFactsOf as codexTools } from "../../src/core/agents/codex/history";
import { toolFactsOf as copilotTools } from "../../src/core/agents/copilot/events";
import { closeStores, runScan } from "../../src/core/agents/lineReaders";
import { HistoryIndex, readThroughStore, scanFile, toolText } from "../../src/core/history";
import { searchWithStore } from "../../src/core/search";
import { loadSqlite } from "../../src/core/sqlite";
import { ConversationStore } from "../../src/core/store";
import { parseQuery } from "../../src/core/terms";
import { appendEntries, tempConfigDir } from "./helpers";

const sqlite = loadSqlite() !== undefined;
const BUILD = "build-1";
const AT = Date.UTC(2026, 9, 26, 12);
const iso = (ms: number) => new Date(ms).toISOString();

describe("toolText", () => {
  it("keeps a short text whole, a long one by its first and last 2 KB, and nothing of a blank one", () => {
    expect(toolText("  npm test \n")).toBe("npm test");
    const long = `${"a".repeat(3000)}MIDDLE${"z".repeat(3000)}`;
    const kept = toolText(long)!;
    expect(kept.startsWith("a".repeat(2048))).toBe(true);
    expect(kept.endsWith("z".repeat(2048))).toBe(true);
    expect(kept).toContain(" … ");
    expect(kept).not.toContain("MIDDLE");
    expect(toolText(" \n ")).toBeUndefined();
  });
});

describe("the agents' tool readers", () => {
  it("reads a Claude call's command or input with its name, and a result's text, main chain only", () => {
    const call = JSON.stringify({ type: "assistant", timestamp: iso(AT), message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run migrate -- --env staging" } }, { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/w/a.ts" } }] } });
    expect(claudeTools(call)).toEqual([
      { name: "Bash", text: "npm run migrate -- --env staging", at: AT },
      { name: "Read", text: '{"file_path":"/w/a.ts"}', at: AT },
    ]);
    const result = JSON.stringify({ type: "user", timestamp: iso(AT), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Error: relation \"billing_events\" does not exist" }, { type: "image" }] }] } });
    expect(claudeTools(result)).toEqual([{ text: 'Error: relation "billing_events" does not exist', at: AT }]);
    expect(claudeTools(JSON.stringify({ type: "user", isSidechain: true, message: { content: [{ type: "tool_result", content: "a subagent's" }] } }))).toBeUndefined();
    expect(claudeTools(JSON.stringify({ type: "user", message: { content: "a prompt" } }))).toBeUndefined();
    expect(TRANSCRIPT_LINES.tools!.mayHold(Buffer.from(result))).toBe(true);
    expect(TRANSCRIPT_LINES.tools!.mayHold(Buffer.from('{"type":"user","message":{"content":"hi"}}'))).toBe(false);
  });

  it("reads a Codex call's input or arguments with its name, and an output's text", () => {
    const custom = JSON.stringify({ timestamp: iso(AT), type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "cat notes.md" } });
    const fn = JSON.stringify({ timestamp: iso(AT), type: "response_item", payload: { type: "function_call", name: "wait", arguments: '{"cell_id":"1"}' } });
    const out = JSON.stringify({ timestamp: iso(AT), type: "response_item", payload: { type: "function_call_output", output: [{ type: "input_text", text: "Script failed" }, { type: "input_text", text: "exec_command failed" }] } });
    expect(codexTools(custom)).toEqual([{ name: "exec", text: "cat notes.md", at: AT }]);
    expect(codexTools(fn)).toEqual([{ name: "wait", text: '{"cell_id":"1"}', at: AT }]);
    expect(codexTools(out)).toEqual([{ text: "Script failed\nexec_command failed", at: AT }]);
    expect(codexTools(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user" } }))).toBeUndefined();
  });

  it("reads a Copilot call's command with its tool, and a completion's result or error", () => {
    const start = JSON.stringify({ type: "tool.execution_start", timestamp: iso(AT), data: { toolName: "bash", arguments: { command: "touch a.txt", description: "x" } } });
    const done = JSON.stringify({ type: "tool.execution_complete", timestamp: iso(AT), data: { success: true, result: { content: "exit code 0" } } });
    const failed = JSON.stringify({ type: "tool.execution_complete", data: { success: false, error: { message: "permission denied" } } });
    expect(copilotTools(start)).toEqual([{ name: "bash", text: "touch a.txt", at: AT }]);
    expect(copilotTools(done)).toEqual([{ text: "exit code 0", at: AT }]);
    expect(copilotTools(failed)).toEqual([{ text: "permission denied" }]);
  });
});

/** A transcript with a prompt, a Bash call, its failing result, and a reply. */
function transcript(name = "t.jsonl"): string {
  const file = path.join(tempConfigDir(), name);
  appendEntries(file, [
    { type: "user", timestamp: iso(AT), message: { content: "migrate the staging database" } },
    { type: "assistant", timestamp: iso(AT + 1000), message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run migrate -- --env staging" } }] } },
    { type: "user", timestamp: iso(AT + 2000), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: 'ERROR: relation "billing_events" does not exist' }] } },
    { type: "assistant", timestamp: iso(AT + 3000), message: { content: [{ type: "text", text: "The migration failed; the table is missing." }] } },
  ]);
  return file;
}

describe.skipIf(!sqlite)("tool output in the store", () => {
  let store: ConversationStore;
  /** The store as the index, reading tool output or not, as the controller sets it. */
  const through = (tools: boolean) => readThroughStore({ scan: runScan, store: { file: store.file, build: BUILD }, messages: (file) => store.messages(file), tools });

  beforeEach(() => {
    readThroughStore(undefined);
    store = ConversationStore.open(path.join(tempConfigDir(), "history.sqlite"))!;
  });
  afterEach(() => {
    readThroughStore(undefined);
    closeStores();
    store.close();
  });

  const conversation = (id: string, index: HistoryIndex) => ({ id, cwd: "/w", file: index.file, index: () => index });

  it("keeps none while the setting is off: the error string is not found", () => {
    through(false);
    const index = new HistoryIndex(transcript(), TRANSCRIPT_LINES);
    const found = searchWithStore([conversation("a", index)], parseQuery("billing_events", AT), 3, 1000, undefined, undefined, store);
    expect(found.results).toEqual([]);
    expect(store.toolCount()).toBe(0);
    expect(store.progress(index.file)?.tools).toBe(false);
  });

  it("keeps them when on: a command or an error finds its session, at the message it follows, after the messages", () => {
    through(true);
    const index = new HistoryIndex(transcript(), TRANSCRIPT_LINES);
    const query = (q: string) => searchWithStore([conversation("a", index)], parseQuery(q, AT), 3, 1000, undefined, undefined, store).results;
    const error = query("billing_events");
    expect(error.map((r) => [r.id, r.count, r.hits.map((h) => [h.role, h.index])])).toEqual([["a", 1, [["tool", 0]]]]);
    expect(error[0]!.hits[0]!.snippet).toContain('relation "billing_events" does not exist');
    expect(query("migrate").map((r) => r.hits.map((h) => h.role))).toEqual([["you", "tool"]]);
    expect(query("migrate")[0]!.hits[1]!.snippet).toContain("Bash: npm run migrate");
    expect(store.toolCount()).toBe(2);
    expect(store.progress(index.file)?.tools).toBe(true);
  });

  it("reads a file held without tool output again for it once the setting is on, and lets its rows go once it is off", () => {
    through(false);
    const index = new HistoryIndex(transcript(), TRANSCRIPT_LINES);
    index.refresh();
    expect(index.ready).toBe(true);
    // On: the index is behind, and its next read takes the file again, whole, with its tool output.
    through(true);
    expect(index.ready).toBe(false);
    expect(index.changed()).toBe(true);
    index.refresh();
    expect(index.ready).toBe(true);
    expect(store.toolCount()).toBe(2);
    expect(store.messages(index.file)?.length).toBe(2);
    // Off: the next read lets them go, and the messages stay.
    through(false);
    expect(index.changed()).toBe(true);
    index.refresh();
    expect(store.toolCount()).toBe(0);
    expect(store.progress(index.file)?.tools).toBe(false);
    expect(store.messages(index.file)?.length).toBe(2);
  });

  it("never keeps a session's tool output past the purge, nor past a forget, and lets every one go at once", () => {
    through(true);
    const gone = new HistoryIndex(transcript("gone.jsonl"), TRANSCRIPT_LINES);
    const stays = new HistoryIndex(transcript("stays.jsonl"), TRANSCRIPT_LINES);
    gone.refresh();
    stays.refresh();
    store.rememberSession({ id: "gone", agent: "claude-code", file: gone.file, title: "gone", cwd: "/w" });
    store.rememberSession({ id: "stays", agent: "claude-code", file: stays.file, title: "stays", cwd: "/w" });
    expect(store.toolCount()).toBe(4);
    fs.rmSync(gone.file);
    expect(store.sweep(AT).purged).toEqual(["gone"]);
    // The purged session's conversation stays; its tool output does not.
    expect(store.messages(gone.file)?.length).toBe(2);
    expect(store.toolCount()).toBe(2);
    store.dropTools();
    expect(store.toolCount()).toBe(0);
    expect(store.progress(stays.file)?.tools).toBe(false);
  });

  it("opens a database an earlier build made, adding the column that says a file was read with its tool output", () => {
    const old = path.join(tempConfigDir(), "old.sqlite");
    const { DatabaseSync } = loadSqlite()!;
    const db = new DatabaseSync(old);
    db.exec("CREATE TABLE files (file TEXT PRIMARY KEY, reader TEXT NOT NULL, identity TEXT NOT NULL, end INTEGER NOT NULL, tail TEXT, messages INTEGER NOT NULL DEFAULT 0, build TEXT NOT NULL)");
    db.exec("INSERT INTO files VALUES ('/w/a.jsonl', 'claude-transcript', '1:1', 10, 'x', 2, 'build-0')");
    db.close();
    const reopened = ConversationStore.open(old)!;
    try {
      expect(reopened.progress("/w/a.jsonl")).toMatchObject({ end: 10, tools: false });
      const file = transcript("a.jsonl");
      expect(reopened.record({ file, reader: TRANSCRIPT_LINES.name!, from: 0 }, scanFile(file, TRANSCRIPT_LINES, 0, "", undefined, true)!, BUILD, true)).toBe(true);
      expect(reopened.toolCount()).toBe(2);
    } finally {
      reopened.close();
    }
  });
});
