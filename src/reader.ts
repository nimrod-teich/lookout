// The thread the search reads conversation files in (`dist/reader.js`), so
// VS Code's extension host never waits on a large transcript.
import { parentPort } from "node:worker_threads";
import { LINE_READERS } from "./core/agents/lineReaders";
import { scanFile, type Scan } from "./core/history";
import type { ScanAnswer } from "./core/workerScanner";

parentPort?.on("message", ({ id, job }: { id: number; job: Scan }) => {
  const reader = LINE_READERS[job.reader];
  const answer: ScanAnswer = { id, scanned: reader ? scanFile(job.file, reader, job.from, job.identity) : undefined };
  parentPort!.postMessage(answer);
});
