import { Worker } from "node:worker_threads";
import type { Scanner } from "./background";
import type { Scan, Scanned } from "./history";

/** What the reading thread answers: the job's number and what it found. */
export interface ScanAnswer {
  id: number;
  scanned?: Scanned;
}

/**
 * Reads conversation files in a thread of its own (`dist/reader.js`),
 * started on the first read. A thread that fails to start or stops rejects
 * what it was asked, and the next read starts another.
 */
export class WorkerScanner implements Scanner {
  private worker: Worker | undefined;
  private next = 0;
  private readonly waiting = new Map<number, { resolve: (scanned: Scanned | undefined) => void; reject: (error: unknown) => void }>();

  constructor(private readonly script: string) {}

  scan(job: Scan): Promise<Scanned | undefined> {
    return new Promise((resolve, reject) => {
      const worker = this.start();
      const id = ++this.next;
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, job });
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.script);
    // A read in flight never keeps the extension host from exiting.
    worker.unref();
    worker.on("message", (answer: ScanAnswer) => {
      const waiting = this.waiting.get(answer.id);
      if (!waiting) return;
      this.waiting.delete(answer.id);
      waiting.resolve(answer.scanned);
    });
    const fail = (error: unknown) => {
      if (this.worker === worker) this.worker = undefined;
      for (const waiting of this.waiting.values()) waiting.reject(error);
      this.waiting.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`The reading thread stopped (exit code ${code})`)));
    this.worker = worker;
    return worker;
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    for (const waiting of this.waiting.values()) waiting.reject(new Error("Lookout is shutting down"));
    this.waiting.clear();
    void worker?.terminate();
  }
}
