import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_LINES } from "../../src/core/agents/claude/history";
import { inThreadScanner, runScan } from "../../src/core/agents/lineReaders";
import { BackgroundReads } from "../../src/core/background";
import { HistoryIndex, scanFile, type LineReader, type SavedEntry } from "../../src/core/history";
import { readSaved, SavedPositions } from "../../src/core/savedPositions";
import { appendEntries, tempConfigDir } from "./helpers";

/** A transcript with a message, a tool call naming a path, a tool result and a reply naming another, as Claude Code writes them. */
function transcript(): string {
  const file = path.join(tempConfigDir(), "t.jsonl");
  appendEntries(file, [
    { type: "user", message: { content: "Fix the billing webhook" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/api/Billing.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(5_000) }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Reading the handler." }, { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "retry" } }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "The billing webhook retries twice." }] } },
  ]);
  return file;
}

/** The index of a file read whole, and what it would save. */
function readWhole(file: string, reader: LineReader = TRANSCRIPT_LINES): { index: HistoryIndex; entry: SavedEntry } {
  const index = new HistoryIndex(file, reader);
  index.refresh();
  return { index, entry: index.savedEntry()! };
}

describe("the saved places of a conversation", () => {
  it("hold positions only, and give a new window the same messages and paths", () => {
    const file = transcript();
    const { index, entry } = readWhole(file);
    expect(JSON.stringify(entry)).not.toContain("billing");
    expect(entry).toMatchObject({ v: 1, file, reader: "claude-transcript", end: fs.statSync(file).size });
    // Three messages, each a line; the path of the tool call alone, where it is written.
    expect(entry.messages).toHaveLength(6);
    expect(entry.paths).toHaveLength(2);
    expect(fs.readFileSync(file).subarray(entry.paths[0]!, entry.paths[0]! + entry.paths[1]!).toString()).toBe('"/work/api/Billing.ts"');
    const restored = scanFile(file, TRANSCRIPT_LINES, 0, "", entry)!;
    expect(restored.restored).toBe(entry.end);
    const again = new HistoryIndex(file, TRANSCRIPT_LINES);
    again.apply(restored, { file, reader: "claude-transcript", from: 0, identity: "" });
    expect(again.messages).toEqual(index.messages);
    expect([...again.paths].sort()).toEqual([...index.paths].sort());
    expect(again.savedEntry()).toEqual(entry);
  });

  it("read only the lines they name, and what the file gained after them", () => {
    const file = transcript();
    const { entry } = readWhole(file);
    appendEntries(file, [{ type: "user", message: { content: "And the export?" } }]);
    const read: string[] = [];
    const counting: LineReader = { ...TRANSCRIPT_LINES, facts: (line) => (read.push(line), TRANSCRIPT_LINES.facts(line)) };
    const restored = scanFile(file, counting, 0, "", entry)!;
    // Three messages and the one appended; the tool result, the path's line and the line of the path are not parsed again.
    expect(read).toHaveLength(4);
    expect(restored.lines.filter((line) => line.facts.message).map((line) => line.facts.message!.text)).toEqual(["Fix the billing webhook", "Reading the handler.", "The billing webhook retries twice.", "And the export?"]);
    expect(restored.end).toBe(fs.statSync(file).size);
  });

  it("are set aside, and the file read whole, when they no longer fit it", () => {
    const file = transcript();
    const { entry } = readWhole(file);
    // Rewritten in place, its lines moved: the saved places point into other lines.
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, `${JSON.stringify({ type: "ai-title", aiTitle: "Billing" })}\n${text}`.slice(0, text.length + 40));
    const scanned = scanFile(file, TRANSCRIPT_LINES, 0, "", { ...entry, identity: `${fs.statSync(file).ino}:${fs.statSync(file).birthtimeMs}` })!;
    expect(scanned.restored).toBeUndefined();
    expect(scanned.lines.filter((line) => line.facts.message)).toHaveLength(3);
    // Another file in its place, or one cut short: read whole too.
    expect(scanFile(file, TRANSCRIPT_LINES, 0, "", { ...entry, identity: "1:2" })?.restored).toBeUndefined();
    expect(scanFile(file, TRANSCRIPT_LINES, 0, "", { ...entry, end: 10 ** 9 })?.restored).toBeUndefined();
  });

  it("keep a whole line for paths that are not written as plain strings", () => {
    const file = path.join(tempConfigDir(), "p.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ patch: "*** Update File: src/a.ts" })}\n${JSON.stringify({ path: "src/b.ts" })}\n`);
    const reader: LineReader = {
      name: "test",
      mayHold: () => true,
      facts: (line) => {
        const e = JSON.parse(line) as { patch?: string; path?: string };
        return { paths: [e.patch ? e.patch.replace("*** Update File: ", "") : e.path!] };
      },
    };
    const { index, entry } = readWhole(file, reader);
    expect(entry.pathLines).toEqual([0, Buffer.byteLength(JSON.stringify({ patch: "*** Update File: src/a.ts" }))]);
    expect(entry.paths).toHaveLength(2);
    const again = new HistoryIndex(file, reader);
    again.apply(scanFile(file, reader, 0, "", entry)!, { file, reader: "test", from: 0, identity: "" });
    expect([...again.paths].sort()).toEqual([...index.paths].sort());
  });

  it("are read back only when they are for that file and reader, and well formed", () => {
    const file = transcript();
    const { entry } = readWhole(file);
    const dir = tempConfigDir();
    const at = (name: string, value: unknown) => {
      const full = path.join(dir, name);
      fs.writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value));
      return full;
    };
    const job = { file, reader: "claude-transcript" };
    expect(readSaved(at("good.json", entry), job)).toEqual(entry);
    expect(readSaved(at("other-file.json", { ...entry, file: "/elsewhere.jsonl" }), job)).toBeUndefined();
    expect(readSaved(at("other-reader.json", { ...entry, reader: "codex-rollout" }), job)).toBeUndefined();
    expect(readSaved(at("version.json", { ...entry, v: 2 }), job)).toBeUndefined();
    expect(readSaved(at("odd.json", { ...entry, messages: [1, 2, 3] }), job)).toBeUndefined();
    expect(readSaved(at("past-end.json", { ...entry, messages: [entry.end - 1, 10] }), job)).toBeUndefined();
    expect(readSaved(at("empty-line.json", { ...entry, paths: [0, 0] }), job)).toBeUndefined();
    expect(readSaved(at("not-json.json", "{"), job)).toBeUndefined();
    expect(readSaved(path.join(dir, "missing.json"), job)).toBeUndefined();
  });
});

describe("SavedPositions", () => {
  it("saves a conversation's places shortly after it changed, and before the window goes away, whole", async () => {
    vi.useFakeTimers();
    try {
      const dir = path.join(tempConfigDir(), "positions");
      const saved = new SavedPositions(dir);
      const file = transcript();
      const { index, entry } = readWhole(file);
      saved.later(index);
      expect(fs.existsSync(dir)).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(fs.existsSync(saved.entryFile(file))).toBe(true));
      expect(JSON.parse(fs.readFileSync(saved.entryFile(file), "utf8"))).toEqual(entry);
      // Not a half-written file in sight.
      expect(fs.readdirSync(dir)).toEqual([path.basename(saved.entryFile(file))]);
      appendEntries(file, [{ type: "user", message: { content: "One more" } }]);
      index.refresh();
      saved.later(index);
      saved.dispose();
      expect(JSON.parse(fs.readFileSync(saved.entryFile(file), "utf8")).messages).toHaveLength(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the entries of conversations that are gone, and saves left half done long ago", async () => {
    const dir = path.join(tempConfigDir(), "positions");
    const saved = new SavedPositions(dir);
    const kept = transcript();
    const gone = path.join(path.dirname(kept), "gone.jsonl");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(saved.entryFile(kept), JSON.stringify(readWhole(kept).entry));
    fs.writeFileSync(saved.entryFile(gone), JSON.stringify({ ...readWhole(kept).entry, file: gone }));
    fs.writeFileSync(path.join(dir, "broken.json"), "{");
    fs.writeFileSync(path.join(dir, "old.json.123.tmp"), "{");
    fs.writeFileSync(path.join(dir, "fresh.json.456.tmp"), "{");
    const hourAgo = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(path.join(dir, "old.json.123.tmp"), hourAgo, hourAgo);
    await saved.prune();
    expect(fs.readdirSync(dir).sort()).toEqual([path.basename(saved.entryFile(kept)), "fresh.json.456.tmp"].sort());
  });
});

describe("reading in the background from the saved places", () => {
  it("reads a conversation never read from its saved places, and saves again only what moved", async () => {
    const dir = path.join(tempConfigDir(), "positions");
    const file = transcript();
    const first = new SavedPositions(dir);
    first.later(readWhole(file).index);
    first.dispose();
    const saved = new SavedPositions(dir);
    const later = vi.spyOn(saved, "later");
    const jobs: string[] = [];
    const scanner = inThreadScanner();
    const background = new BackgroundReads({ scan: (job) => (jobs.push(job.saved ?? ""), scanner.scan(job)), dispose: () => {} }, () => {}, undefined, saved);
    const index = new HistoryIndex(file, TRANSCRIPT_LINES);
    index.update(background);
    await vi.waitFor(() => expect(background.pending).toBe(0));
    expect(jobs).toEqual([saved.entryFile(file)]);
    expect(index.messages).toHaveLength(3);
    // Nothing new beyond the saved places: nothing to save.
    expect(later).not.toHaveBeenCalled();
    appendEntries(file, [{ type: "user", message: { content: "And the export?" } }]);
    index.update(background);
    await vi.waitFor(() => expect(background.pending).toBe(0));
    // Read on from where it stood, not from the saved places.
    expect(jobs).toEqual([saved.entryFile(file), ""]);
    expect(later).toHaveBeenCalledWith(index);
    background.dispose();
    expect(JSON.parse(fs.readFileSync(saved.entryFile(file), "utf8")).messages).toHaveLength(8);
  });

  it("reads from the saved places the job names, in any thread", () => {
    const dir = path.join(tempConfigDir(), "positions");
    const file = transcript();
    const saved = new SavedPositions(dir);
    saved.later(readWhole(file).index);
    saved.dispose();
    expect(runScan({ file, reader: "claude-transcript", from: 0, identity: "", saved: saved.entryFile(file) })?.restored).toBe(fs.statSync(file).size);
    expect(runScan({ file, reader: "claude-transcript", from: 0, identity: "", saved: path.join(dir, "none.json") })?.restored).toBeUndefined();
    expect(runScan({ file, reader: "nobody", from: 0, identity: "" })).toBeUndefined();
  });
});
