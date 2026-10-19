// The agents' readers of their conversation files, by name: the thread that
// reads in the background is handed a name, and finds the reader here.
import type { Scanner } from "../background";
import { scanFile, type LineReader } from "../history";
import { TRANSCRIPT_LINES } from "./claude/history";
import { ROLLOUT_LINES } from "./codex/history";
import { EVENTS_LINES } from "./copilot/events";

export const LINE_READERS: Readonly<Record<string, LineReader>> = Object.fromEntries([TRANSCRIPT_LINES, ROLLOUT_LINES, EVENTS_LINES].map((reader) => [reader.name!, reader]));

/** Reads in this thread, one file per turn of the event loop. */
export function inThreadScanner(): Scanner {
  return {
    scan: (job) =>
      new Promise((resolve, reject) => {
        setImmediate(() => {
          try {
            const reader = LINE_READERS[job.reader];
            resolve(reader ? scanFile(job.file, reader, job.from, job.identity) : undefined);
          } catch (error) {
            reject(error);
          }
        });
      }),
    dispose: () => {},
  };
}
