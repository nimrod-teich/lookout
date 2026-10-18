import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { firstPromptOf, PastRollouts, within } from "../../../../src/core/agents/codex/past";
import { ThreadNames } from "../../../../src/core/agents/codex/paths";
import { APPROVAL, ASKED_IN_REPLY, EDITED, homeFile, IDLE, NOW, QUESTION, tempCodexHome, WORKING } from "./fixtures";

const ALL = [IDLE, APPROVAL, WORKING, QUESTION, ASKED_IN_REPLY, EDITED];

function setup() {
  const home = tempCodexHome();
  // Written a minute apart, the idle one last.
  ALL.forEach((id, i) => {
    const at = (NOW - (ALL.length - i) * 60_000 + (id === IDLE ? 10 * 60_000 : 0)) / 1000;
    fs.utimesSync(homeFile(home, id), at, at);
  });
  const past = new PastRollouts(path.join(home, "sessions"), new ThreadNames(path.join(home, "session_index.jsonl")), () => NOW);
  return { home, past };
}

describe("Codex's earlier sessions", () => {
  it("list every project's threads newest first, titled as Codex names them, with the folder each worked in", () => {
    const { past } = setup();
    const list = past.list({ folders: [], all: true, limit: 500 }, new Set());
    expect(list.rollouts.map((r) => [r.id, r.title, r.cwd])).toEqual([
      [IDLE, "Answer 2+2", "/work/a"],
      [EDITED, "Append hello to notes.md", "/work/f"],
      [ASKED_IN_REPLY, "Add hello line to README.md", "/work/d"],
      [QUESTION, "Ask for preferred colour", "/work/e"],
      [WORKING, "Request approval for command", "/work/c"],
      [APPROVAL, "Request approval for touch", "/work/b"],
    ]);
    expect(list).toMatchObject({ capped: false, incomplete: false, compressed: 0 });
    expect(list.rollouts.every((r) => !r.inFolders)).toBe(true);
  });

  it("list only the window's folders' threads, inside them too, without the running ones", () => {
    const { past } = setup();
    const list = past.list({ folders: ["/work/a", "/work"], all: false, limit: 500 }, new Set([EDITED]));
    expect(list.rollouts.map((r) => r.id)).not.toContain(EDITED);
    expect(list.rollouts.find((r) => r.id === IDLE)?.inFolders).toBe(true);
    expect(past.list({ folders: ["/work/b"], all: false, limit: 500 }, new Set()).rollouts.map((r) => r.id)).toEqual([APPROVAL]);
    expect(within("/work/ab", ["/work/a"])).toBe(false);
    expect(within("C:\\work\\a\\src", ["C:/work/a/"])).toBe(true);
  });

  it("hold the newest up to the limit, say when older ones are left out, and find starred ones besides", () => {
    const { past } = setup();
    const list = past.list({ folders: [], all: true, limit: 2, also: [APPROVAL] }, new Set());
    expect(list.rollouts.map((r) => r.id)).toEqual([IDLE, EDITED]);
    expect(list.capped).toBe(true);
    expect(list.also.map((r) => r.id)).toEqual([APPROVAL]);
  });

  it("title a thread Codex has not named by its first prompt, and count compressed rollouts without reading them", () => {
    const { home, past } = setup();
    fs.writeFileSync(path.join(home, "session_index.jsonl"), "");
    fs.writeFileSync(path.join(home, "sessions", "2026", "10", "18", "rollout-2026-10-01T10-00-00-01a10000-0000-7000-8000-000000000000.jsonl.zst"), "zstd");
    const fresh = new PastRollouts(path.join(home, "sessions"), new ThreadNames(path.join(home, "session_index.jsonl")), () => NOW);
    const list = fresh.list({ folders: [], all: true, limit: 500 }, new Set());
    expect(list.rollouts.find((r) => r.id === IDLE)?.title).toBe("What is 2+2? Answer with one word and do not run any comman…");
    expect(list.compressed).toBe(1);
    expect(firstPromptOf(homeFile(home, EDITED))).toBe("Append a line saying hello to notes.md, then show me the file with cat.");
    expect(past.fileOf(IDLE)).toBeUndefined();
  });

  it("read a long history a slice at a time", () => {
    const { home, past } = setup();
    const day = path.join(home, "sessions", "2026", "10", "17");
    fs.mkdirSync(day, { recursive: true });
    const source = fs.readFileSync(homeFile(home, IDLE), "utf8");
    for (let i = 0; i < 130; i++) {
      const id = `01a10000-0000-7000-8000-${String(i).padStart(12, "0")}`;
      const file = path.join(day, `rollout-2026-10-17T10-00-00-${id}.jsonl`);
      fs.writeFileSync(file, source.replace(IDLE, id));
      fs.utimesSync(file, (NOW - 3_600_000 - i) / 1000, (NOW - 3_600_000 - i) / 1000);
    }
    const first = past.list({ folders: [], all: true, limit: 500 }, new Set());
    expect(first.incomplete).toBe(true);
    const second = past.list({ folders: [], all: true, limit: 500 }, new Set());
    expect(second.incomplete).toBe(false);
    expect(second.rollouts).toHaveLength(136);
  });
});
