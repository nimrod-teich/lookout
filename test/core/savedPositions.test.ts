import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_LINES } from "../../src/core/agents/claude/history";
import { inThreadScanner, runScan } from "../../src/core/agents/lineReaders";
import { BackgroundReads } from "../../src/core/background";
import { HistoryIndex, scanFile, type LineReader, type Places } from "../../src/core/history";
import { readSaved, SavedPositions } from "../../src/core/savedPositions";
import { appendEntries, tempConfigDir } from "./helpers";

const BUILD = "build-1";

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

/** The index of a file read whole, and the places it would save. */
function readWhole(file: string, reader: LineReader = TRANSCRIPT_LINES): { index: HistoryIndex; places: Places } {
  const index = new HistoryIndex(file, reader);
  index.refresh();
  return { index, places: index.places()! };
}

/** A new index for the file, taking in what a scan from the saved places found. */
function restore(file: string, places: Places, reader: LineReader = TRANSCRIPT_LINES): { index: HistoryIndex; restored: number | undefined } {
  const index = new HistoryIndex(file, reader);
  const scanned = scanFile(file, reader, 0, "", places)!;
  index.apply(scanned, { file, reader: reader.name ?? "", from: 0, identity: "" });
  return { index, restored: scanned.restored };
}

/** Writes `text` over the file at `at`, in place: the same file, the same size. */
function overwrite(file: string, at: number, text: string): void {
  const fd = fs.openSync(file, "r+");
  try {
    fs.writeSync(fd, text, at);
  } finally {
    fs.closeSync(fd);
  }
}

describe("the saved places of a conversation", () => {
  it("hold positions only, and give a new window the same messages and paths", () => {
    const file = transcript();
    const { index, places } = readWhole(file);
    expect(JSON.stringify(places)).not.toContain("billing");
    expect(places).toMatchObject({ v: 1, file, reader: "claude-transcript", end: fs.statSync(file).size });
    // Three messages, each a line; the path of the tool call alone, where it is written.
    expect(places.messages).toHaveLength(6);
    expect(places.paths).toHaveLength(2);
    expect(fs.readFileSync(file).subarray(places.paths[0]!, places.paths[0]! + places.paths[1]!).toString()).toBe('"/work/api/Billing.ts"');
    const again = restore(file, places);
    expect(again.restored).toBe(places.end);
    expect(again.index.messages).toEqual(index.messages);
    expect([...again.index.paths].sort()).toEqual([...index.paths].sort());
    expect(again.index.places()).toEqual(places);
  });

  it("read only the lines they name, and what the file gained after them", () => {
    const file = transcript();
    const { places } = readWhole(file);
    appendEntries(file, [{ type: "user", message: { content: "And the export?" } }]);
    const read: string[] = [];
    const counting: LineReader = { ...TRANSCRIPT_LINES, facts: (line) => (read.push(line), TRANSCRIPT_LINES.facts(line)) };
    const restored = scanFile(file, counting, 0, "", places)!;
    // Three messages and the one appended; the tool result and the line of the path are not parsed again.
    expect(read).toHaveLength(4);
    expect(restored.lines.filter((line) => line.facts.message).map((line) => line.facts.message!.text)).toEqual(["Fix the billing webhook", "Reading the handler.", "The billing webhook retries twice.", "And the export?"]);
    expect(restored.end).toBe(fs.statSync(file).size);
  });

  it("are set aside, and the file read whole, when they no longer fit it", () => {
    const file = transcript();
    const { places } = readWhole(file);
    const whole = (changed: Places) => restore(file, changed).restored === undefined;
    // Another file in its place, or one cut short.
    expect(whole({ ...places, identity: "1:2" })).toBe(true);
    expect(whole({ ...places, end: 10 ** 9 })).toBe(true);
    // A message's place one byte off: not where a line starts.
    expect(whole({ ...places, messages: [places.messages[0]! + 1, places.messages[1]!, ...places.messages.slice(2)] })).toBe(true);
    // A path's place one byte off: not where JSON writes a string.
    expect(whole({ ...places, paths: [places.paths[0]! - 1, places.paths[1]!] })).toBe(true);
    // The places still fit: read from them.
    expect(whole(places)).toBe(false);
  });

  it("are set aside when the file was rewritten in place, the same size, before where they end", () => {
    const file = transcript();
    const { places } = readWhole(file);
    const size = fs.statSync(file).size;
    // The last message's words changed in place: every saved place still holds a message, but not the same file.
    const text = fs.readFileSync(file, "utf8");
    overwrite(file, Buffer.byteLength(text.slice(0, text.lastIndexOf("retries twice"))), "retries trice");
    expect(fs.statSync(file).size).toBe(size);
    const again = restore(file, places);
    expect(again.restored).toBeUndefined();
    expect(again.index.messages.at(-1)?.text).toBe("The billing webhook retries trice.");
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
    const { index, places } = readWhole(file, reader);
    expect(places.pathLines).toEqual([0, Buffer.byteLength(JSON.stringify({ patch: "*** Update File: src/a.ts" }))]);
    expect(places.paths).toHaveLength(2);
    const again = restore(file, places, reader);
    expect(again.restored).toBe(places.end);
    expect([...again.index.paths].sort()).toEqual([...index.paths].sort());
  });

  it("are read back only when they are for that file, reader and build, and well formed", () => {
    const file = transcript();
    const entry = { ...readWhole(file).places, build: BUILD };
    const dir = tempConfigDir();
    const at = (name: string, value: unknown) => {
      const full = path.join(dir, name);
      fs.writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value));
      return full;
    };
    const job = { file, reader: "claude-transcript" };
    expect(readSaved(at("good.json", entry), job, BUILD)).toEqual(entry);
    expect(readSaved(at("good.json", entry), job, "build-2")).toBeUndefined();
    expect(readSaved(at("other-file.json", { ...entry, file: "/elsewhere.jsonl" }), job, BUILD)).toBeUndefined();
    expect(readSaved(at("other-reader.json", { ...entry, reader: "codex-rollout" }), job, BUILD)).toBeUndefined();
    expect(readSaved(at("version.json", { ...entry, v: 2 }), job, BUILD)).toBeUndefined();
    expect(readSaved(at("no-tail.json", { ...entry, tail: undefined }), job, BUILD)).toBeUndefined();
    expect(readSaved(at("odd.json", { ...entry, messages: [1, 2, 3] }), job, BUILD)).toBeUndefined();
    expect(readSaved(at("past-end.json", { ...entry, messages: [entry.end - 1, 10] }), job, BUILD)).toBeUndefined();
    expect(readSaved(at("empty-line.json", { ...entry, paths: [0, 0] }), job, BUILD)).toBeUndefined();
    expect(readSaved(at("not-json.json", "{"), job, BUILD)).toBeUndefined();
    expect(readSaved(path.join(dir, "missing.json"), job, BUILD)).toBeUndefined();
  });
});

describe("SavedPositions", () => {
  it("saves a conversation's places with its build shortly after it changed, and before the window goes away, whole", async () => {
    vi.useFakeTimers();
    try {
      const dir = path.join(tempConfigDir(), "positions");
      const saved = new SavedPositions(dir, BUILD);
      const file = transcript();
      const { index, places } = readWhole(file);
      saved.later(index);
      expect(fs.existsSync(dir)).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(fs.existsSync(saved.entryFile(file))).toBe(true));
      expect(JSON.parse(fs.readFileSync(saved.entryFile(file), "utf8"))).toEqual({ ...places, build: BUILD });
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

  it("clears the entries of conversations that are gone, those of another build, and saves left half done long ago", async () => {
    const dir = path.join(tempConfigDir(), "positions");
    const saved = new SavedPositions(dir, BUILD);
    const kept = transcript();
    const gone = path.join(path.dirname(kept), "gone.jsonl");
    const other = path.join(path.dirname(kept), "other.jsonl");
    fs.copyFileSync(kept, other);
    const entry = { ...readWhole(kept).places, build: BUILD };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(saved.entryFile(kept), JSON.stringify(entry));
    fs.writeFileSync(saved.entryFile(gone), JSON.stringify({ ...entry, file: gone }));
    fs.writeFileSync(saved.entryFile(other), JSON.stringify({ ...entry, file: other, build: "build-0" }));
    fs.writeFileSync(path.join(dir, "broken.json"), "{");
    fs.writeFileSync(path.join(dir, "old.json.123.1.tmp"), "{");
    fs.writeFileSync(path.join(dir, "fresh.json.456.1.tmp"), "{");
    const hoursAgo = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(path.join(dir, "old.json.123.1.tmp"), hoursAgo, hoursAgo);
    await saved.prune();
    expect(fs.readdirSync(dir).sort()).toEqual([path.basename(saved.entryFile(kept)), "fresh.json.456.1.tmp"].sort());
  });
});

describe("reading in the background from the saved places", () => {
  it("reads a conversation never read from its saved places, and saves again only what moved", async () => {
    const dir = path.join(tempConfigDir(), "positions");
    const file = transcript();
    const first = new SavedPositions(dir, BUILD);
    first.later(readWhole(file).index);
    first.dispose();
    const saved = new SavedPositions(dir, BUILD);
    const later = vi.spyOn(saved, "later");
    const jobs: string[] = [];
    const scanner = inThreadScanner();
    const background = new BackgroundReads({ scan: (job) => (jobs.push(job.saved?.entry ?? ""), scanner.scan(job)), dispose: () => {} }, () => {}, undefined, saved);
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

  it("reads from the saved places the job names, of its build only, in any thread", () => {
    const dir = path.join(tempConfigDir(), "positions");
    const file = transcript();
    const saved = new SavedPositions(dir, BUILD);
    saved.later(readWhole(file).index);
    saved.dispose();
    const entry = saved.entryFile(file);
    expect(runScan({ file, reader: "claude-transcript", from: 0, identity: "", saved: { entry, build: BUILD } })?.restored).toBe(fs.statSync(file).size);
    expect(runScan({ file, reader: "claude-transcript", from: 0, identity: "", saved: { entry, build: "build-2" } })?.restored).toBeUndefined();
    expect(runScan({ file, reader: "claude-transcript", from: 0, identity: "", saved: { entry: path.join(dir, "none.json"), build: BUILD } })?.restored).toBeUndefined();
    expect(runScan({ file, reader: "nobody", from: 0, identity: "" })).toBeUndefined();
  });
});
