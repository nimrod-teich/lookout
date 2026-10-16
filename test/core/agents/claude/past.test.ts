import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PastTranscripts, transcriptInfo, transcriptTitle } from "../../../../src/core/agents/claude/past";
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
    const { transcripts: list, capped } = past.list({ folders: ["/work/app", "/work/svc", "/nowhere"], all: false, limit: 500 }, new Set([sessionId(4)]));
    expect(capped).toBe(false);
    expect(list.map((p) => [p.id, p.title, p.cwd, p.resumable])).toEqual([
      [sessionId(2), "Newer", "/work/app", true],
      [sessionId(3), "In another project", "/work/svc", true],
      [sessionId(1), "Older", "/work/app", true],
    ]);
    expect(list[0]?.file).toBe(b);
    expect(list[2]?.modifiedAt).toBe(old.getTime());
    // A rename appended later is picked up: the title cache is keyed by the file's version.
    appendEntries(a, [{ type: "custom-title", customTitle: "Renamed" }]);
    expect(past.list({ folders: ["/work/app"], all: false, limit: 500 }, new Set()).transcripts.find((p) => p.id === sessionId(1))?.title).toBe("Renamed");
  });

  it("lists every project's transcripts, where each ran and on which branch, the newest up to the limit", () => {
    const dir = tempConfigDir();
    let now = 1_000_000;
    const past = new PastTranscripts(dir, () => now);
    const ages: [string, string, number][] = [
      ["/work/app", sessionId(1), 3],
      ["/work/svc/.claude/worktrees/fix-x", sessionId(2), 2],
      ["/home/u/notes", sessionId(3), 1],
    ];
    for (const [cwd, id, hoursAgo] of ages) {
      const file = transcriptPath(dir, cwd, id);
      appendEntries(file, [
        { type: "user", cwd, gitBranch: "main", message: { content: `work in ${cwd}` } },
        ...Array.from({ length: 200 }, () => ({ type: "progress", data: "x".repeat(400) })),
        { type: "assistant", cwd, gitBranch: hoursAgo === 2 ? "fix-x" : "main", isSidechain: false, message: { content: [] } },
        { type: "assistant", cwd, gitBranch: "subagent-branch", isSidechain: true, message: { content: [] } },
      ]);
      const at = new Date(Date.now() - hoursAgo * 3_600_000);
      fs.utimesSync(file, at, at);
    }
    const { transcripts, capped } = past.list({ folders: [], all: true, limit: 2 }, new Set());
    expect(capped).toBe(true);
    expect(transcripts.map((p) => [p.id, p.cwd, p.branch, p.resumable])).toEqual([
      [sessionId(3), "/home/u/notes", "main", false],
      [sessionId(2), "/work/svc/.claude/worktrees/fix-x", "fix-x", false],
    ]);
    // The window's own folders' sessions are the ones Claude Code resumes in it.
    expect(past.list({ folders: ["/work/app"], all: true, limit: 10 }, new Set()).transcripts.map((p) => [p.id, p.resumable])).toEqual([
      [sessionId(3), false],
      [sessionId(2), false],
      [sessionId(1), true],
    ]);
    // A new project shows once the folders are looked through again, at most every 15 seconds.
    appendEntries(transcriptPath(dir, "/work/new", sessionId(4)), [{ type: "user", cwd: "/work/new", message: { content: "fresh" } }]);
    expect(past.list({ folders: [], all: true, limit: 10 }, new Set()).transcripts).toHaveLength(3);
    now += 15_000;
    expect(past.list({ folders: [], all: true, limit: 10 }, new Set()).transcripts[0]?.id).toBe(sessionId(4));
  });

  it("lists the window's own folders as they are now, among every project's, and as the agent resumes them", () => {
    const dir = tempConfigDir();
    let now = 1_000_000;
    const past = new PastTranscripts(dir, () => now);
    appendEntries(transcriptPath(dir, "/work/svc", sessionId(1)), [{ type: "user", cwd: "/work/svc", message: { content: "Other project" } }]);
    expect(past.list({ folders: ["/work/app"], all: true, limit: 10 }, new Set()).transcripts.map((p) => p.id)).toEqual([sessionId(1)]);
    // A session of the window's folder that ended a moment ago: listed at once, though every project was looked through just now.
    appendEntries(transcriptPath(dir, "/work/app", sessionId(2)), [{ type: "user", cwd: "/work/app", message: { content: "Just ended" } }]);
    now += 1_000;
    expect(past.list({ folders: ["/work/app"], all: true, limit: 10 }, new Set()).transcripts.map((p) => [p.id, p.resumable])).toEqual(
      expect.arrayContaining([
        [sessionId(1), false],
        [sessionId(2), true],
      ]),
    );
  });

  it("shows where a session started when two folders share a project directory", () => {
    const dir = tempConfigDir();
    // "/work/my.app" and "/work/my-app" are both kept in "-work-my-app".
    appendEntries(transcriptPath(dir, "/work/my.app", sessionId(1)), [{ type: "user", cwd: "/work/my.app", message: { content: "In my.app" } }]);
    const [listed] = new PastTranscripts(dir).list({ folders: ["/work/my-app"], all: false, limit: 10 }, new Set()).transcripts;
    // The agent finds it from that window too, so it resumes there.
    expect(listed).toMatchObject({ cwd: "/work/my.app", resumable: true });
  });

  it("fills the limit with conversations, and says when older ones were left out", () => {
    const dir = tempConfigDir();
    const files = [1, 2, 3, 4].map((n) => transcriptPath(dir, "/work/app", sessionId(n)));
    files.forEach((file, i) => {
      // The two newest hold no conversation.
      appendEntries(file, [i >= 2 ? { type: "progress" } : { type: "ai-title", aiTitle: `Session ${i + 1}` }]);
      const at = new Date(Date.now() - (10 - i) * 60_000);
      fs.utimesSync(file, at, at);
    });
    const past = new PastTranscripts(dir);
    expect(past.list({ folders: ["/work/app"], all: false, limit: 2 }, new Set())).toMatchObject({ transcripts: [{ id: sessionId(2) }, { id: sessionId(1) }], capped: false });
    expect(past.list({ folders: ["/work/app"], all: false, limit: 1 }, new Set())).toMatchObject({ transcripts: [{ id: sessionId(2) }], capped: true });
    // Only transcripts without a conversation left out: nothing to say.
    fs.rmSync(files[0]!);
    expect(past.list({ folders: ["/work/app"], all: false, limit: 1 }, new Set())).toMatchObject({ transcripts: [{ id: sessionId(2) }], capped: false });
  });

  it("reads a long history's titles a slice at a time", () => {
    const dir = tempConfigDir();
    for (let i = 1; i <= 130; i++) appendEntries(transcriptPath(dir, "/work/app", sessionId(i)), [{ type: "ai-title", aiTitle: `Session ${i}` }]);
    const past = new PastTranscripts(dir);
    expect(past.list({ folders: ["/work/app"], all: false, limit: 500 }, new Set())).toMatchObject({ incomplete: true, capped: false });
    expect(past.list({ folders: ["/work/app"], all: false, limit: 500 }, new Set()).transcripts).toHaveLength(130);
    expect(past.list({ folders: ["/work/app"], all: false, limit: 500 }, new Set()).incomplete).toBe(false);
  });
});

describe("transcriptInfo", () => {
  it("reads where a session started and the branch it last worked on", () => {
    const file = transcriptPath(tempConfigDir(), "/work/app", sessionId(1));
    appendEntries(file, [
      { type: "summary", summary: "x" },
      { type: "user", cwd: "/work/app", gitBranch: "main", message: { content: "Start" } },
      { type: "user", cwd: "/work/app/sub", gitBranch: "feature", message: { content: "Later" } },
    ]);
    expect(transcriptInfo(file)).toEqual({ title: "Start", cwd: "/work/app", branch: "feature" });
  });

  it("finds the first prompt and an early title past request records, out of reach of the tail", () => {
    const file = transcriptPath(tempConfigDir(), "/work/app", sessionId(1));
    const records = [
      { type: "api-request-shape", body: "x".repeat(90_000) },
      { type: "api-request-blob", body: "y".repeat(40_000) },
    ];
    const later = Array.from({ length: 40 }, () => ({ type: "progress", data: "z".repeat(10_000) }));
    appendEntries(file, [...records, { type: "user", cwd: "/work/app", message: { content: "Tune the retry queue" } }, ...later]);
    expect(transcriptInfo(file)).toMatchObject({ title: "Tune the retry queue", cwd: "/work/app" });
    const titled = transcriptPath(tempConfigDir(), "/work/app", sessionId(2));
    appendEntries(titled, [...records, { type: "user", cwd: "/work/app", message: { content: "Tune the retry queue" } }, { type: "ai-title", aiTitle: "Retry queue tuning" }, ...later]);
    expect(transcriptInfo(titled).title).toBe("Retry queue tuning");
  });

  it("finds the directory past request records that come before it", () => {
    const file = transcriptPath(tempConfigDir(), "/work/app", sessionId(1));
    appendEntries(file, [
      { type: "mode", mode: "default" },
      { type: "api-request-shape", body: "x".repeat(90_000) },
      { type: "api-request-blob", body: "y".repeat(40_000) },
      { type: "user", cwd: "/work/app/sub", isSidechain: true, message: { content: "agent" } },
      { type: "user", cwd: "/work/app", gitBranch: "main", message: { content: "Late start" } },
      { type: "ai-title", aiTitle: "Late directory" },
    ]);
    expect(transcriptInfo(file)).toEqual({ title: "Late directory", cwd: "/work/app", branch: "main" });
  });
});
