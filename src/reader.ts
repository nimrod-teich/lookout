// The thread the search reads conversation files in (`dist/reader.js`), so
// VS Code's extension host never waits on a large transcript.
import { parentPort } from "node:worker_threads";
import { runScan } from "./core/agents/lineReaders";
import type { Scan } from "./core/history";
import type { ScanAnswer } from "./core/workerScanner";

parentPort?.on("message", ({ id, job }: { id: number; job: Scan }) => {
  const answer: ScanAnswer = { id, scanned: runScan(job) };
  parentPort!.postMessage(answer);
});
