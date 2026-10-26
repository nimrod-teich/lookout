import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findLastLine, JsonlTail, readLineAt, scanLines } from "../../src/core/jsonlTail";
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

describe("findLastLine with a check", () => {
  it("finds the last line with the needle that the check accepts", () => {
    const f = file();
    const big = `{"type":"api-request-shape","body":"${"x".repeat(300_000)}"}\n`;
    const side = '{"cwd":"/work/app/sub","isSidechain":true}\n';
    const main = '{"cwd":"/work/app","isSidechain":false}\n';
    const body = big + side + main + big + main + side;
    fs.writeFileSync(f, body);
    const mainChain = (line: string) => !line.includes('"isSidechain":true');
    expect(findLastLine(f, '"cwd":"', 1024 * 1024)).toBe(body.length - side.length);
    expect(findLastLine(f, '"cwd":"', 1024 * 1024, mainChain)).toBe(body.length - side.length - main.length);
    expect(findLastLine(f, '"cwd":"', 1024 * 1024, () => false)).toBeUndefined();
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

describe("scanLines", () => {
  it("passes the lines in the window that carry a needle, across chunk boundaries, with the last line unterminated", () => {
    const f = file();
    const long = `{"pad":"${"x".repeat(1024 * 1024 - 100)}","mark":"one"}`;
    const lines = ['{"a":1,"mark":"zero"}', long, '{"b":2}', '{"c":3,"mark":"two"}', '{"d":4,"mark":"three"}'];
    const text = lines.join("\n");
    fs.writeFileSync(f, text);
    const seen: string[] = [];
    const mark = (line: string) => (JSON.parse(line) as { mark?: string }).mark ?? line;
    scanLines(f, 0, text.length, ['"mark"'], (line) => seen.push(mark(line)));
    expect(seen).toEqual(["zero", "one", "two", "three"]);
    // A window that starts past the first line and ends before the last.
    const from = lines[0]!.length + 1;
    const to = text.length - lines[4]!.length - 1;
    const inside: string[] = [];
    scanLines(f, from, to, ['"mark"', '"b"'], (line) => inside.push(mark(line)));
    expect(inside).toEqual(["one", '{"b":2}', "two"]);
    const none: string[] = [];
    scanLines(f, 10, 10, ['"mark"'], (line) => none.push(line));
    scanLines("/nonexistent/lookout.jsonl", 0, 100, ['"mark"'], (line) => none.push(line));
    expect(none).toEqual([]);
  });
});
