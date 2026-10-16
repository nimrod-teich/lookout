import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlTail, readLineAt } from "../../src/core/jsonlTail";
import { tempConfigDir } from "./helpers";

function file(): string {
  return path.join(tempConfigDir(), "t.jsonl");
}

describe("JsonlTail", () => {
  it("returns null for a missing file", () => {
    expect(new JsonlTail("/nonexistent/lookout.jsonl").read()).toBeNull();
  });

  it("returns only appended lines after the first read", () => {
    const f = file();
    fs.writeFileSync(f, "a\nb\n");
    const tail = new JsonlTail(f);
    expect(tail.read()?.lines).toEqual(["a", "b"]);
    expect(tail.read()?.lines).toEqual([]);
    fs.appendFileSync(f, "c\n");
    expect(tail.read()).toMatchObject({ lines: ["c"], reset: false });
  });

  it("holds an unfinished line until its newline arrives", () => {
    const f = file();
    fs.writeFileSync(f, "a\npart");
    const tail = new JsonlTail(f);
    expect(tail.read()?.lines).toEqual(["a"]);
    fs.appendFileSync(f, "ial");
    expect(tail.read()?.lines).toEqual([]);
    fs.appendFileSync(f, " line\nnext\n");
    expect(tail.read()?.lines).toEqual(["partial line", "next"]);
  });

  it("keeps a multi-byte character split across two reads intact", () => {
    const f = file();
    const bytes = Buffer.from("שלום\n", "utf8");
    fs.writeFileSync(f, bytes.subarray(0, 3));
    const tail = new JsonlTail(f);
    expect(tail.read()?.lines).toEqual([]);
    fs.appendFileSync(f, bytes.subarray(3));
    expect(tail.read()?.lines).toEqual(["שלום"]);
  });

  it("starts near the end of a large file and drops the line it lands inside", () => {
    const f = file();
    fs.writeFileSync(f, `${"x".repeat(500)}\n${"y".repeat(50)}\nlast\n`);
    const tail = new JsonlTail(f, 30);
    expect(tail.read()?.lines).toEqual(["last"]);
  });

  it("returns a line longer than the backfill window once its end is appended", () => {
    const f = file();
    fs.writeFileSync(f, "head\n");
    const tail = new JsonlTail(f, 16);
    tail.read();
    const long = "z".repeat(200_000);
    fs.appendFileSync(f, `${long}\n`);
    expect(tail.read()?.lines).toEqual([long]);
  });

  it("reports a reset when the file is truncated or replaced", () => {
    const f = file();
    fs.writeFileSync(f, "a\nb\nc\n");
    const tail = new JsonlTail(f);
    tail.read();
    fs.writeFileSync(f, "x\n");
    expect(tail.read()).toMatchObject({ lines: ["x"], reset: true });

    fs.rmSync(f);
    fs.writeFileSync(`${f}.new`, "replaced with a longer body\n");
    fs.renameSync(`${f}.new`, f);
    expect(tail.read()).toMatchObject({ lines: ["replaced with a longer body"], reset: true });
  });
});

describe("readLineAt", () => {
  it("returns the line that starts at an offset, with or without a newline after it", () => {
    const f = file();
    fs.writeFileSync(f, "first\nsecond ünïcode\nlast");
    expect(readLineAt(f, 0)).toBe("first");
    expect(readLineAt(f, 6)).toBe("second ünïcode");
    expect(readLineAt(f, 23)).toBe("last");
  });

  it("gives up on a missing file, an offset past the end, and a line longer than the cap", () => {
    const f = file();
    expect(readLineAt(f, 0)).toBeUndefined();
    fs.writeFileSync(f, `${"x".repeat(300_000)}\nshort\n`);
    expect(readLineAt(f, 300_001)).toBe("short");
    expect(readLineAt(f, 400_000)).toBeUndefined();
    expect(readLineAt(f, 0, 100_000)).toBeUndefined();
    expect(readLineAt(f, 0)).toHaveLength(300_000);
  });
});
