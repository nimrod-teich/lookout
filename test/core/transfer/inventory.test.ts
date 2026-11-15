import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSqlite } from "../../../src/core/sqlite";
import { estimate, headCwd, select, takeInventory, type InventoryItem } from "../../../src/core/transfer/inventory";
import { encodeProjectDir } from "../../../src/core/agents/claude/paths";
import { sessionId, tempConfigDir } from "../helpers";
import { buildMachine, DAY, NOW, S, type Machine } from "./machine";

// Key derivation, compression and SQLite at real sizes: slower runners need more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const sqlite = loadSqlite() !== undefined;
const sha1 = (id: string) => crypto.createHash("sha1").update(id).digest("hex");

let machine: Machine | undefined;

afterEach(() => {
  machine?.store?.close();
  machine = undefined;
  vi.restoreAllMocks();
});

function build(): Machine {
  machine = buildMachine();
  return machine;
}

function brief(item: InventoryItem): string {
  return `${item.dir ?? "-"} ${item.rel}`;
}

describe.skipIf(!sqlite)("takeInventory", () => {
  it("lists every session's files and Lookout's own, in the order a backup writes them, and nothing else", async () => {
    const m = build();
    const inventory = await takeInventory(m.sources);
    const app = m.folderOf(m.repo);
    const tools = m.folderOf(m.tools);
    expect(inventory.items.map(brief)).toEqual([
      "- history.sqlite",
      // Grouped by repository, then folder, oldest first; each transcript followed by its subagents and its tool outputs.
      `work -gone-place/${S.lost}.jsonl`,
      `default ${app}/${S.placeless}.jsonl`,
      `default ${app}/${S.orphan}/subagents/agent-o1.jsonl`,
      `default ${app}/${S.app}.jsonl`,
      `default ${app}/${S.app}/subagents/agent-a1.jsonl`,
      `default ${app}/${S.app}/tool-results/deep/toolu_2.txt`,
      `default ${app}/${S.app}/tool-results/toolu_1.txt`,
      // A kept transcript right after its session's own files, where the compressed stream stores a hard link's copy for next to nothing.
      `- ${sha1(S.app)}.json`,
      `- ${sha1(S.app)}.jsonl`,
      `default ${m.folderOf(m.worktree)}/${S.worktree}.jsonl`,
      `default ${tools}/${S.moved}.jsonl`,
      `default ${tools}/${S.resumed}.jsonl`,
      "- alerts/five-hour-90",
      "- refresh/hold-default",
      "- removed.json",
    ]);
    const byRel = new Map(inventory.items.map((item) => [item.rel, item]));
    expect(byRel.get(`${app}/${S.app}.jsonl`)).toEqual({
      section: "transcripts",
      kind: "transcript",
      dir: "default",
      rel: `${app}/${S.app}.jsonl`,
      abs: m.transcript(S.app),
      sessionId: S.app,
      cwd: m.repo,
      repo: "app",
      lastActive: NOW - 2 * DAY,
      size: fs.statSync(m.transcript(S.app)).size,
    });
    // A session's subagents and tool outputs carry its place, repository and time.
    expect(byRel.get(`${app}/${S.app}/subagents/agent-a1.jsonl`)).toMatchObject({ section: "subagents", kind: "subagent", sessionId: S.app, cwd: m.repo, repo: "app", lastActive: NOW - 2 * DAY });
    expect(byRel.get(`${app}/${S.app}/tool-results/toolu_1.txt`)).toMatchObject({ section: "toolResults", kind: "tool-result", sessionId: S.app, size: 11 });
    expect(byRel.get(`${sha1(S.app)}.jsonl`)).toMatchObject({ section: "vault", kind: "vault", sessionId: S.app });
    expect(byRel.get("history.sqlite")).toMatchObject({ section: "history", kind: "history", abs: m.storeFile });
    expect(byRel.get("removed.json")).toMatchObject({ section: "worktreesLog", kind: "removed-worktrees" });
    expect(byRel.get("alerts/five-hour-90")).toMatchObject({ section: "usage", kind: "usage", size: 0 });
  });

  it("finds each session's place and repository: the history database first, the transcript's head else, worktrees under their repository", async () => {
    const m = build();
    const inventory = await takeInventory(m.sources);
    const transcriptOf = (id: string) => inventory.items.find((item) => item.kind === "transcript" && item.sessionId === id) ?? inventory.items.find((item) => item.sessionId === id)!;
    const place = (id: string) => [transcriptOf(id).cwd, transcriptOf(id).repo];
    // The head's first main-chain place, past a line without one and a subagent's line.
    expect(place(S.app)).toEqual([m.repo, "app"]);
    // The history database's place, in a worktree: the repository's name.
    expect(place(S.worktree)).toEqual([m.worktree, "app"]);
    // The database's place is not what the folder is named after; the head's is.
    expect(place(S.resumed)).toEqual([m.tools, "tools"]);
    // Neither is: the database's names the repository, and the files keep their folder.
    expect(place(S.moved)).toEqual([undefined, "moved"]);
    // No place at all: the folder's repository, from another session there; else the folder's name.
    expect(place(S.placeless)).toEqual([undefined, "app"]);
    expect(place(S.orphan)).toEqual([undefined, "app"]);
    expect(place(S.lost)).toEqual([undefined, "-gone-place"]);
    // Folders without a transcript are as old as their newest file.
    expect(transcriptOf(S.orphan).lastActive).toBe(NOW - 50 * DAY);
  });

  it("knows a long place's folder by the name Claude Code cuts it to, whichever of its builds hashed it", async () => {
    const m = build();
    const long = path.join(m.root, "repos", "x".repeat(120), "y".repeat(120));
    const projects = path.join(m.dirs[0]!.resolved, "projects");
    const [cut, other] = [sessionId(20), sessionId(21)] as [string, string];
    const write = (folder: string, id: string) => {
      fs.mkdirSync(path.join(projects, folder), { recursive: true });
      fs.writeFileSync(path.join(projects, folder, `${id}.jsonl`), JSON.stringify({ type: "user", cwd: long, message: { content: "hi" } }) + "\n");
    };
    expect(encodeProjectDir(long).length).toBeGreaterThan(200);
    write(encodeProjectDir(long), cut);
    write(`${encodeProjectDir(long).slice(0, 200)}-12345`, other);
    const inventory = await takeInventory(m.sources);
    const cwdOf = (id: string) => inventory.items.find((item) => item.kind === "transcript" && item.sessionId === id)?.cwd;
    expect(cwdOf(cut)).toBe(long);
    expect(cwdOf(other)).toBe(long);
  });

  it("totals each section, sums the repositories, and carries the notes, the light state and the tabs", async () => {
    const m = build();
    const inventory = await takeInventory(m.sources);
    const bytes = (items: InventoryItem[]) => items.reduce((sum, item) => sum + item.size, 0);
    const of = (section: string) => inventory.items.filter((item) => item.section === section);
    expect(inventory.totals.transcripts).toEqual({ count: 6, bytes: bytes(of("transcripts")) });
    expect(inventory.totals.subagents.count).toBe(2);
    expect(inventory.totals.toolResults.count).toBe(2);
    expect(inventory.totals.vault.count).toBe(2);
    expect(inventory.totals.usage).toEqual({ count: 2, bytes: 3 });
    expect(inventory.totals.worktreesLog.count).toBe(1);
    expect(inventory.totals.history).toEqual({ count: 1, bytes: fs.statSync(m.storeFile).size });
    expect(inventory.totals.notes.count).toBe(1);
    expect(inventory.totals.state.count).toBe(2);
    expect(inventory.totals.tabs.count).toBe(1);
    expect(inventory.notes.map((record) => [record.id, record.notes?.[0]?.text])).toEqual([[S.app, "Remember the flaky test"]]);
    expect(inventory.state).toEqual({ "lookout.favourites": [S.app], "lookout.sort": "recent" });
    expect(inventory.tabs).toBe(m.sources.tabs);
    expect(inventory.claudeDirs).toBe(m.sources.claudeDirs);
    expect(inventory.takenAt).toBe(NOW);
    const session = (section: string, repo: string) => bytes(inventory.items.filter((item) => item.section === section && item.repo === repo));
    const repoBytes = (repo: string) => session("transcripts", repo) + session("subagents", repo) + session("toolResults", repo);
    expect(inventory.repos).toEqual(
      [
        { repo: "app", sessions: 4, bytes: repoBytes("app") },
        { repo: "tools", sessions: 1, bytes: repoBytes("tools") },
        { repo: "moved", sessions: 1, bytes: repoBytes("moved") },
        { repo: "-gone-place", sessions: 1, bytes: repoBytes("-gone-place") },
      ].sort((a, b) => b.bytes - a.bytes || (a.repo < b.repo ? -1 : 1)),
    );
  });

  it("takes an empty machine as nothing to back up", async () => {
    const root = tempConfigDir();
    const inventory = await takeInventory({
      claudeDirs: [{ dir: root, resolved: root, label: "default", isDefault: true }],
      storeFile: path.join(root, "none", "history.sqlite"),
      recordsDir: path.join(root, "none", "sessions"),
      vaultDir: path.join(root, "none", "vault"),
      usageDir: path.join(root, "none", "usage"),
      removedWorktreesFile: path.join(root, "none", "removed.json"),
      state: {},
      tabs: [],
      now: NOW,
    });
    expect(inventory.items).toEqual([]);
    expect(inventory.repos).toEqual([]);
    expect(Object.values(inventory.totals).every((total) => total.count === 0)).toBe(true);
  });
});

describe.skipIf(!sqlite)("select", () => {
  it("takes the chosen sections; the age and repository filters hold the sessions, their subagents and tool outputs following the transcript", async () => {
    const m = build();
    const inventory = await takeInventory(m.sources);
    const ids = (items: InventoryItem[]) => [...new Set(items.map((item) => item.sessionId ?? item.kind))];
    const sessions = ["transcripts", "subagents", "toolResults"] as const;
    expect(select(inventory, { sections: ["transcripts"] }).every((item) => item.section === "transcripts")).toBe(true);
    expect(select(inventory, { sections: [] })).toEqual([]);
    // Within 30 days: the subagent written 200 days ago goes with its session's transcript of 2 days ago; the orphan's folder, 50 days old, does not.
    const recent = select(inventory, { sections: [...sessions, "vault"], activeWithinDays: 30 });
    expect(ids(recent)).toEqual([S.lost, S.app, S.worktree, S.resumed]);
    expect(recent.filter((item) => item.sessionId === S.app).map((item) => item.kind)).toEqual(["transcript", "subagent", "tool-result", "tool-result", "vault", "vault"]);
    expect(select(inventory, { sections: ["subagents"], activeWithinDays: 30 }).map((item) => item.sessionId)).toEqual([S.app]);
    // The vault is not a session's: neither filter touches it.
    const app = select(inventory, { sections: [...sessions, "vault", "history"], repos: ["app"], activeWithinDays: 30 });
    expect(ids(app)).toEqual(["history", S.app, S.worktree]);
    expect(select(inventory, { sections: [...sessions], repos: [] })).toEqual([]);
    expect(select(inventory, { sections: [...sessions], repos: ["tools", "moved"] }).map((item) => item.sessionId)).toEqual([S.moved, S.resumed]);
    // The order is the inventory's.
    const all = select(inventory, { sections: ["history", ...sessions, "vault", "usage", "worktreesLog"] });
    expect(all).toEqual(inventory.items);
  });
});

describe("estimate", () => {
  const item = (kind: InventoryItem["kind"], size: number): InventoryItem => ({ section: "transcripts", kind, rel: "x", abs: "/x", size });

  it("uses the measured ratios per codec and level, and a manifest entry per file", () => {
    const transcripts = [item("transcript", 600_000), item("subagent", 300_000), item("tool-result", 100_000)];
    const overhead = 300;
    expect(estimate(transcripts, "zstd", 3)).toBe(130_000 + overhead);
    expect(estimate(transcripts, "zstd", 9)).toBe(126_000 + overhead);
    expect(estimate(transcripts, "gzip", 6)).toBe(297_000 + overhead);
    expect(estimate([item("history", 1_000_000)], "gzip", 6)).toBe(370_000 + 100);
    expect(estimate([item("history", 1_000_000)], "zstd", 3)).toBe(250_000 + 100);
    expect(estimate([], "zstd", 3)).toBe(0);
  });
});

describe("headCwd", () => {
  /** Counts the bytes read through file handles while `work` runs. */
  async function countingReads<T>(work: () => Promise<T>): Promise<{ result: T; bytes: number }> {
    let bytes = 0;
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        const out = await read(...a);
        bytes += out.bytesRead;
        return out;
      };
      return handle;
    });
    const result = await work();
    return { result, bytes };
  }

  it("stops at the first line with a place, however large the file", async () => {
    const file = path.join(tempConfigDir(), "big.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "user", cwd: "/first" }) + "\n" + JSON.stringify({ type: "user", cwd: "/second" }) + "\n");
    // 300 MB on paper, none of it on disk.
    fs.truncateSync(file, 300 * 1024 * 1024);
    const { result, bytes } = await countingReads(() => headCwd(file));
    expect(result).toBe("/first");
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("reads no further than the first MiB looking for one", async () => {
    const file = path.join(tempConfigDir(), "late.jsonl");
    const filler = JSON.stringify({ type: "progress", data: "x".repeat(1000) }) + "\n";
    fs.writeFileSync(file, filler.repeat(2000) + JSON.stringify({ type: "user", cwd: "/too-late" }) + "\n");
    const { result, bytes } = await countingReads(() => headCwd(file));
    expect(result).toBeUndefined();
    expect(bytes).toBe(1024 * 1024);
  });

  it("takes a line split across reads, a last line without its end, and skips subagents' lines and broken ones", async () => {
    const dir = tempConfigDir();
    const split = path.join(dir, "split.jsonl");
    fs.writeFileSync(split, JSON.stringify({ type: "user", pad: "y".repeat(100_000), cwd: "/across" }) + "\n");
    expect(await headCwd(split)).toBe("/across");
    const unended = path.join(dir, "unended.jsonl");
    fs.writeFileSync(unended, '{"cwd":"/broken\n' + JSON.stringify({ isSidechain: true, cwd: "/sub" }) + "\n" + JSON.stringify({ cwd: "/last" }));
    expect(await headCwd(unended)).toBe("/last");
    expect(await headCwd(path.join(dir, "missing.jsonl"))).toBeUndefined();
  });
});
