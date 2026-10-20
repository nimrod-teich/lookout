// The agents' readers of their conversation files, by name: the thread that
// reads in the background is handed a name, and finds the reader here.
import type { Scanner } from "../background";
import { scanFile, type LineReader, type Scan, type Scanned } from "../history";
import { readSaved } from "../savedPositions";
import { TRANSCRIPT_LINES } from "./claude/history";
import { ROLLOUT_LINES } from "./codex/history";
import { EVENTS_LINES } from "./copilot/events";

export const LINE_READERS: Readonly<Record<string, LineReader>> = Object.fromEntries([TRANSCRIPT_LINES, ROLLOUT_LINES, EVENTS_LINES].map((reader) => [reader.name!, reader]));

/** What a scan finds, read with the reader it names, from the saved places it names, when they still fit. */
export function runScan(job: Scan): Scanned | undefined {
  const reader = LINE_READERS[job.reader];
  if (!reader) return undefined;
  const saved = job.saved ? readSaved(job.saved.entry, job, job.saved.build) : undefined;
  return scanFile(job.file, reader, job.from, job.identity, saved);
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
