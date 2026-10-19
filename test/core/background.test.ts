import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_LINES } from "../../src/core/agents/claude/history";
import { inThreadScanner } from "../../src/core/agents/lineReaders";
import { BackgroundReads, type Scanner } from "../../src/core/background";
import { HistoryIndex, scanFile, type Scan, type Scanned } from "../../src/core/history";
import { SavedPositions } from "../../src/core/savedPositions";
import { WorkerScanner } from "../../src/core/workerScanner";
import { buildReader } from "../readerBundle";
import { appendEntries, tempConfigDir } from "./helpers";

/** A transcript of `n` exchanges. */
function transcript(n: number, words = "billing webhook"): string {
  const file = path.join(tempConfigDir(), `t${n}.jsonl`);
  appendEntries(
    file,
    Array.from({ length: n }, (_, i) => [
      { type: "user", message: { content: `Question ${i} about the ${words}` } },
      { type: "assistant", message: { content: [{ type: "text", text: `Answer ${i}` }] } },
    ]).flat(),
  );
  return file;
}

/** A scanner whose reads finish when the test says so. */
class HeldScanner implements Scanner {
  readonly jobs: Scan[] = [];
  private readonly held: (() => void)[] = [];
  disposed = false;
  scan(job: Scan): Promise<Scanned | undefined> {
    this.jobs.push(job);
    return new Promise((resolve) => this.held.push(() => resolve(scanFile(job.file, TRANSCRIPT_LINES, job.from, job.identity))));
  }
  /** Finishes the oldest read still held. */
  release(): void {
    this.held.shift()?.();
  }
  dispose(): void {
    this.disposed = true;
  }
}

const idle = (background: BackgroundReads) => vi.waitFor(() => expect(background.pending).toBe(0), { timeout: 10_000, interval: 5 });

describe("BackgroundReads", () => {
  it("reads one file at a time, in the order asked, and says when it read some", async () => {
    const scanner = new HeldScanner();
    const onDidRead = vi.fn();
    const background = new BackgroundReads(scanner, onDidRead);
    const [a, b, c] = [transcript(1), transcript(2), transcript(3)].map((file) => new HistoryIndex(file, TRANSCRIPT_LINES));
    for (const index of [a!, b!, c!]) index.update(background);
    // Asked for again while queued: still one read.
    a!.update(background);
    expect(background.pending).toBe(3);
    await vi.waitFor(() => expect(scanner.jobs).toHaveLength(1));
    expect(a!.ready).toBe(false);
    scanner.release();
    await vi.waitFor(() => expect(scanner.jobs).toHaveLength(2));
    expect(a!.messages).toHaveLength(2);
    expect(onDidRead).toHaveBeenCalledTimes(1);
    scanner.release();
    await vi.waitFor(() => expect(scanner.jobs).toHaveLength(3));
    scanner.release();
    await idle(background);
    expect(scanner.jobs.map((job) => path.basename(job.file))).toEqual(["t1.jsonl", "t2.jsonl", "t3.jsonl"]);
    expect([b!, c!].map((index) => index.messages.length)).toEqual([4, 6]);
    // Once nothing is left, the listener hears so, within 200 ms of the last time.
    await vi.waitFor(() => expect(onDidRead.mock.calls.length).toBeGreaterThanOrEqual(2));
    background.dispose();
  });

  it("does not read a file again until it changes, then reads only what it gained", async () => {
    const scanner = new HeldScanner();
    const background = new BackgroundReads(scanner, () => {});
    const file = transcript(1);
    const index = new HistoryIndex(file, TRANSCRIPT_LINES);
    index.update(background);
    await vi.waitFor(() => expect(scanner.jobs).toHaveLength(1));
    scanner.release();
    await idle(background);
    index.update(background);
    expect(background.pending).toBe(0);
    appendEntries(file, [{ type: "assistant", message: { content: [{ type: "text", text: "More on the webhook" }] } }]);
    index.update(background);
    await vi.waitFor(() => expect(scanner.jobs).toHaveLength(2));
    expect(scanner.jobs[1]!.from).toBe(fs.statSync(file).size - Buffer.byteLength(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "More on the webhook" }] } })}\n`));
    scanner.release();
    await idle(background);
    expect(index.messages.map((m) => m.text)).toEqual(["Question 0 about the billing webhook", "Answer 0", "More on the webhook"]);
    background.dispose();
  });

  it("stops for good when the scanner breaks, says why once, and reads nothing more", async () => {
    const broken: Scanner = { scan: vi.fn(() => Promise.reject(new Error("no thread"))), dispose: vi.fn() };
    const onBroken = vi.fn();
    const background = new BackgroundReads(broken, () => {}, onBroken);
    const [a, b] = [transcript(1), transcript(2)].map((file) => new HistoryIndex(file, TRANSCRIPT_LINES));
    a!.update(background);
    b!.update(background);
    await vi.waitFor(() => expect(onBroken).toHaveBeenCalledTimes(1));
    expect(onBroken.mock.calls[0]![0]).toEqual(new Error("no thread"));
    expect(background.broken).toBe(true);
    expect(background.pending).toBe(0);
    expect(broken.scan).toHaveBeenCalledTimes(1);
    expect(broken.dispose).toHaveBeenCalledTimes(1);
    a!.update(background);
    expect(background.pending).toBe(0);
    expect([a!.ready, b!.ready]).toEqual([false, false]);
    background.dispose();
  });

  it("does not read a file it cannot read again until the file changes", async () => {
    // A folder where a conversation file should be: looked at, but never read.
    const folder = path.join(tempConfigDir(), "t.jsonl");
    fs.mkdirSync(folder);
    const scanned: string[] = [];
    const scanner = inThreadScanner();
    const onDidRead = vi.fn();
    const background = new BackgroundReads({ scan: (job) => (scanned.push(job.file), scanner.scan(job)), dispose: () => {} }, onDidRead);
    const index = new HistoryIndex(folder, TRANSCRIPT_LINES);
    index.update(background);
    await idle(background);
    expect(index.ready).toBe(true);
    expect(index.messages).toEqual([]);
    // Every look after it, as a search or the conversation tab makes, finds nothing changed.
    for (let i = 0; i < 5; i++) index.update(background);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scanned).toHaveLength(1);
    expect(onDidRead).toHaveBeenCalledTimes(1);
    background.dispose();
  });

  it("tells the listener at most every 200 ms, and once more after the last read", async () => {
    vi.useFakeTimers();
    try {
      const scanner = new HeldScanner();
      const onDidRead = vi.fn();
      const background = new BackgroundReads(scanner, onDidRead);
      const indexes = [transcript(1), transcript(2), transcript(3)].map((file) => new HistoryIndex(file, TRANSCRIPT_LINES));
      for (const index of indexes) index.update(background);
      const finish = async () => {
        scanner.release();
        await vi.advanceTimersByTimeAsync(0);
      };
      await vi.advanceTimersByTimeAsync(0);
      await finish();
      expect(onDidRead).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      await finish();
      await vi.advanceTimersByTimeAsync(10);
      // The last read, 20 ms after the first: told once more, but not before 200 ms have passed.
      await finish();
      expect(background.pending).toBe(0);
      expect(onDidRead).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(onDidRead).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onDidRead).toHaveBeenCalledTimes(2);
      background.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops reading once disposed", async () => {
    const scanner = new HeldScanner();
    const onDidRead = vi.fn();
    const background = new BackgroundReads(scanner, onDidRead);
    const [a, b] = [transcript(1), transcript(2)].map((file) => new HistoryIndex(file, TRANSCRIPT_LINES));
    a!.update(background);
    b!.update(background);
    await vi.waitFor(() => expect(scanner.jobs).toHaveLength(1));
    background.dispose();
    expect(scanner.disposed).toBe(true);
    scanner.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a!.ready).toBe(false);
    expect(scanner.jobs).toHaveLength(1);
    expect(onDidRead).not.toHaveBeenCalled();
    b!.update(background);
    expect(background.pending).toBe(0);
  });
});

describe("the reading thread", () => {
  const dir = path.dirname(path.dirname(buildReader()));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads a transcript as the extension host would, in a thread of its own", async () => {
    const scanner = new WorkerScanner(path.join(dir, "dist", "reader.js"));
    const file = transcript(3, "deploy");
    try {
      const scanned = await scanner.scan({ file, reader: TRANSCRIPT_LINES.name!, from: 0, identity: "" });
      expect(scanned).toEqual(scanFile(file, TRANSCRIPT_LINES, 0, ""));
      expect(scanned?.lines).toHaveLength(6);
      // A reader it does not know, or a file that is gone: nothing found.
      expect(await scanner.scan({ file, reader: "unknown", from: 0, identity: "" })).toBeUndefined();
      expect(await scanner.scan({ file: `${file}.gone`, reader: TRANSCRIPT_LINES.name!, from: 0, identity: "" })).toBeUndefined();
    } finally {
      scanner.dispose();
    }
  });

  it("reads a conversation from the places a window saved, in a thread of its own", async () => {
    const file = transcript(3, "deploy");
    const whole = new HistoryIndex(file, TRANSCRIPT_LINES);
    whole.refresh();
    const saved = new SavedPositions(path.join(tempConfigDir(), "positions"), "build-1");
    saved.later(whole);
    saved.dispose();
    const scanner = new WorkerScanner(path.join(dir, "dist", "reader.js"));
    try {
      const scanned = await scanner.scan({ file, reader: TRANSCRIPT_LINES.name!, from: 0, identity: "", saved: { entry: saved.entryFile(file), build: "build-1" } });
      expect(scanned?.restored).toBe(fs.statSync(file).size);
      expect(scanned?.lines.map((line) => line.facts.message?.text)).toEqual(whole.messages.map((m) => m.text));
    } finally {
      scanner.dispose();
    }
  });

  it("rejects what it was asked when it cannot start", async () => {
    const scanner = new WorkerScanner(path.join(dir, "dist", "missing.js"));
    await expect(scanner.scan({ file: "x", reader: TRANSCRIPT_LINES.name!, from: 0, identity: "" })).rejects.toBeTruthy();
    scanner.dispose();
  });

  it("feeds the background reads that a search waits on", async () => {
    const background = new BackgroundReads(new WorkerScanner(path.join(dir, "dist", "reader.js")), () => {});
    const index = new HistoryIndex(transcript(2, "deploy"), TRANSCRIPT_LINES);
    index.update(background);
    await idle(background);
    expect(index.search(["deploy"], 5).count).toBe(2);
    background.dispose();
  });
});
