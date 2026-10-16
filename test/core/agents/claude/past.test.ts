import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PastTranscripts, transcriptTitle } from "../../../../src/core/agents/claude/past";
import { appendEntries, sessionId, tempConfigDir, transcriptPath } from "../../helpers";

describe("transcriptTitle", () => {
  it("prefers a rename over the generated title over the first prompt, and takes the latest stamp", () => {
    const dir = tempConfigDir();
    const file = transcriptPath(dir, "/work/app", sessionId(1));
    appendEntries(file, [
      { type: "user", message: { content: "Fix the cache\nplease" } },
      { type: "ai-title", aiTitle: "Cache fix" },
      ...Array.from({ length: 300 }, () => ({ type: "progress", data: "x".repeat(400) })),
      { type: "ai-title", aiTitle: "Cache fix, resumed" },
      { type: "custom-title", customTitle: "  My   cache  " },
    ]);
    expect(transcriptTitle(file)).toBe("My cache");
    appendEntries(file, [{ type: "custom-title", customTitle: "" }]);
    expect(transcriptTitle(file)).toBe("Cache fix, resumed");
  });

  it("falls back to the first prompt, skipping command echoes, and gives nothing for a transcript without a conversation", () => {
    const dir = tempConfigDir();
    const file = transcriptPath(dir, "/work/app", sessionId(1));
    appendEntries(file, [
      { type: "user", isMeta: true, message: { content: "meta" } },
      { type: "user", message: { content: "<command-name>/help</command-name>" } },
      { type: "user", message: { content: `${"p".repeat(100)} more` } },
    ]);
    expect(transcriptTitle(file)).toBe(`${"p".repeat(79)}…`);
    const empty = transcriptPath(dir, "/work/app", sessionId(2));
    appendEntries(empty, [{ type: "summary", summary: "nothing" }]);
    expect(transcriptTitle(empty)).toBeUndefined();
  });
});

describe("PastTranscripts", () => {
  it("lists the titled transcripts of the given directories, newest first, without the excluded ones", () => {
    const dir = tempConfigDir();
    const a = transcriptPath(dir, "/work/app", sessionId(1));
    const b = transcriptPath(dir, "/work/app", sessionId(2));
    const c = transcriptPath(dir, "/work/svc", sessionId(3));
    const live = transcriptPath(dir, "/work/app", sessionId(4));
    const untitled = transcriptPath(dir, "/work/app", sessionId(5));
    appendEntries(a, [{ type: "ai-title", aiTitle: "Older" }]);
    appendEntries(b, [{ type: "ai-title", aiTitle: "Newer" }]);
    appendEntries(c, [{ type: "user", message: { content: "In another project" } }]);
    appendEntries(live, [{ type: "ai-title", aiTitle: "Running now" }]);
    appendEntries(untitled, [{ type: "progress" }]);
    fs.writeFileSync(transcriptPath(dir, "/work/app", "not-a-session"), "{}\n");
    // Written moments apart, the files could share a timestamp; fix their ages.
    const old = new Date(Date.now() - 86_400_000);
    const middle = new Date(Date.now() - 3_600_000);
    fs.utimesSync(a, old, old);
    fs.utimesSync(c, middle, middle);
    const past = new PastTranscripts(dir);
    const list = past.list(["/work/app", "/work/svc", "/nowhere"], new Set([sessionId(4)]));
    expect(list.map((p) => [p.id, p.title, p.cwd])).toEqual([
      [sessionId(2), "Newer", "/work/app"],
      [sessionId(3), "In another project", "/work/svc"],
      [sessionId(1), "Older", "/work/app"],
    ]);
    expect(list[0]?.file).toBe(b);
    expect(list[2]?.modifiedAt).toBe(old.getTime());
    // A rename appended later is picked up: the title cache is keyed by the file's version.
    appendEntries(a, [{ type: "custom-title", customTitle: "Renamed" }]);
    expect(past.list(["/work/app"], new Set()).find((p) => p.id === sessionId(1))?.title).toBe("Renamed");
  });
});
