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
  const store = job.store ? storeAt(job.store.file) : undefined;
  if (store) return scanIntoStore(job, reader, store, job.store!.build);
  const saved = job.saved ? readSaved(job.saved.entry, job, job.saved.build) : undefined;
  return scanFile(job.file, reader, job.from, job.identity, saved);
}

/**
 * A first read of a file the store holds goes on from where the store
 * stopped, when the file is still the one it read: the messages held come
 * back from the store with what the file gained, so the index has the whole
 * conversation without the file being read again.
 */
function scanIntoStore(job: Scan, reader: LineReader, store: ConversationStore, build: string): Scanned | undefined {
  if (job.from === 0 && job.identity === "") {
    const held = store.progress(job.file);
    if (held && held.build === build && held.tail !== undefined && fitsStill(job.file, held)) {
      const after = scanFile(job.file, reader, held.end, held.identity);
      if (after && !after.reset) {
        try {
          store.record(job, after, build);
          const messages = store.messages(job.file) ?? [];
          const lines = messages.slice(0, held.messages).map((message) => ({ facts: { message }, start: 0, length: 0 }));
          return { identity: after.identity, size: after.size, reset: true, end: after.end, lines: [...lines, ...after.lines], restored: held.end, tail: after.tail };
        } catch {
          // The store is a copy; the file is read whole instead.
        }
      }
    }
  }
  const scanned = scanFile(job.file, reader, job.from, job.identity);
  if (scanned) {
    try {
      store.record(job, scanned, build);
    } catch {
      // The store is a copy; the read still answers.
    }
  }
  return scanned;
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
