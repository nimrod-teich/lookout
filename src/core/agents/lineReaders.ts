// The agents' readers of their conversation files, by name: the thread that
// reads in the background is handed a name, and finds the reader here.
import * as fs from "node:fs";
import type { Scanner } from "../background";
import { scanFile, tailOf, type LineReader, type Scan, type Scanned } from "../history";
import { readSaved } from "../savedPositions";
import { ConversationStore } from "../store";
import { TRANSCRIPT_LINES } from "./claude/history";
import { ROLLOUT_LINES } from "./codex/history";
import { EVENTS_LINES } from "./copilot/events";

export const LINE_READERS: Readonly<Record<string, LineReader>> = Object.fromEntries([TRANSCRIPT_LINES, ROLLOUT_LINES, EVENTS_LINES].map((reader) => [reader.name!, reader]));

/** The stores opened in this thread, by file: one connection each, kept until `closeStores`; an open that failed is tried again after a moment. */
const stores = new Map<string, { store: ConversationStore | undefined; at: number }>();
const REOPEN_MS = 5000;

function storeAt(file: string): ConversationStore | undefined {
  const held = stores.get(file);
  if (held?.store) return held.store;
  if (held && Date.now() - held.at < REOPEN_MS) return undefined;
  const store = ConversationStore.open(file);
  stores.set(file, { store, at: Date.now() });
  return store;
}

/** Closes the stores this thread opened: on the way out, so the files are free (Windows holds an open one against deletion). */
export function closeStores(): void {
  for (const held of stores.values()) held.store?.close();
  stores.clear();
}

/**
 * What a scan finds, read with the reader it names, from the saved places it
 * names when they still fit, or, with a store, from where the store stopped
 * reading the file; what it finds goes into the store before it is answered.
 */
export function runScan(job: Scan): Scanned | undefined {
  const reader = LINE_READERS[job.reader];
  if (!reader) return undefined;
  const into = job.store;
  const store = into ? storeAt(into.file) : undefined;
  if (into && store) return scanIntoStore(job, reader, store, into.build);
  const saved = job.saved ? readSaved(job.saved.entry, job, job.saved.build) : undefined;
  return scanFile(job.file, reader, job.from, job.identity, saved);
}

/**
 * Reads a file for an index and for the store together. The store's own
 * place in the file (`end`) is where its increment starts, whatever the
 * index asked for: two windows reading the same file never store a line
 * twice, and a window whose index is ahead or behind the store leaves no
 * hole. A first read of a file the store holds goes on from where the store
 * stopped, the held messages coming back from the store with what the file
 * gained, so the index has the whole conversation without the file being
 * read again. A file the store cannot continue (another build read it, the
 * file changed under it, or the index saw another file) is read whole.
 */
function scanIntoStore(job: Scan, reader: LineReader, store: ConversationStore, build: string): Scanned | undefined {
  if (job.lean) return scanLean(job, reader, store, build);
  const held = store.progress(job.file);
  const first = job.from === 0 && job.identity === "";
  const usable = held !== undefined && held.build === build && held.tail !== undefined && fitsStill(job.file, held) && (first || job.identity === held.identity);
  if (!held || !usable) {
    const whole = scanFile(job.file, reader, 0, "");
    if (whole) recordQuietly(store, { ...job, from: 0 }, whole, build);
    return whole;
  }
  // From the earlier of the two places: the store's, and the index's.
  const base = first ? held.end : Math.min(job.from, held.end);
  const scanned = scanFile(job.file, reader, base, held.identity);
  if (!scanned) return undefined;
  if (scanned.reset) {
    recordQuietly(store, { ...job, from: 0 }, scanned, build);
    return scanned;
  }
  const fresh = scanned.lines.filter((line) => line.start >= held.end);
  recordQuietly(store, { ...job, from: held.end }, { ...scanned, lines: fresh }, build);
  if (!first) return { ...scanned, lines: scanned.lines.filter((line) => line.start >= job.from) };
  const messages = store.messages(job.file) ?? [];
  const restored = messages.slice(0, held.messages).map((message) => ({ facts: { message }, start: 0, length: 0 }));
  return { identity: scanned.identity, size: scanned.size, reset: true, end: scanned.end, lines: [...restored, ...fresh], restored: held.end, tail: scanned.tail };
}

/**
 * Reads a file into the store for an index that keeps no messages: from
 * where the store stopped, or whole when the store cannot continue it. The
 * answer carries no lines, only how far the file was read; nothing when the
 * store did not take the read, so the index asks again.
 */
function scanLean(job: Scan, reader: LineReader, store: ConversationStore, build: string): Scanned | undefined {
  const held = store.progress(job.file);
  const usable = held !== undefined && held.build === build && held.tail !== undefined && fitsStill(job.file, held);
  const scanned = usable ? scanFile(job.file, reader, held.end, held.identity) : scanFile(job.file, reader, 0, "");
  if (!scanned) return undefined;
  const from = scanned.reset ? 0 : held!.end;
  let taken: boolean;
  try {
    taken = store.record({ ...job, from }, scanned, build);
  } catch {
    return undefined;
  }
  return taken ? { ...scanned, lines: [] } : undefined;
}

/** Writes a scan into the store; the store is a copy, so a write that fails never stops the read from answering. */
function recordQuietly(store: ConversationStore, job: Pick<Scan, "file" | "reader" | "from">, scanned: Scanned, build: string): void {
  try {
    store.record(job, scanned, build);
  } catch {
    // Tried again at the next read.
  }
}

/** The file is still the one the store read: the same identity, no shorter, with the same bytes before where the store stopped. */
function fitsStill(file: string, held: { identity: string; end: number; tail?: string }): boolean {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.birthtimeMs}` === held.identity && st.size >= held.end && tailOf(file, held.end) === held.tail;
  } catch {
    return false;
  }
}

/** Reads in this thread, one file per turn of the event loop. */
export function inThreadScanner(): Scanner {
  return {
    scan: (job) =>
      new Promise((resolve, reject) => {
        setImmediate(() => {
          try {
            resolve(runScan(job));
          } catch (error) {
            reject(error);
          }
        });
      }),
    dispose: () => {},
  };
}
