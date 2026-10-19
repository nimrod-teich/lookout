import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { JumpMailbox, MAIL_TTL_MS } from "../../src/core/jumpMailbox";
import { tempConfigDir } from "./helpers";

const T = 1_800_000_000_000;

function setup() {
  const dir = path.join(tempConfigDir(), "windows");
  return { dir, a: new JumpMailbox(dir), b: new JumpMailbox(dir) };
}

describe("JumpMailbox", () => {
  it("delivers a request to the window it names, once, oldest first", () => {
    const { dir, a, b } = setup();
    expect(a.send(200, { sessionId: "s2", fromPid: 100 }, T + 5)).toBe(`jump-200-${T + 5}.json`);
    expect(a.send(200, { sessionId: "s1", fromPid: 100 }, T)).toBe(`jump-200-${T}.json`);
    expect(a.send(300, { sessionId: "s3", fromPid: 100 }, T)).toBe(`jump-300-${T}.json`);
    expect(fs.readdirSync(dir).sort()).toEqual([`jump-200-${T + 5}.json`, `jump-200-${T}.json`, `jump-300-${T}.json`].sort());
    expect(b.takeRequests(200, T + 10)).toEqual([
      { sessionId: "s1", fromPid: 100, at: T },
      { sessionId: "s2", fromPid: 100, at: T + 5 },
    ]);
    expect(b.takeRequests(200, T + 10)).toEqual([]);
    // Another window's mail stays where it is.
    expect(fs.readdirSync(dir)).toEqual([`jump-300-${T}.json`]);
  });

  it("returns the answer to the window that asked", () => {
    const { a, b } = setup();
    b.reply(100, { sessionId: "s1", fromPid: 200, found: true, raised: false }, T);
    expect(a.takeRequests(100, T)).toEqual([]);
    expect(a.takeReplies(100, T + 1)).toEqual([{ sessionId: "s1", fromPid: 200, found: true, raised: false, at: T }]);
    expect(a.takeReplies(100, T + 1)).toEqual([]);
  });

  it("delivers a note that sessions were seen to the window that hosts them, once", () => {
    const { dir, a, b } = setup();
    expect(a.sendSeen(200, { ids: ["s1", "s2"], fromPid: 100 }, T)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([`seen-200-${T}.json`]);
    expect(b.takeRequests(200, T + 1)).toEqual([]);
    expect(b.takeSeen(100, T + 1)).toEqual([]);
    expect(b.takeSeen(200, T + 1)).toEqual([{ ids: ["s1", "s2"], fromPid: 100, at: T }]);
    expect(b.takeSeen(200, T + 1)).toEqual([]);
    a.sendSeen(200, { ids: ["old"], fromPid: 100 }, T);
    expect(b.takeSeen(200, T + MAIL_TTL_MS + 1)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("ignores and removes mail older than ten seconds, whoever it is for", () => {
    const { dir, a, b } = setup();
    a.send(200, { sessionId: "old", fromPid: 100 }, T);
    a.send(300, { sessionId: "old elsewhere", fromPid: 100 }, T);
    b.reply(400, { sessionId: "old answer", fromPid: 200, found: false, raised: false }, T);
    a.send(200, { sessionId: "new", fromPid: 100 }, T + MAIL_TTL_MS);
    expect(b.takeRequests(200, T + MAIL_TTL_MS + 1).map((r) => r.sessionId)).toEqual(["new"]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("lets the sender take back a letter nobody took, and the receiver drop requests older than it acts on", () => {
    const { dir, a, b } = setup();
    const letter = a.send(200, { sessionId: "late", fromPid: 100 }, T)!;
    a.withdraw(letter);
    a.withdraw(letter);
    expect(fs.readdirSync(dir)).toEqual([]);
    a.send(200, { sessionId: "stale", fromPid: 100 }, T);
    a.send(200, { sessionId: "fresh", fromPid: 100 }, T + 2_500);
    expect(b.takeRequests(200, T + 3_000, 2_000).map((r) => r.sessionId)).toEqual(["fresh"]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("goes on with the rest of the mail when an expired letter cannot be removed", () => {
    const { dir, a, b } = setup();
    fs.mkdirSync(path.join(dir, `jump-200-${T}.json`), { recursive: true });
    a.send(200, { sessionId: "new", fromPid: 100 }, T + MAIL_TTL_MS);
    expect(b.takeRequests(200, T + MAIL_TTL_MS + 1).map((r) => r.sessionId)).toEqual(["new"]);
  });

  it("gives two letters sent in the same millisecond their own files", () => {
    const { a, b } = setup();
    a.send(200, { sessionId: "first", fromPid: 100 }, T);
    a.send(200, { sessionId: "second", fromPid: 100 }, T);
    expect(b.takeRequests(200, T + 1).map((r) => r.sessionId)).toEqual(["first", "second"]);
  });

  it("leaves a letter that does not parse for the next look, and drops it once it is old", () => {
    const { dir, b } = setup();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `jump-200-${T}.json`), '{"sessionId":"s1"');
    fs.writeFileSync(path.join(dir, `jump-200-${T + 1}.json`), '{"sessionId":7,"fromPid":"x"}');
    fs.writeFileSync(path.join(dir, "200.json"), '{"pid":200,"label":"a window record"}');
    expect(b.takeRequests(200, T + 2)).toEqual([]);
    // The one that did not parse waits; the one that parsed into nothing was taken.
    expect(fs.readdirSync(dir).sort()).toEqual(["200.json", `jump-200-${T}.json`]);
    expect(b.takeRequests(200, T + MAIL_TTL_MS + 1)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(["200.json"]);
  });

  it("works without its directory", () => {
    const dir = path.join(tempConfigDir(), "missing");
    const box = new JumpMailbox(dir);
    expect(box.takeRequests(1, T)).toEqual([]);
    expect(box.send(2, { sessionId: "s", fromPid: 1 }, T)).toBe(`jump-2-${T}.json`);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
