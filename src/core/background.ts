// Reading the conversation files away from VS Code's extension host, which
// every extension in the window shares, Claude Code's included: one file at
// a time, in the order asked for, the results taken in as each one is done.
import type { HistoryIndex, Scan, Scanned } from "./history";
import type { SavedPositions } from "./savedPositions";

/** Reads conversation files somewhere other than the caller's thread. */
export interface Scanner {
  /** What the file gained since `job.from`; nothing when it cannot be read. Rejects when the scanner itself broke. */
  scan(job: Scan): Promise<Scanned | undefined>;
  dispose(): void;
}

/** `onDidRead` fires at most this often, and always once more after the last file read. */
const NOTIFY_MS = 200;

export class BackgroundReads {
  /** Waiting to be read, in the order asked for. */
  private readonly queue = new Set<HistoryIndex>();
  private current: HistoryIndex | undefined;
  private draining = false;
  private disposed = false;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private notifiedAt = -Infinity;
  /** The scanner broke: nothing more is read here. */
  private brokenBy: unknown;

  constructor(
    private readonly scanner: Scanner,
    /** Some files were read: a search may find more. */
    private readonly onDidRead: () => void,
    /** The scanner broke, and why: the owner reads some other way from now on. */
    private readonly onBroken?: (error: unknown) => void,
    /** Where the places of the messages are kept for the next window, and read from by this one. */
    private readonly saved?: SavedPositions,
  ) {}

  /** The scanner broke, and nothing more is read here. */
  get broken(): boolean {
    return this.brokenBy !== undefined;
  }

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
    if (this.disposed || this.broken || this.has(index)) return;
    this.queue.add(index);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const next = this.queue.values().next();
        if (next.done || this.disposed || this.broken) return;
        const index = next.value;
        this.queue.delete(index);
        this.current = index;
        const job = index.scan();
        // A file never read: from where a window saved its messages' places, when one did.
        if (job && this.saved && job.from === 0 && job.identity === "") job.saved = { entry: this.saved.entryFile(job.file), build: this.saved.build };
        const scanned = job ? await this.scan(job) : undefined;
        this.current = undefined;
        if (this.disposed) return;
        if (job && scanned && index.apply(scanned, job) && moved(scanned)) this.saved?.later(index);
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
      // Whatever broke it (a thread out of memory on a file, a bundle that does not load), it is not tried again:
      // the owner goes back to reading the way it did without one.
      this.brokenBy = error ?? new Error("The scanner failed");
      this.queue.clear();
      this.scanner.dispose();
      this.onBroken?.(this.brokenBy);
      return undefined;
    }
  }

  /** Tells the listener at once, unless it was told less than `NOTIFY_MS` ago: then when that time is up, once for all reads meanwhile. */
  private notify(): void {
    if (this.notifyTimer || this.disposed) return;
    const wait = this.notifiedAt + NOTIFY_MS - Date.now();
    if (wait <= 0) {
      this.fire();
      return;
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.fire();
    }, wait);
  }

  private fire(): void {
    if (this.disposed) return;
    this.notifiedAt = Date.now();
    this.onDidRead();
  }

  dispose(): void {
    this.disposed = true;
    this.queue.clear();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
    this.scanner.dispose();
    this.saved?.dispose();
  }
}

/** The scan took the index further than what was saved of it. */
function moved(scanned: Scanned): boolean {
  return scanned.restored === undefined ? scanned.reset || scanned.lines.length > 0 : scanned.end > scanned.restored;
}
