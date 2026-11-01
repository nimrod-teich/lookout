import { Worker } from "node:worker_threads";
import type { Removal, RemoveAsk, RemovedRecord, Survey, SurveyInput, SurveyProgress } from "./worktrees";

/** What the extension asks the worktree thread. */
export type WorktreeAsk =
  | { id: number; op: "survey"; input: SurveyInput }
  | { id: number; op: "remove"; asks: RemoveAsk[]; input: Omit<SurveyInput, "folders" | "repos"> }
  | { id: number; op: "restore"; record: RemovedRecord };

/** What it answers: progress while it works, then one of the results, or the error that stopped it. */
export interface WorktreeAnswer {
  id: number;
  progress?: SurveyProgress;
  survey?: Survey;
  removals?: Removal[];
  /** How much the file systems' free space grew while the removals ran; other writers count too. */
  freeSpaceGrew?: number;
  restored?: { ok: boolean; error?: string };
  error?: string;
}

/** The error an ask rejects with when `stop()` cut it short. */
export const STOPPED = "The check was stopped";

/** Ask with no id: the thread's client numbers each one. */
type Unnumbered<T> = T extends { id: number } ? Omit<T, "id"> : never;

/**
 * Checks, removes and restores worktrees in a thread of its own
 * (`dist/worktreeThread.js`), started on the first ask and stopped when Lookout
 * is. A thread that fails or stops rejects what it was asked, and the next
 * ask starts another.
 */
export class WorktreeWorker {
  private worker: Worker | undefined;
  private next = 0;
  private readonly waiting = new Map<number, { resolve: (answer: WorktreeAnswer) => void; reject: (error: unknown) => void; onProgress?: (progress: SurveyProgress) => void }>();

  constructor(private readonly script: string) {}

  async survey(input: SurveyInput, onProgress?: (progress: SurveyProgress) => void): Promise<Survey> {
    const answer = await this.ask({ op: "survey", input }, onProgress);
    if (!answer.survey) throw new Error("The worktree thread gave no check");
    return answer.survey;
  }

  async remove(asks: RemoveAsk[], input: Omit<SurveyInput, "folders" | "repos">, onProgress?: (progress: SurveyProgress) => void): Promise<{ removals: Removal[]; freeSpaceGrew?: number }> {
    const answer = await this.ask({ op: "remove", asks, input }, onProgress);
    return { removals: answer.removals ?? [], freeSpaceGrew: answer.freeSpaceGrew };
  }

  async restore(record: RemovedRecord): Promise<{ ok: boolean; error?: string }> {
    return (await this.ask({ op: "restore", record })).restored ?? { ok: false, error: "The worktree thread gave no answer" };
  }

  private ask(ask: Unnumbered<WorktreeAsk>, onProgress?: (progress: SurveyProgress) => void): Promise<WorktreeAnswer> {
    return new Promise((resolve, reject) => {
      const worker = this.start();
      const id = ++this.next;
      this.waiting.set(id, { resolve, reject, onProgress });
      worker.postMessage({ ...ask, id });
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.script);
    // A check in flight never keeps the extension host from exiting.
    worker.unref();
    worker.on("message", (answer: WorktreeAnswer) => {
      const waiting = this.waiting.get(answer.id);
      if (!waiting) return;
      if (answer.progress && !answer.survey && !answer.removals) {
        waiting.onProgress?.(answer.progress);
        return;
      }
      this.waiting.delete(answer.id);
      if (answer.error !== undefined) waiting.reject(new Error(answer.error));
      else waiting.resolve(answer);
    });
    // Only the thread in use fails what waits: one stopped earlier exits later, when the next may be at work.
    const fail = (error: unknown) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const waiting of this.waiting.values()) waiting.reject(error);
      this.waiting.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`The worktree thread stopped (exit code ${code})`)));
    this.worker = worker;
    return worker;
  }

  /** Stops the thread and what it was doing: every waiting ask rejects as stopped, and the next ask starts another thread. */
  stop(): void {
    const worker = this.worker;
    this.worker = undefined;
    for (const waiting of this.waiting.values()) waiting.reject(new Error(STOPPED));
    this.waiting.clear();
    void worker?.terminate();
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    for (const waiting of this.waiting.values()) waiting.reject(new Error("Lookout is shutting down"));
    this.waiting.clear();
    void worker?.terminate();
  }
}
