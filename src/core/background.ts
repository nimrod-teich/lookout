// Reading the conversation files away from VS Code's extension host, which
// every extension in the window shares, Claude Code's included: one file at
// a time, in the order asked for, the results taken in as each one is done.
import type { HistoryIndex, Scan, Scanned } from "./history";

/** Reads conversation files somewhere other than the caller's thread. */
export interface Scanner {
  /** What the file gained since `job.from`; nothing when it cannot be read. Rejects when the scanner itself broke. */
  scan(job: Scan): Promise<Scanned | undefined>;
  dispose(): void;
}

/** While files are read, `onDidRead` fires at most this often; and once more when the last one is done. */
const NOTIFY_MS = 200;

export class BackgroundReads {
  /** Waiting to be read, in the order asked for. */
  private readonly queue = new Set<HistoryIndex>();
  private current: HistoryIndex | undefined;
  private draining = false;
  private disposed = false;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyMissed = false;

  constructor(
    private scanner: Scanner,
    /** Some files were read: a search may find more. */
    private readonly onDidRead: () => void,
    /** Takes over for good when the scanner breaks. */
    private readonly fallback: () => Scanner,
    /** The scanner broke, and why. */
    private readonly onFallback?: (error: unknown) => void,
  ) {}

  /** The index waits to be read, or is being read. */
  has(index: HistoryIndex): boolean {
    return this.current === index || this.queue.has(index);
  }

  /** How many files wait to be read, or are being read. */
  get pending(): number {
    return this.queue.size + (this.current ? 1 : 0);
  }

  /** Reads what the index's file gained, after the files asked for before it. */
  read(index: HistoryIndex): void {
    if (this.disposed || this.has(index)) return;
    this.queue.add(index);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const next = this.queue.values().next();
        if (next.done || this.disposed) return;
        const index = next.value;
        this.queue.delete(index);
        this.current = index;
        const job = index.scan();
        const scanned = job ? await this.scan(job) : undefined;
        this.current = undefined;
        if (this.disposed) return;
        if (job && scanned) index.apply(scanned, job);
        this.notify();
      }
    } finally {
      this.draining = false;
      this.current = undefined;
    }
  }

  private async scan(job: Scan): Promise<Scanned | undefined> {
    try {
      return await this.scanner.scan(job);
    } catch (error) {
      if (this.disposed) return undefined;
      this.onFallback?.(error);
      this.scanner.dispose();
      this.scanner = this.fallback();
      return this.scanner.scan(job).catch(() => undefined);
    }
  }

  /** Tells the listener, at most every `NOTIFY_MS` while reading, and right away once nothing is left. */
  private notify(): void {
    if (this.pending === 0) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
      this.notifyMissed = false;
      this.onDidRead();
      return;
    }
    if (this.notifyTimer) {
      this.notifyMissed = true;
      return;
    }
    this.onDidRead();
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      if (this.notifyMissed && !this.disposed) {
        this.notifyMissed = false;
        this.onDidRead();
      }
    }, NOTIFY_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.queue.clear();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
    this.scanner.dispose();
  }
}
