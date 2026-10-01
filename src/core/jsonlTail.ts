import * as fs from "node:fs";

const NEWLINE = 0x0a;
/** A line longer than this is skipped instead of buffered. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

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

  constructor(
    private readonly file: string,
    private readonly backfillBytes = 1024 * 1024,
  ) {}

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
      this.offset = Math.max(0, st.size - this.backfillBytes);
      this.skipPartial = this.offset > 0;
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
