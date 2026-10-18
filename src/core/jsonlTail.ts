import * as fs from "node:fs";

const NEWLINE = 0x0a;
/** A line longer than this is skipped instead of buffered. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface TailOptions {
  /** How far before the end the first read starts, when `startAt` is not given. */
  backfillBytes?: number;
  /** Byte offset of a line start to read from on the first read. */
  startAt?: number;
}

/**
 * Offset of the start of the last line containing `needle`, reading the file
 * backwards in chunks, or undefined when none is found within `maxBytes`
 * of the end. The needle must not contain a newline.
 */
export function findLastLine(file: string, needle: string, maxBytes: number): number | undefined {
  let fd: number;
  let size: number;
  try {
    fd = fs.openSync(file, "r");
    size = fs.fstatSync(fd).size;
  } catch {
    return undefined;
  }
  try {
    const chunk = 1024 * 1024;
    let end = size;
    let carry: Buffer = Buffer.alloc(0);
    const stop = Math.max(0, size - maxBytes);
    while (end > stop) {
      const start = Math.max(stop, end - chunk);
      const buffer = Buffer.alloc(end - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const data = Buffer.concat([buffer, carry]);
      // Lines in this window, except the first, which may continue before `start`.
      let lineEnd = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== NEWLINE) continue;
        if (data.subarray(i + 1, lineEnd).includes(needle)) return start + i + 1;
        lineEnd = i;
      }
      if (start === 0 && data.subarray(0, lineEnd).includes(needle)) return 0;
      carry = data.subarray(0, lineEnd);
      end = start;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A search for the lines before `end` that contain any of the needles,
 * reading forward a slice at a time, so a large file is searched over
 * several calls. `end` should be a line start. The needles must not contain
 * a newline.
 */
export class LineSearch {
  private readonly patterns: Buffer[];
  private position = 0;
  /** The unfinished last line of what was read, and where it starts in the file. */
  private carry: Buffer = Buffer.alloc(0);
  private carryAt = 0;
  /** Everything before `end` has been searched. */
  done = false;

  constructor(
    private readonly file: string,
    needles: readonly string[],
    private readonly end: number,
  ) {
    this.patterns = needles.map((needle) => Buffer.from(needle, "utf8"));
    if (end <= 0) this.done = true;
  }

  /** Searches about `maxBytes` more; returns the starts of the lines found, oldest first. */
  step(maxBytes: number): number[] {
    if (this.done) return [];
    let fd: number;
    try {
      fd = fs.openSync(this.file, "r");
    } catch {
      this.done = true;
      return [];
    }
    const starts = new Set<number>();
    try {
      const stop = Math.min(this.end, this.position + Math.max(1, maxBytes));
      while (this.position < stop) {
        const buffer = Buffer.alloc(Math.min(1024 * 1024, stop - this.position));
        const got = fs.readSync(fd, buffer, 0, buffer.length, this.position);
        if (got === 0) {
          this.position = this.end;
          break;
        }
        const data = this.carry.length > 0 ? Buffer.concat([this.carry, buffer.subarray(0, got)]) : buffer.subarray(0, got);
        const dataAt = this.carry.length > 0 ? this.carryAt : this.position;
        const complete = data.lastIndexOf(NEWLINE) + 1;
        this.search(data, dataAt, complete, starts);
        this.carry = Buffer.from(data.subarray(complete));
        this.carryAt = dataAt + complete;
        this.position += got;
        // A line too long to hold is searched as it is and dropped.
        if (this.carry.length > MAX_LINE_BYTES) {
          this.search(this.carry, this.carryAt, this.carry.length, starts);
          this.carry = Buffer.alloc(0);
          this.carryAt = this.position;
        }
      }
      if (this.position >= this.end) {
        this.search(this.carry, this.carryAt, this.carry.length, starts);
        this.carry = Buffer.alloc(0);
        this.done = true;
      }
    } catch {
      this.done = true;
    } finally {
      fs.closeSync(fd);
    }
    return [...starts].sort((a, b) => a - b);
  }

  private search(data: Buffer, dataAt: number, length: number, starts: Set<number>): void {
    for (const pattern of this.patterns) {
      for (let i = data.indexOf(pattern); i >= 0 && i < length; i = data.indexOf(pattern, i + 1)) {
        starts.add(dataAt + (i === 0 ? 0 : data.lastIndexOf(NEWLINE, i - 1) + 1));
      }
    }
  }
}

/** The starts of the lines before `end` that contain any of the needles, oldest first, in one go. */
export function findLines(file: string, needles: readonly string[], end: number): number[] {
  const search = new LineSearch(file, needles, end);
  const starts: number[] = [];
  while (!search.done) starts.push(...search.step(Number.MAX_SAFE_INTEGER));
  return starts;
}

/** The first line start at or after `offset`: `offset` itself when a line starts there, else just past the next newline, or the end of the file. */
export function lineStartAtOrAfter(file: string, offset: number): number {
  if (offset <= 0) return 0;
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return offset;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (offset >= size) return size;
    const chunk = 64 * 1024;
    let position = offset - 1;
    for (;;) {
      const buffer = Buffer.alloc(chunk);
      const got = fs.readSync(fd, buffer, 0, chunk, position);
      if (got === 0) return size;
      const newline = buffer.subarray(0, got).indexOf(NEWLINE);
      if (newline >= 0) return position + newline + 1;
      position += got;
    }
  } catch {
    return offset;
  } finally {
    fs.closeSync(fd);
  }
}

/** The line that starts at `offset`, without its newline, or undefined when it cannot be read or is longer than `maxBytes`. */
export function readLineAt(file: string, offset: number, maxBytes = 1024 * 1024): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const chunk = 64 * 1024;
    const parts: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const buffer = Buffer.alloc(chunk);
      const got = fs.readSync(fd, buffer, 0, chunk, offset + total);
      if (got === 0) break;
      const data = buffer.subarray(0, got);
      const nl = data.indexOf(NEWLINE);
      if (nl >= 0) {
        parts.push(data.subarray(0, nl));
        return Buffer.concat(parts).toString("utf8");
      }
      parts.push(Buffer.from(data));
      total += got;
    }
    return total < maxBytes && total > 0 ? Buffer.concat(parts).toString("utf8") : undefined;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

export interface TailRead {
  /** Complete lines appended since the previous read. */
  lines: string[];
  /** The file was replaced or truncated; earlier lines no longer apply. */
  reset: boolean;
  mtimeMs: number;
}

/**
 * Reads a growing JSONL file incrementally. The first read starts at most
 * `backfillBytes` before the end; later reads return only what was appended.
 */
export class JsonlTail {
  private offset = -1;
  /** Inode and creation time: a replacement file can reuse the inode number. */
  private identity = "";
  private carry: Buffer = Buffer.alloc(0);
  /** The bytes up to the next newline belong to a line whose start was not read. */
  private skipPartial = false;

  private readonly backfillBytes: number;
  private startAt: number | undefined;

  constructor(
    private readonly file: string,
    options: TailOptions | number = {},
  ) {
    const opts = typeof options === "number" ? { backfillBytes: options } : options;
    this.backfillBytes = opts.backfillBytes ?? 1024 * 1024;
    this.startAt = opts.startAt;
  }

  /** null when the file cannot be read. */
  read(): TailRead | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      return null;
    }
    const identity = `${st.ino}:${st.birthtimeMs}`;
    const first = this.offset < 0;
    const reset = !first && (st.size < this.offset || identity !== this.identity);
    if (first || reset) {
      const explicit = first && this.startAt !== undefined && this.startAt <= st.size ? this.startAt : undefined;
      this.offset = explicit ?? Math.max(0, st.size - this.backfillBytes);
      // An explicit start is a line start; a computed one lands mid-line.
      this.skipPartial = explicit === undefined && this.offset > 0;
      this.startAt = undefined;
      this.carry = Buffer.alloc(0);
      this.identity = identity;
    }
    if (st.size === this.offset) return { lines: [], reset, mtimeMs: st.mtimeMs };

    const chunk = Buffer.alloc(st.size - this.offset);
    let got: number;
    try {
      const fd = fs.openSync(this.file, "r");
      try {
        got = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
    this.offset += got;
    let data: Buffer = this.carry.length ? Buffer.concat([this.carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);

    if (this.skipPartial) {
      const nl = data.indexOf(NEWLINE);
      if (nl < 0) return { lines: [], reset, mtimeMs: st.mtimeMs };
      data = data.subarray(nl + 1);
      this.skipPartial = false;
    }
    const last = data.lastIndexOf(NEWLINE);
    if (last < 0) {
      if (data.length > MAX_LINE_BYTES) {
        this.carry = Buffer.alloc(0);
        this.skipPartial = true;
      } else {
        this.carry = data;
      }
      return { lines: [], reset, mtimeMs: st.mtimeMs };
    }
    // Copy the remainder so the chunk it points into can be freed.
    this.carry = Buffer.from(data.subarray(last + 1));
    const lines = data.subarray(0, last).toString("utf8").split("\n");
    return { lines, reset, mtimeMs: st.mtimeMs };
  }
}
