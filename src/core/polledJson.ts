import * as fs from "node:fs";

/** A file modified this recently is parsed again on every read: a coarse clock can give two rewrites one mtime. */
const SETTLE_MS = 2_000;

/**
 * Reads a JSON file that its writer replaces by rename, so it is polled, not
 * watched: parsed only when it changed. A torn write keeps the last value for
 * a moment; a file that still does not parse once it settled reads as broken.
 */
export class PolledJson<T> {
  private signature = "";
  private last: T;

  constructor(
    readonly file: string,
    private readonly parse: (json: unknown) => T,
    private readonly missing: T,
    private readonly broken: T,
  ) {
    this.last = missing;
  }

  read(): T {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.signature = "";
      return (this.last = this.missing);
    }
    const signature = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const settled = Date.now() - st.mtimeMs > SETTLE_MS;
    if (signature === this.signature && settled) return this.last;
    try {
      this.last = this.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      this.signature = signature;
    } catch {
      // Mid-write: keep the last value until the file settles; after that it is broken.
      if (settled) {
        this.last = this.broken;
        this.signature = signature;
      }
    }
    return this.last;
  }
}
