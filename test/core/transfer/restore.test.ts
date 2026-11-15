import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeProjectDir } from "../../../src/core/agents/claude/paths";
import { SessionRecords, type SessionRecord } from "../../../src/core/sessionRecords";
import { loadSqlite } from "../../../src/core/sqlite";
import { ConversationStore } from "../../../src/core/store";
import { applyRestore, defaultMapping, planRestore, readBackupHistory, RESTORED_BACKUPS_KEY, RESTORED_TABS_KEY, sweepRestoreTemp, type RestoreTargets, type StateStore } from "../../../src/core/transfer/restore";
import { PENDING_TABS_KEY, SECTIONS, type ManifestBody, type PathMapping, type SourceMachine } from "../../../src/core/transfer/types";
import { sessionId, tempConfigDir } from "../helpers";
import { fakeBundle, historyBytes, type FakeFile, type HistoryRow } from "./fakeBundle";

// Key derivation, compression and SQLite at real sizes: slower runners need more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const sqlite = loadSqlite() !== undefined;
const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const SOURCE: SourceMachine = { host: "alice-laptop", platform: "linux", home: "/home/alice", wsl: false };
const SRC_CLAUDE = "/home/alice/.claude";

/** VS Code's globalState, in memory. */
class FakeState implements StateStore {
  readonly values = new Map<string, unknown>();
  get(key: string): unknown {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, structuredClone(value));
  }
}

/** This machine: a home under a temporary folder, its Claude Code folder, and Lookout's storage. */
function machine() {
  const base = fs.realpathSync.native(tempConfigDir());
  const root = path.join(base, "machine");
  const home = path.join(root, "home", "bob");
  const claude = path.join(home, ".claude");
  const storage = path.join(root, "storage");
  fs.mkdirSync(home, { recursive: true });
  const state = new FakeState();
  const targets: RestoreTargets = {
    home,
    claudeDirs: [{ label: "default", resolved: claude, isDefault: true }],
    recordsDir: path.join(storage, "sessions"),
    storeFile: path.join(storage, "history.sqlite"),
    vaultDir: path.join(storage, "vault"),
    usageDir: path.join(storage, "usage"),
    removedWorktreesFile: path.join(storage, "worktrees", "removed.json"),
    backupsDir: path.join(storage, "restore-backups"),
    state,
    agentRoots: { codex: path.join(home, ".codex", "sessions") },
    tempDir: base,
    now: () => NOW,
  };
  return { base, root, home, claude, projects: path.join(claude, "projects"), storage, targets, state, mapping: defaultMapping(SOURCE, home) };
}

function body(over: Partial<ManifestBody> = {}): ManifestBody {
  return { format: 1, createdAt: NOW - DAY, lookoutVersion: "0.1.5", source: SOURCE, sections: [...SECTIONS], state: {}, notes: [], tabs: [], claudeDirs: [{ label: "default", resolved: SRC_CLAUDE, isDefault: true }], ...over };
}

/** A transcript's synthetic lines. */
function lines(n: number, tag = "line"): string {
  return Array.from({ length: n }, (_, i) => JSON.stringify({ type: i % 2 ? "assistant" : "user", message: { content: `${tag} ${i}` } }) + "\n").join("");
}

function transcript(id: string, cwd = "/home/alice/proj", bytes: string = lines(4)): FakeFile {
  return { entry: { kind: "transcript", dir: "default", rel: `${encodeProjectDir(cwd)}/${id}.jsonl`, sessionId: id, cwd, mtime: NOW - 2 * DAY }, bytes };
}

function sessionFile(kind: "subagent" | "tool-result", id: string, name: string, cwd = "/home/alice/proj"): FakeFile {
  return { entry: { kind, dir: "default", rel: `${encodeProjectDir(cwd)}/${id}/${kind === "subagent" ? "subagents" : "tool-results"}/${name}`, sessionId: id, mtime: NOW - 2 * DAY }, bytes: `${kind} ${name} of ${id}\n` };
}

/** Where a session's transcript goes on this machine, for a source folder. */
function here(m: ReturnType<typeof machine>, id: string, cwd = "/home/alice/proj"): string {
  return path.join(m.projects, encodeProjectDir(path.join(m.home, path.relative("/home/alice", cwd))), `${id}.jsonl`);
}

function vaultName(id: string, ext: "json" | "jsonl"): string {
  return `${crypto.createHash("sha1").update(id).digest("hex")}.${ext}`;
}

function record(id: string, notes: SessionRecord["notes"], cwd = "/home/alice/proj"): SessionRecord {
  return { v: 1, id, agent: "claude-code", title: `Session ${id.slice(-2)}`, cwd, notes };
}

/** Every file under `dir`, with its size, time and bytes' hash. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of fs.readdirSync(at)) {
      const p = path.join(at, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${st.size}:${Math.round(st.mtimeMs)}:${st.isSymbolicLink() ? `link:${fs.readlinkSync(p)}` : crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** A backup of everything Lookout keeps, made up: two sessions' transcripts with their files, notes, the light state, open tabs, a kept transcript, usage records and the removed-worktrees log. */
function everything(): { body: ManifestBody; files: FakeFile[]; ids: string[] } {
  const ids = [sessionId(1), sessionId(2), sessionId(3), sessionId(4)];
  const [s1, s2, s3, s4] = ids as [string, string, string, string];
  const files: FakeFile[] = [
    transcript(s1),
    transcript(s2, "/home/alice/work/api", lines(6)),
    sessionFile("subagent", s2, "agent-1.jsonl", "/home/alice/work/api"),
    sessionFile("tool-result", s2, "toolu_1.txt", "/home/alice/work/api"),
    { entry: { kind: "vault", rel: vaultName(s4, "jsonl"), sessionId: s4, mtime: NOW - 3 * DAY }, bytes: lines(3, "kept") },
    { entry: { kind: "vault", rel: vaultName(s4, "json"), sessionId: s4, mtime: NOW - 3 * DAY }, bytes: JSON.stringify({ v: 1, id: s4, agent: "claude-code", file: `${SRC_CLAUDE}/projects/-home-alice-old/${s4}.jsonl`, keptAt: NOW - 3 * DAY, size: 300, linked: true }) },
    { entry: { kind: "usage", rel: "alerts/abc-weekly-90-1", mtime: NOW - DAY }, bytes: "" },
    { entry: { kind: "usage", rel: "refresh/fetch-abc-1-0", mtime: NOW - 2 * DAY }, bytes: "" },
    {
      entry: { kind: "removed-worktrees", rel: "removed.json", mtime: NOW - DAY },
      bytes: JSON.stringify([
        { repo: "/home/alice/proj", path: "/home/alice/wt/fresh", branch: "feat/fresh", head: "abc1234", removedAt: NOW - DAY },
        { repo: "/home/alice/proj", path: "/home/alice/wt/old", removedAt: NOW - 30 * DAY },
        { repo: "relative/repo", path: "/home/alice/wt/bad", removedAt: NOW - DAY },
      ]),
    },
  ];
  return {
    ids,
    files,
    body: body({
      notes: [record(s1, [{ id: "a1", text: "Check the webhook retries", at: 100 }, { id: "a2", text: "Then ship", at: 200, editedAt: 300 }]), record(s3, [{ id: "b1", text: "Parked for later", at: 50 }], "/home/alice/gone")],
      state: { "lookout.favourites": [s1], "lookout.archive": [s3], "lookout.parking": { parked: [s2], kept: [] }, "lookout.sort": { by: "name", order: [] }, "lookout.group": "project", "lookout.claudeOrgs": { "org-1": "key-1" } },
      tabs: [
        { label: "proj", folders: ["/home/alice/proj"], tabs: [{ sessionId: s1, title: "Fix the webhook" }] },
        { label: "untitled", folders: [], tabs: [{ sessionId: s2, title: "No folder" }] },
      ],
    }),
  };
}

describe("planning a restore", () => {
  it("counts what a backup would add to a machine without any of it, in words a summary can use", async () => {
    const m = machine();
    const { body: b, files } = everything();
    const plan = await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping);
    expect(plan.mapping).toEqual([{ from: "/home/alice", to: m.home }]);
    expect(plan.notes).toEqual({ added: 2, merged: 0, unchanged: 0, skipped: 0 });
    expect(plan.state).toEqual({ taken: ["lookout.favourites", "lookout.archive", "lookout.parking", "lookout.sort", "lookout.group", "lookout.claudeOrgs"], merged: [] });
    expect(plan.transcripts.new).toEqual({ count: 2, bytes: lines(4).length + lines(6).length });
    expect(plan.sessionFiles.new.count).toBe(2);
    expect(plan.tabs).toEqual({ added: 1, present: 0, earlier: 0, gone: 0, refused: 0, skipped: 1 });
    // The sizes of what it would write to Lookout's own folders.
    expect(plan.vault).toEqual({ added: 1, present: 0, bytes: files[4]!.bytes.length + files[5]!.bytes.length });
    expect(plan.usage).toEqual({ added: 2, present: 0, bytes: 0 });
    expect(plan.worktreesLog).toBe(true);
    expect(plan.missingFolders.map((folder) => folder.to).sort()).toEqual([path.join(m.home, "gone"), path.join(m.home, "proj"), path.join(m.home, "work", "api")]);
    fs.mkdirSync(path.join(m.home, "proj"));
    expect((await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping)).missingFolders.map((folder) => folder.to)).not.toContain(path.join(m.home, "proj"));
    // Counts only: no note's text.
    expect(JSON.stringify(plan)).not.toMatch(/webhook retries|Then ship|Parked for later/);
  });
});

describe("restoring a backup", () => {
  it("puts everything in its place on a machine that has none of it", async () => {
    const m = machine();
    const { body: b, files, ids } = everything();
    const [s1, s2, , s4] = ids as [string, string, string, string];
    const plan = await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping);
    const progress: number[] = [];
    const result = await applyRestore(fakeBundle(b, files), plan, m.targets, (done, total) => progress.push(done / total));
    expect(result.cancelled).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.transcripts.written.count).toBe(2);
    expect(result.sessionFiles.written.count).toBe(2);
    expect(progress.at(-1)).toBe(1);

    // Transcripts and their folders under the mapped project folder, with the backup's times.
    const t1 = here(m, s1);
    expect(fs.readFileSync(t1, "utf8")).toBe(lines(4));
    expect(fs.statSync(t1).mtimeMs).toBe(NOW - 2 * DAY);
    const apiFolder = path.dirname(here(m, s2, "/home/alice/work/api"));
    expect(fs.readFileSync(path.join(apiFolder, `${s2}.jsonl`), "utf8")).toBe(lines(6));
    expect(fs.existsSync(path.join(apiFolder, s2, "subagents", "agent-1.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(apiFolder, s2, "tool-results", "toolu_1.txt"))).toBe(true);

    // Notes, their folder mapped.
    const records = new SessionRecords(m.targets.recordsDir);
    expect(records.get(s1)?.notes?.map((n) => n.text)).toEqual(["Check the webhook retries", "Then ship"]);
    expect(records.get(s1)?.cwd).toBe(path.join(m.home, "proj"));

    // The light state, and the tabs waiting for their folder.
    expect(m.state.get("lookout.favourites")).toEqual([s1]);
    expect(m.state.get("lookout.sort")).toEqual({ by: "name", order: [] });
    expect(m.state.get("lookout.group")).toBe("project");
    expect(m.state.get(PENDING_TABS_KEY)).toEqual([{ sessionId: s1, title: "Fix the webhook", cwd: path.join(m.home, "proj"), from: "alice-laptop", madeAt: NOW - DAY }]);

    // The kept transcript, its record pointing where the agent keeps it here.
    const kept = JSON.parse(fs.readFileSync(path.join(m.targets.vaultDir, vaultName(s4, "json")), "utf8"));
    expect(kept).toMatchObject({ v: 1, id: s4, file: path.join(m.projects, encodeProjectDir(path.join(m.home, "old")), `${s4}.jsonl`), linked: false });
    expect(fs.readFileSync(path.join(m.targets.vaultDir, vaultName(s4, "jsonl")), "utf8")).toBe(lines(3, "kept"));

    // Usage records with their times, the removed worktrees still in reach with their paths mapped.
    expect(fs.statSync(path.join(m.targets.usageDir, "refresh", "fetch-abc-1-0")).mtimeMs).toBe(NOW - 2 * DAY);
    expect(JSON.parse(fs.readFileSync(m.targets.removedWorktreesFile, "utf8"))).toEqual([{ repo: path.join(m.home, "proj"), path: path.join(m.home, "wt", "fresh"), branch: "feat/fresh", head: "abc1234", removedAt: NOW - DAY }]);

    // Nothing was replaced, so nothing was set aside.
    expect(result.backupDir).toBeUndefined();
    expect(fs.existsSync(m.targets.backupsDir)).toBe(false);
  });

  it("changes nothing the second time the same backup is restored", async () => {
    const m = machine();
    const { body: b, files } = everything();
    await applyRestore(fakeBundle(b, files), await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping), m.targets);
    const before = tree(m.root);
    const state = structuredClone([...m.state.values]);
    const again = await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping);
    expect(again.notes).toEqual({ added: 0, merged: 0, unchanged: 2, skipped: 0 });
    expect(again.state).toEqual({ taken: [], merged: [] });
    expect(again.transcripts.same.count).toBe(2);
    expect(again.tabs.added).toBe(0);
    const result = await applyRestore(fakeBundle(b, files), again, m.targets);
    expect(result.transcripts.same.count).toBe(2);
    expect(result.transcripts.written.count + result.transcripts.replaced.count).toBe(0);
    expect(result.worktreesLog.added).toBe(0);
    expect(result.backupDir).toBeUndefined();
    expect(tree(m.root)).toEqual(before);
    expect([...m.state.values]).toEqual(state);
  });

  it("keeps what is on this machine, merging into it and setting aside what it replaces", async () => {
    const m = machine();
    const [s1, s2, s3, s4, s5, s6] = [1, 2, 3, 4, 5, 6].map(sessionId) as [string, string, string, string, string, string];
    // This machine's notes, state, tabs, transcripts and log.
    const records = new SessionRecords(m.targets.recordsDir);
    fs.mkdirSync(m.targets.recordsDir, { recursive: true });
    const mine: SessionRecord = { v: 1, id: s1, agent: "claude-code", title: "Mine", cwd: path.join(m.home, "proj"), notes: [{ id: "n1", text: "same note", at: 100 }, { id: "n2", text: "edited here last", at: 200, editedAt: 900 }, { id: "n5", text: "edited there last", at: 250, editedAt: 300 }] };
    fs.writeFileSync(records.fileOf(s1), JSON.stringify(mine));
    m.state.values.set("lookout.favourites", [s6, s1]);
    m.state.values.set("lookout.sort", { by: "time", order: [] });
    m.state.values.set("lookout.parking", { parked: [s6], kept: [] });
    m.state.values.set("lookout.claudeOrgs", { "org-1": "mine" });
    m.state.values.set(PENDING_TABS_KEY, [{ sessionId: s1, title: "Already waiting", cwd: path.join(m.home, "proj"), from: "elsewhere", madeAt: 1 }]);
    const write = (id: string, text: string) => {
      fs.mkdirSync(path.dirname(here(m, id)), { recursive: true });
      fs.writeFileSync(here(m, id), text);
    };
    write(s1, lines(2)); // the start of the backup's: replaced
    write(s2, lines(8)); // longer here, and starting with the backup's: kept
    write(s3, lines(4, "LINE")); // the same size, other bytes: kept, the backup's set aside
    write(s4, lines(4)); // the same
    write(s5, lines(1, "diverged")); // shorter, but not the start of the backup's: kept, the backup's set aside
    fs.mkdirSync(path.dirname(m.targets.removedWorktreesFile), { recursive: true });
    const log = [{ repo: path.join(m.home, "proj"), path: path.join(m.home, "wt", "fresh"), removedAt: NOW - DAY }, { repo: path.join(m.home, "proj"), path: path.join(m.home, "wt", "mine"), removedAt: NOW - 2 * DAY }];
    fs.writeFileSync(m.targets.removedWorktreesFile, JSON.stringify(log));

    const theirs = record(s1, [
      { id: "n1", text: "same note", at: 100 },
      { id: "n2", text: "an older edit", at: 200, editedAt: 500 },
      { id: "n3", text: "same note", at: 210 },
      { id: "n4", text: "new from the backup", at: 300 },
      { id: "n5", text: "the later edit", at: 250, editedAt: 800 },
    ]);
    const b = body({
      notes: [theirs],
      state: { "lookout.favourites": [s1, s2], "lookout.sort": { by: "name", order: [] }, "lookout.group": "branch", "lookout.parking": { parked: [s2], kept: [s3] }, "lookout.claudeOrgs": { "org-1": "theirs", "org-2": "two" } },
      tabs: [{ label: "proj", folders: ["/home/alice/proj"], tabs: [{ sessionId: s1, title: "Dup" }, { sessionId: s2, title: "New" }] }],
    });
    const files: FakeFile[] = [
      transcript(s1, undefined, lines(4)),
      transcript(s2, undefined, lines(4)),
      transcript(s3, undefined, lines(4)),
      transcript(s4, undefined, lines(4)),
      transcript(s5, undefined, lines(4)),
      { entry: { kind: "removed-worktrees", rel: "removed.json", mtime: NOW }, bytes: JSON.stringify([{ repo: "/home/alice/proj", path: "/home/alice/wt/fresh", removedAt: NOW - DAY }, { repo: "/home/alice/proj", path: "/home/alice/wt/theirs", removedAt: NOW - 3 * DAY }]) },
    ];
    const plan = await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping);
    expect(plan.transcripts.newer.count).toBe(2);
    expect(plan.transcripts.kept.count).toBe(1);
    expect(plan.transcripts.same.count).toBe(1);
    expect(plan.transcripts.different.count).toBe(1);
    expect(plan.notes).toEqual({ added: 0, merged: 1, unchanged: 0, skipped: 0 });
    expect(plan.state).toEqual({ taken: ["lookout.group"], merged: ["lookout.favourites", "lookout.parking", "lookout.claudeOrgs"] });
    const result = await applyRestore(fakeBundle(b, files), plan, m.targets);

    expect(result.transcripts.replaced.count).toBe(1);
    expect(result.transcripts.same.count).toBe(1);
    expect(result.transcripts.kept.count).toBe(1);
    expect(result.transcripts.diverged.count).toBe(2);
    expect(fs.readFileSync(here(m, s1), "utf8")).toBe(lines(4));
    expect(fs.readFileSync(here(m, s2), "utf8")).toBe(lines(8));
    expect(fs.readFileSync(here(m, s3), "utf8")).toBe(lines(4, "LINE"));
    expect(fs.readFileSync(here(m, s5), "utf8")).toBe(lines(1, "diverged"));

    expect(new SessionRecords(m.targets.recordsDir).get(s1)?.notes).toEqual([
      { id: "n1", text: "same note", at: 100 },
      { id: "n2", text: "edited here last", at: 200, editedAt: 900 },
      { id: "n5", text: "the later edit", at: 250, editedAt: 800 },
      { id: "n4", text: "new from the backup", at: 300 },
    ]);
    expect(m.state.get("lookout.favourites")).toEqual([s6, s1, s2]);
    expect(m.state.get("lookout.sort")).toEqual({ by: "time", order: [] });
    expect(m.state.get("lookout.group")).toBe("branch");
    expect(m.state.get("lookout.parking")).toEqual({ parked: [s6, s2], kept: [s3] });
    expect(m.state.get("lookout.claudeOrgs")).toEqual({ "org-1": "mine", "org-2": "two" });
    expect((m.state.get(PENDING_TABS_KEY) as { sessionId: string }[]).map((tab) => tab.sessionId)).toEqual([s1, s2]);
    expect(JSON.parse(fs.readFileSync(m.targets.removedWorktreesFile, "utf8")).map((r: { path: string }) => path.basename(r.path))).toEqual(["fresh", "mine", "theirs"]);

    // What was replaced is under the restore's own folder, as it was.
    expect(result.backupDir).toBe(path.join(m.targets.backupsDir, stampOf(NOW)));
    const kept = result.backupDir!;
    expect(fs.readFileSync(path.join(kept, "claude", "default", "projects", path.basename(path.dirname(here(m, s1))), `${s1}.jsonl`), "utf8")).toBe(lines(2));
    expect(JSON.parse(fs.readFileSync(path.join(kept, "notes", path.basename(records.fileOf(s1))), "utf8"))).toEqual(mine);
    expect(JSON.parse(fs.readFileSync(path.join(kept, "worktrees", "removed.json"), "utf8"))).toEqual(log);
    expect(JSON.parse(fs.readFileSync(path.join(kept, "state.json"), "utf8"))).toMatchObject({ "lookout.favourites": [s6, s1], "lookout.claudeOrgs": { "org-1": "mine" } });
    // The backup's copies of the transcripts that went on differently here, with their times.
    expect(result.divergedDir).toBe(path.join(kept, "diverged"));
    const diverged = (id: string) => path.join(kept, "diverged", "claude", "default", "projects", path.basename(path.dirname(here(m, id))), `${id}.jsonl`);
    expect(fs.readFileSync(diverged(s3), "utf8")).toBe(lines(4));
    expect(fs.readFileSync(diverged(s5), "utf8")).toBe(lines(4));
    expect(fs.statSync(diverged(s5)).mtimeMs).toBe(NOW - 2 * DAY);
    expect(fs.existsSync(diverged(s2))).toBe(false);
  });

  it("leaves this machine's transcript alone when a session here wrote to it meanwhile", async () => {
    const m = machine();
    const id = sessionId(1);
    fs.mkdirSync(path.dirname(here(m, id)), { recursive: true });
    fs.writeFileSync(here(m, id), lines(2));
    const files = [transcript(id, undefined, lines(4))];
    const plan = await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping);
    const source = fakeBundle(body(), files);
    const pass = source.forEachFile.bind(source);
    source.forEachFile = (visit, want) => pass(async (entry, data) => {
      fs.appendFileSync(here(m, id), lines(1, "live"));
      await visit(entry, data);
    }, want);
    const result = await applyRestore(source, plan, m.targets);
    expect(result.transcripts.diverged.count).toBe(1);
    expect(fs.readFileSync(here(m, id), "utf8")).toBe(lines(2) + lines(1, "live"));
    expect(fs.readdirSync(path.dirname(here(m, id)))).toEqual([`${id}.jsonl`]);
    // The copy kept for the replace is let go of; the backup's copy is set aside.
    const folder = path.basename(path.dirname(here(m, id)));
    expect(fs.existsSync(path.join(result.backupDir!, "claude"))).toBe(false);
    expect(fs.readFileSync(path.join(result.divergedDir!, "claude", "default", "projects", folder, `${id}.jsonl`), "utf8")).toBe(lines(4));
  });

  it("writes nothing of a file whose bytes do not match the backup's record of them", async () => {
    const m = machine();
    const id = sessionId(1);
    const bad = transcript(id);
    bad.entry.sha256 = "0".repeat(64);
    const plan = await planRestore(fakeBundle(body(), [bad]).manifest, m.targets, m.mapping);
    const result = await applyRestore(fakeBundle(body(), [bad]), plan, m.targets);
    expect(result.failed).toEqual([{ what: `transcript ${bad.entry.rel}`, why: "its bytes do not match the backup's record of them" }]);
    expect(fs.existsSync(here(m, id))).toBe(false);
    expect(fs.readdirSync(path.dirname(here(m, id)))).toEqual([]);
  });

  it("stops between files when asked, and keeps what it did", async () => {
    const m = machine();
    const ids = [1, 2, 3].map(sessionId);
    const files = ids.map((id) => transcript(id));
    const plan = await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping);
    const stop = new AbortController();
    const source = fakeBundle(body(), files);
    const result = await applyRestore(source, plan, m.targets, (done) => {
      if (done > 0) stop.abort();
    }, stop.signal);
    expect(result.cancelled).toBe(true);
    expect(result.transcripts.written.count).toBe(1);
    expect(ids.filter((id) => fs.existsSync(here(m, id)))).toEqual([ids[0]]);
  });

  it("maps folders as the user says, the longest prefix first, and says which are not on this machine", async () => {
    const m = machine();
    const code = path.join(m.root, "code");
    const mapping: PathMapping[] = [...m.mapping, { from: "/home/alice/work", to: code }];
    const [s1, s2, s3] = [1, 2, 3].map(sessionId) as [string, string, string];
    // s3 has no place recorded: its folder's name is mapped instead.
    const noCwd = transcript(s3, "/home/alice/work/web");
    delete noCwd.entry.cwd;
    const files = [transcript(s1, "/home/alice/proj"), transcript(s2, "/home/alice/work/api"), sessionFile("subagent", s2, "agent-9.jsonl", "/home/alice/work/api"), noCwd];
    const plan = await planRestore(fakeBundle(body(), files).manifest, m.targets, mapping);
    expect(plan.missingFolders).toEqual([
      { from: "/home/alice/work/api", to: path.join(code, "api"), sessions: 1 },
      { from: "/home/alice/proj", to: path.join(m.home, "proj"), sessions: 1 },
    ]);
    await applyRestore(fakeBundle(body(), files), plan, m.targets);
    expect(fs.existsSync(path.join(m.projects, encodeProjectDir(path.join(m.home, "proj")), `${s1}.jsonl`))).toBe(true);
    const api = path.join(m.projects, encodeProjectDir(path.join(code, "api")));
    expect(fs.existsSync(path.join(api, `${s2}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(api, s2, "subagents", "agent-9.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(m.projects, encodeProjectDir(path.join(code, "web")), `${s3}.jsonl`))).toBe(true);
    // A config directory with the same label here takes the file; one with none here leaves it to the default one.
    const work = path.join(m.home, ".claude-work");
    const targets = { ...m.targets, claudeDirs: [...m.targets.claudeDirs, { label: "work", resolved: work, isDefault: false }] };
    const s4 = sessionId(4);
    const s5 = sessionId(5);
    const labelled = [{ ...transcript(s4), entry: { ...transcript(s4).entry, dir: "work" } }, { ...transcript(s5), entry: { ...transcript(s5).entry, dir: "personal" } }];
    const b = body({ claudeDirs: [...body().claudeDirs, { label: "work", resolved: "/home/alice/.claude-work", isDefault: false }, { label: "personal", resolved: "/home/alice/.claude-personal", isDefault: false }] });
    await applyRestore(fakeBundle(b, labelled), await planRestore(fakeBundle(b, labelled).manifest, targets, m.mapping), targets);
    expect(fs.existsSync(path.join(work, "projects", encodeProjectDir(path.join(m.home, "proj")), `${s4}.jsonl`))).toBe(true);
    expect(fs.existsSync(here(m, s5))).toBe(true);
  });
});

/** The name of a restore's own folder, as Safekeeping makes it. */
function stampOf(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

describe("a backup from someone else", () => {
  it("restores nothing outside its roots, whatever names the backup gives", async () => {
    const m = machine();
    const outside = path.join(m.base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "canary.jsonl"), "do not touch\n");
    const id = sessionId(1);
    const linked = sessionId(2);
    const throughLink = sessionId(3);
    // A link already where a transcript would go, and a project folder that is a link out.
    fs.mkdirSync(path.dirname(here(m, linked)), { recursive: true });
    fs.symlinkSync(path.join(outside, "canary.jsonl"), here(m, linked));
    fs.symlinkSync(outside, path.join(m.projects, encodeProjectDir(path.join(m.home, "linkedproj"))), "dir");
    const evil = (rel: string, kind: FakeFile["entry"]["kind"] = "transcript", extra: Partial<FakeFile["entry"]> = {}): FakeFile => ({ entry: { kind, dir: "default", rel, sessionId: id, mtime: NOW, ...extra }, bytes: "evil\n" });
    const files: FakeFile[] = [
      evil(`../../../outside/evil.jsonl`),
      evil(`/abs/evil.jsonl`),
      evil(`-home-alice-proj/../../evil.jsonl`),
      evil(`-home-alice-proj\\..\\..\\evil.jsonl`),
      evil(`bad folder/${id}.jsonl`),
      evil(`-home-alice-proj/not-a-session.jsonl`),
      evil(`-home-alice-proj/${id}.jsonl`, "transcript", { sessionId: sessionId(9) }),
      evil(`../${id}.jsonl`),
      evil(`-home-alice-proj/${id}/subagents/../../../../evil.jsonl`, "subagent"),
      evil(`-home-alice-proj/${id}/subagents/C:evil`, "subagent"),
      evil(`-home-alice-proj/${id}/notes/evil.txt`, "tool-result"),
      evil(`..`, "usage"),
      evil(`alerts/../../evil`, "usage"),
      evil(`/etc/evil`, "usage"),
      evil(`../evil.json`, "vault"),
      evil(`-home-alice-proj/${linked}.jsonl`, "transcript", { sessionId: linked }),
      evil(`-home-alice-linkedproj/${throughLink}.jsonl`, "transcript", { sessionId: throughLink, cwd: "/home/alice/linkedproj" }),
      // A place that climbs out is not used: the folder's own name decides.
      evil(`-home-alice-proj/${id}.jsonl`, "transcript", { cwd: "/home/alice/../../../etc" }),
      // Kept transcripts' records that point outside where the agent keeps its transcripts.
      { entry: { kind: "vault", rel: vaultName(sessionId(5), "json"), mtime: NOW }, bytes: JSON.stringify({ v: 1, id: sessionId(5), agent: "claude-code", file: "/home/alice/.bashrc", keptAt: 1 }) },
      { entry: { kind: "vault", rel: vaultName(sessionId(5), "jsonl"), mtime: NOW }, bytes: "evil\n" },
      { entry: { kind: "vault", rel: vaultName(sessionId(6), "json"), mtime: NOW }, bytes: JSON.stringify({ v: 1, id: sessionId(6), agent: "codex", file: "/home/alice/notes/x.jsonl", keptAt: 1 }) },
      { entry: { kind: "vault", rel: vaultName(sessionId(7), "json"), mtime: NOW }, bytes: JSON.stringify({ v: 1, id: sessionId(8), agent: "claude-code", file: `${SRC_CLAUDE}/projects/-home-alice-proj/${sessionId(8)}.jsonl`, keptAt: 1 }) },
      { entry: { kind: "removed-worktrees", rel: "removed.json", mtime: NOW }, bytes: JSON.stringify([{ repo: "relative", path: "/home/alice/wt/a", removedAt: NOW }, { repo: "/home/alice/p", path: "/home/alice/../../etc", removedAt: NOW }, { repo: "/home/alice/p", path: "/home/alice/wt/ok", removedAt: NOW, branch: "a b" }]) },
    ];
    const b = body({
      notes: [{ v: 1, id: "../../etc/passwd", agent: "claude-code", notes: [{ id: "x", text: "evil", at: 1 }] } as SessionRecord, { v: 1, id, agent: "claude-code", cwd: "relative/dir", notes: [{ id: "../x", text: "evil", at: 1 }, { id: "ok", text: "  kept  \r\n", at: 2 }] }],
      tabs: [{ label: "x", folders: ["relative"], tabs: [{ sessionId: id, title: "x" }] }, { label: "y", folders: ["/home/alice/p"], tabs: [{ sessionId: "../../x", title: "x" }, { sessionId: id, title: "line\u0007one\nline two" }] }],
      state: { "lookout.favourites": "not a list", "lookout.parking": [1, 2], "lookout.sort": { by: "evil" }, "lookout.group": "nonsense", "lookout.claudeOrgs": { "org/../x": "k", ok: 5 } },
    });
    const before = tree(m.base);
    const plan = await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping);
    const result = await applyRestore(fakeBundle(b, files), plan, m.targets);

    // Everything new is inside a root this machine chose.
    const roots = [m.projects, m.targets.recordsDir, m.targets.vaultDir, m.targets.usageDir, m.targets.removedWorktreesFile, m.targets.backupsDir];
    const added = Object.keys(tree(m.base)).filter((rel) => !(rel in before));
    for (const rel of added) expect(roots.some((root) => !path.relative(root, path.join(m.base, rel)).startsWith("..")), rel).toBe(true);
    expect(tree(outside)).toEqual({ "canary.jsonl": before[path.join("outside", "canary.jsonl")] });
    expect(fs.readlinkSync(here(m, linked))).toBe(path.join(outside, "canary.jsonl"));
    expect(fs.readdirSync(path.dirname(m.base)).filter((name) => name.startsWith("evil"))).toEqual([]);

    // What did go in is what passes: one transcript, its note cleaned, one removal, one tab.
    expect(added.filter((rel) => rel.startsWith(path.relative(m.base, m.projects)))).toEqual([path.relative(m.base, here(m, id))]);
    expect(new SessionRecords(m.targets.recordsDir).get(id)?.notes).toEqual([{ id: "ok", text: "kept", at: 2 }]);
    expect(new SessionRecords(m.targets.recordsDir).get(id)?.cwd).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(m.targets.removedWorktreesFile, "utf8"))).toEqual([{ repo: path.join(m.home, "p"), path: path.join(m.home, "wt", "ok"), removedAt: NOW }]);
    expect(m.state.get(PENDING_TABS_KEY)).toEqual([{ sessionId: id, title: "line one line two", cwd: path.join(m.home, "p"), from: "alice-laptop", madeAt: NOW - DAY }]);
    expect(m.state.get("lookout.favourites")).toBeUndefined();
    expect(m.state.get("lookout.sort")).toBeUndefined();
    expect(m.state.get("lookout.group")).toBeUndefined();
    expect(m.state.get("lookout.parking")).toBeUndefined();
    expect(fs.existsSync(m.targets.vaultDir) ? fs.readdirSync(m.targets.vaultDir) : []).toEqual([]);
    expect(result.vault.added).toBe(0);
    expect(result.transcripts.refused).toBeGreaterThanOrEqual(10);
  });
});

describe.skipIf(!sqlite)("restoring the history", () => {
  /** A backup with a history and the transcripts it names: s1's comes with the backup, s2's is gone everywhere, s3 is Codex's, s4's is on this machine already, s5 this machine's history knows. */
  function withHistory(m: ReturnType<typeof machine>, alter?: string) {
    const [s1, s2, s3, s4, s5] = [1, 2, 3, 4, 5].map(sessionId) as [string, string, string, string, string];
    const file = (id: string, cwd = "/home/alice/proj") => `${SRC_CLAUDE}/projects/${encodeProjectDir(cwd)}/${id}.jsonl`;
    const codex = `/home/alice/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-${s3}.jsonl`;
    const rows: HistoryRow[] = [
      { id: s1, agent: "claude-code", file: file(s1), cwd: "/home/alice/proj", messages: ["here with the backup"] },
      { id: s2, agent: "claude-code", file: file(s2, "/home/alice/old"), cwd: "/home/alice/old", purgedAt: NOW - 5 * DAY, messages: ["Fix the billing webhook", "Done: it retries twice"], paths: ["/home/alice/old/src/billing.ts", "/etc/hosts"], tools: ["secret output"] },
      { id: s3, agent: "codex", file: codex, cwd: "/home/alice/proj", messages: ["codex says hello"] },
      { id: s4, agent: "claude-code", file: file(s4), cwd: "/home/alice/proj", messages: ["already here"] },
      { id: s5, agent: "claude-code", file: file(s5), cwd: "/home/alice/proj", messages: ["known here"] },
      { id: sessionId(6), agent: "claude-code", file: "/etc/passwd", cwd: "/home/alice/proj", messages: ["nowhere to go"] },
      { id: sessionId(7), agent: "codex", file: "/home/alice/elsewhere/x.jsonl", cwd: "/home/alice/proj", messages: ["outside codex's folder"] },
    ];
    const files: FakeFile[] = [{ entry: { kind: "history", rel: "history.sqlite", mtime: NOW }, bytes: historyBytes(m.base, rows, alter) }, transcript(s1)];
    fs.mkdirSync(path.dirname(here(m, s4)), { recursive: true });
    fs.writeFileSync(here(m, s4), lines(1));
    const live = ConversationStore.open(m.targets.storeFile)!;
    live.rememberSession({ id: s5, agent: "claude-code", file: path.join(m.home, "somewhere.jsonl"), title: "Known", cwd: m.home });
    live.close();
    return { ids: [s1, s2, s3, s4, s5], files, codex };
  }

  it("adds only the sessions whose transcript is not on this machine, with their files mapped, and searchable", async () => {
    const m = machine();
    const { ids, files } = withHistory(m);
    const [s1, s2, s3, s4, s5] = ids as [string, string, string, string, string];
    const ahead = await readBackupHistory(fakeBundle(body(), files), m.base);
    expect(ahead?.sessions.map((s) => s.id)).toHaveLength(7);
    const plan = await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping, ahead);
    expect(plan.history?.sessions).toBe(2);
    // The two whose files have no place here are left out, and said to be.
    expect(plan.history?.leftOut).toBe(2);
    expect(plan.refused).toEqual(
      expect.arrayContaining([
        { what: `conversation ${sessionId(6)}`, why: "its file is not a transcript in a Claude Code projects folder" },
        { what: `conversation ${sessionId(7)}`, why: "its file is outside the folder where its agent keeps conversations" },
      ]),
    );
    const source = fakeBundle(body(), files);
    const result = await applyRestore(source, plan, m.targets);
    // The history read ahead is not read again, and its copy is let go of.
    expect(source.visits).toEqual([files[1]!.entry.rel]);
    expect(fs.existsSync(ahead!.file)).toBe(false);
    expect(result.history).toEqual({ added: 2, missing: [], extra: [] });
    expect(result.historyLeftOut).toBe(2);

    const store = ConversationStore.open(m.targets.storeFile)!;
    try {
      const old = store.session(s2)!;
      expect(old.file).toBe(here(m, s2, "/home/alice/old"));
      expect(old.cwd).toBe(path.join(m.home, "old"));
      expect(old.purgedAt).toBe(NOW - 5 * DAY);
      expect(store.messages(old.file)?.map((msg) => msg.text)).toEqual(["Fix the billing webhook", "Done: it retries twice"]);
      expect(store.search([old.file], ["billing"], 3).get(old.file)?.count).toBe(1);
      expect([...store.touched([old.file], [path.join(m.home, "old", "src").toLowerCase().replace(/\\/g, "/")])]).toEqual([old.file]);
      // Tool output is never kept for a session whose transcript is gone.
      expect(store.toolCount()).toBe(0);
      const codex = store.session(s3)!;
      expect(codex.file).toBe(path.join(m.home, ".codex", "sessions", "2026", "10", "01", `rollout-2026-10-01T10-00-00-${s3}.jsonl`));
      expect(codex.purgedAt).toBe(NOW);
      expect(store.session(s1)).toBeUndefined();
      expect(store.session(s4)).toBeUndefined();
      expect(store.session(s5)?.title).toBe("Known");
      expect(store.session(sessionId(6))).toBeUndefined();
      expect(store.session(sessionId(7))).toBeUndefined();
      // The sweep keeps them as purged: their transcripts are not here.
      const sweep = store.sweep(NOW);
      expect(sweep.forgotten).not.toContain(s2);
      expect(sweep.forgotten).not.toContain(s3);
    } finally {
      store.close();
    }
    // This machine's history was copied before anything went into it.
    expect(fs.existsSync(path.join(result.backupDir!, "history.sqlite"))).toBe(true);
  });

  it("adds nothing the second time", async () => {
    const m = machine();
    const { files } = withHistory(m);
    await applyRestore(fakeBundle(body(), files), await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping), m.targets);
    const ahead = await readBackupHistory(fakeBundle(body(), files), m.base);
    const plan = await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping, ahead);
    expect(plan.history?.sessions).toBe(0);
    const before = tree(m.root);
    const result = await applyRestore(fakeBundle(body(), files), plan, m.targets);
    expect(result.history?.added).toBe(0);
    expect(result.backupDir).toBeUndefined();
    const after = tree(m.root);
    // The database's own files may be touched by opening it; what it holds is compared instead.
    for (const rel of Object.keys(after)) if (!rel.includes("history.sqlite")) expect(after[rel], rel).toBe(before[rel]);
  });

  it("takes the columns both versions have when the backup's history was made by another one, and says so", async () => {
    const m = machine();
    const { ids, files } = withHistory(m, "ALTER TABLE files DROP COLUMN tools; ALTER TABLE sessions ADD COLUMN flavour TEXT");
    const result = await applyRestore(fakeBundle(body(), files), await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping), m.targets);
    expect(result.history).toEqual({ added: 2, missing: ["files.tools"], extra: ["sessions.flavour"] });
    const store = ConversationStore.open(m.targets.storeFile)!;
    expect(store.session(ids[1]!)?.title).toBe(`Session ${ids[1]!.slice(-4)}`);
    store.close();
  });

  it("leaves a history out that is not the database Lookout writes", async () => {
    const m = machine();
    const garbage: FakeFile = { entry: { kind: "history", rel: "history.sqlite", mtime: NOW }, bytes: "SQLite format 3\0 not really" };
    const ahead = await readBackupHistory(fakeBundle(body(), [garbage]), m.base);
    expect(ahead?.failed).toBeDefined();
    const plan = await planRestore(fakeBundle(body(), [garbage]).manifest, m.targets, m.mapping, ahead);
    expect(plan.history?.failed).toBeDefined();
    const result = await applyRestore(fakeBundle(body(), [garbage]), plan, m.targets);
    expect(result.history?.added).toBe(0);
    expect(result.history?.failed).toBeDefined();
    // A view where a table should be is refused too: it would run what the backup says.
    const sneaky = path.join(m.base, "sneaky.sqlite");
    const db = new (loadSqlite()!.DatabaseSync)(sneaky);
    db.exec("CREATE TABLE files(file, reader, identity, end, build); CREATE VIEW sessions AS SELECT 'x' AS id, 'claude-code' AS agent, 'f' AS file, 't' AS title, '/' AS cwd");
    db.close();
    const view: FakeFile = { entry: { kind: "history", rel: "history.sqlite", mtime: NOW }, bytes: fs.readFileSync(sneaky) };
    expect((await readBackupHistory(fakeBundle(body(), [view]), m.base))?.failed).toBe("the backup's history database is not one Lookout writes");
  });
});

describe.skipIf(!sqlite)("history entries under a config directory the backup does not list", () => {
  it("go under this machine's default one by their projects/<folder>/<id>.jsonl, and those without are left out with why", async () => {
    const m = machine();
    const [listed, unlisted, bare, climbing] = [1, 2, 3, 4].map(sessionId) as [string, string, string, string];
    const rows: HistoryRow[] = [
      { id: listed, agent: "claude-code", file: `${SRC_CLAUDE}/projects/-home-alice-a/${listed}.jsonl`, cwd: "/home/alice/a", messages: ["listed"] },
      { id: unlisted, agent: "claude-code", file: `/home/alice/.claude-other/projects/-home-alice-b/${unlisted}.jsonl`, cwd: "/home/alice/b", messages: ["unlisted"] },
      { id: bare, agent: "claude-code", file: `/home/alice/stray/${bare}.jsonl`, cwd: "/home/alice/c", messages: ["no tail"] },
      { id: climbing, agent: "claude-code", file: `/home/alice/.claude-other/projects/../${climbing}.jsonl`, cwd: "/home/alice/d", messages: ["climbs"] },
    ];
    const files: FakeFile[] = [{ entry: { kind: "history", rel: "history.sqlite", mtime: NOW }, bytes: historyBytes(m.base, rows) }];
    const ahead = await readBackupHistory(fakeBundle(body(), files), m.base);
    const plan = await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping, ahead);
    expect(plan.history).toMatchObject({ sessions: 2, leftOut: 2 });
    const result = await applyRestore(fakeBundle(body(), files), plan, m.targets);
    expect(result.history?.added).toBe(2);
    expect(result.historyLeftOut).toBe(2);
    expect(result.refused.map((r) => r.what).sort()).toEqual([`conversation ${bare}`, `conversation ${climbing}`]);
    const store = ConversationStore.open(m.targets.storeFile)!;
    try {
      expect(store.session(unlisted)?.file).toBe(here(m, unlisted, "/home/alice/b"));
      expect(store.session(listed)?.file).toBe(here(m, listed, "/home/alice/a"));
      expect(store.session(bare)).toBeUndefined();
      expect(store.session(climbing)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("Claude Code's retention", () => {
  /** Transcripts last written 2 and 40 days ago, the older with a subagent's file 50 days old, and one 90 days old that is here already. */
  function aged(m: ReturnType<typeof machine>) {
    const [fresh, old, here90] = [1, 2, 3].map(sessionId) as [string, string, string];
    const at = (file: FakeFile, mtime: number): FakeFile => ({ ...file, entry: { ...file.entry, mtime } });
    const files = [at(transcript(fresh), NOW - 2 * DAY), at(transcript(old), NOW - 40 * DAY), at(sessionFile("subagent", old, "agent-1.jsonl"), NOW - 50 * DAY), at(transcript(here90), NOW - 90 * DAY)];
    fs.mkdirSync(path.dirname(here(m, here90)), { recursive: true });
    fs.writeFileSync(here(m, here90), lines(4));
    return { files, old };
  }

  it("counts the restored files Claude Code deletes at its next start, and the oldest one's age", async () => {
    const m = machine();
    const { files } = aged(m);
    const plan = await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping);
    expect(plan.retention).toEqual({
      files: 2,
      transcripts: 1,
      bytes: files[1]!.bytes.length + files[2]!.bytes.length,
      oldest: NOW - 50 * DAY,
      oldestDays: 50,
      dirs: [{ label: "default", resolved: m.claude, days: 30, level: "default", files: 2 }],
    });
  });

  it("goes by the retention set in Claude Code's settings, and says nothing while it is long enough or unknown", async () => {
    const m = machine();
    const { files } = aged(m);
    fs.mkdirSync(m.claude, { recursive: true });
    const settings = path.join(m.claude, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 45 }));
    const plan = await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping);
    expect(plan.retention?.dirs).toEqual([{ label: "default", resolved: m.claude, days: 45, level: "user", file: settings, files: 1 }]);
    fs.writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 80 }));
    expect((await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping)).retention).toBeUndefined();
    // A file Claude Code cannot read pauses its sweep: nothing goes.
    fs.writeFileSync(settings, "{ not json");
    expect((await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping)).retention).toBeUndefined();
  });

  it("keeps the times the backup has, which the retention goes by", async () => {
    const m = machine();
    const { files, old } = aged(m);
    await applyRestore(fakeBundle(body(), files), await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping), m.targets);
    expect(fs.statSync(here(m, old)).mtimeMs).toBe(NOW - 40 * DAY);
  });
});

describe("a transcript that went on differently on each machine", () => {
  it("stays as it is here, and the backup's copy goes under the restore's diverged folder; one that only grew here stays without one", async () => {
    const m = machine();
    const [grown, forked] = [1, 2].map(sessionId) as [string, string];
    for (const [id, text] of [[grown, lines(6)], [forked, lines(6, "other")]] as const) {
      fs.mkdirSync(path.dirname(here(m, id)), { recursive: true });
      fs.writeFileSync(here(m, id), text);
    }
    const files = [transcript(grown, undefined, lines(4)), transcript(forked, undefined, lines(4)), sessionFile("subagent", forked, "agent-1.jsonl")];
    const subagent = path.join(path.dirname(here(m, forked)), forked, "subagents", "agent-1.jsonl");
    fs.mkdirSync(path.dirname(subagent), { recursive: true });
    fs.writeFileSync(subagent, "this machine's subagent\n");
    const plan = await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping);
    expect(plan.transcripts.kept.count).toBe(1);
    expect(plan.transcripts.different.count).toBe(1);
    // This machine's subagent file is shorter, and not the start of the backup's: that shows only as the restore reads it.
    expect(plan.sessionFiles.newer.count).toBe(1);
    const result = await applyRestore(fakeBundle(body(), files), plan, m.targets);
    expect(result.transcripts.kept.count).toBe(1);
    expect(result.transcripts.diverged.count).toBe(1);
    expect(result.sessionFiles.diverged.count).toBe(1);
    expect(fs.readFileSync(here(m, grown), "utf8")).toBe(lines(6));
    expect(fs.readFileSync(here(m, forked), "utf8")).toBe(lines(6, "other"));
    expect(fs.readFileSync(subagent, "utf8")).toBe("this machine's subagent\n");
    const folder = path.basename(path.dirname(here(m, forked)));
    const aside = path.join(result.divergedDir!, "claude", "default", "projects", folder);
    expect(fs.readFileSync(path.join(aside, `${forked}.jsonl`), "utf8")).toBe(lines(4));
    expect(fs.readFileSync(path.join(aside, forked, "subagents", "agent-1.jsonl"), "utf8")).toBe(files[2]!.bytes);
    expect(fs.existsSync(path.join(aside, `${grown}.jsonl`))).toBe(false);
  });
});

describe("replacing a transcript a session here may be writing to", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps this machine's copy first, then looks again, so a write in between leaves it as it is", async () => {
    const m = machine();
    const id = sessionId(1);
    fs.mkdirSync(path.dirname(here(m, id)), { recursive: true });
    fs.writeFileSync(here(m, id), lines(2));
    const files = [transcript(id, undefined, lines(4))];
    const plan = await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping);
    // A session here writes to the transcript just as the restore keeps its copy.
    const link = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, "link").mockImplementation(async (from, to) => {
      if (String(to).startsWith(m.targets.backupsDir) && String(from) === here(m, id)) fs.appendFileSync(here(m, id), lines(1, "live"));
      return link(from, to);
    });
    const result = await applyRestore(fakeBundle(body(), files), plan, m.targets);
    expect(fs.readFileSync(here(m, id), "utf8")).toBe(lines(2) + lines(1, "live"));
    expect(result.transcripts.replaced.count).toBe(0);
    expect(result.transcripts.diverged.count).toBe(1);
  });

  it("replaces it when nothing wrote to it, the copy kept holding the old bytes", async () => {
    const m = machine();
    const id = sessionId(1);
    fs.mkdirSync(path.dirname(here(m, id)), { recursive: true });
    fs.writeFileSync(here(m, id), lines(2));
    const files = [transcript(id, undefined, lines(4))];
    const result = await applyRestore(fakeBundle(body(), files), await planRestore(fakeBundle(body(), files).manifest, m.targets, m.mapping), m.targets);
    expect(result.transcripts.replaced.count).toBe(1);
    expect(fs.readFileSync(here(m, id), "utf8")).toBe(lines(4));
    expect(fs.readFileSync(path.join(result.backupDir!, "claude", "default", "projects", path.basename(path.dirname(here(m, id))), `${id}.jsonl`), "utf8")).toBe(lines(2));
  });
});

describe("open tabs", () => {
  it("are queued only for sessions whose transcript is here after the restore, as plain text", async () => {
    const m = machine();
    const [arriving, already, gone] = [1, 2, 3].map(sessionId) as [string, string, string];
    // This machine has `already`'s transcript, in a folder of its own.
    const elsewhere = path.join(m.projects, "-somewhere-else", `${already}.jsonl`);
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, lines(1));
    const b = body({
      source: { ...SOURCE, host: "alice [laptop](command:workbench.action.reloadWindow)" },
      tabs: [{ label: "proj", folders: ["/home/alice/proj"], tabs: [arriving, already, gone].map((sessionId) => ({ sessionId, title: `[open](command:evil) ${sessionId.slice(-1)}\u202e` })) }],
    });
    const files = [transcript(arriving)];
    const plan = await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping);
    expect(plan.tabs).toMatchObject({ added: 2, gone: 1 });
    const result = await applyRestore(fakeBundle(b, files), plan, m.targets);
    expect(result.tabs).toMatchObject({ added: 2, gone: 1 });
    const pending = m.state.get(PENDING_TABS_KEY) as { sessionId: string; title: string; from: string }[];
    expect(pending.map((tab) => tab.sessionId)).toEqual([arriving, already]);
    expect(pending[0]!.title).toBe("[open] (command:evil) 1");
    expect(pending[0]!.from).toBe("alice [laptop] (command:workbench.action.reloadWindow)");
  });

  it("are not queued again by a second restore of the same backup once reopened or forgotten, and the plan says when it was restored", async () => {
    const m = machine();
    const id = sessionId(1);
    const b = body({ tabs: [{ label: "proj", folders: ["/home/alice/proj"], tabs: [{ sessionId: id, title: "Fix" }] }] });
    const files = [transcript(id)];
    const first = await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping);
    expect(first.restoredBefore).toBeUndefined();
    await applyRestore(fakeBundle(b, files), first, m.targets);
    expect((m.state.get(PENDING_TABS_KEY) as unknown[]).length).toBe(1);
    expect(m.state.get(RESTORED_TABS_KEY)).toHaveLength(1);
    // The tab is reopened: it leaves the pending list.
    await m.state.update(PENDING_TABS_KEY, []);
    const again = await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping);
    expect(again.tabs).toMatchObject({ added: 0, earlier: 1 });
    expect(again.restoredBefore).toBe(NOW);
    await applyRestore(fakeBundle(b, files), again, m.targets);
    expect(m.state.get(PENDING_TABS_KEY)).toEqual([]);
    expect(m.state.get(RESTORED_BACKUPS_KEY)).toEqual([expect.objectContaining({ host: "alice-laptop", createdAt: NOW - DAY, at: NOW })]);
    // Another backup of the same machine queues it again: it was open there then too.
    const later = body({ ...b, createdAt: NOW - DAY / 2 });
    const third = await planRestore(fakeBundle(later, files).manifest, m.targets, m.mapping);
    expect(third.restoredBefore).toBeUndefined();
    expect(third.tabs.added).toBe(1);
  });

  it("and removed worktrees keep only folders a mapping covers, the rest counted as refused", async () => {
    const m = machine();
    const id = sessionId(1);
    const b = body({
      tabs: [
        { label: "covered", folders: ["/home/alice/proj"], tabs: [{ sessionId: id, title: "ok" }] },
        { label: "outside", folders: ["/srv/chosen-by-the-file"], tabs: [{ sessionId: sessionId(2), title: "no" }] },
        { label: "odd", folders: ["/home/alice/CON"], tabs: [{ sessionId: sessionId(3), title: "no" }] },
      ],
    });
    const log = [
      { repo: "/home/alice/proj", path: "/home/alice/wt/ok", removedAt: NOW - DAY },
      { repo: "/home/alice/proj", path: "/tmp/chosen-by-the-file", removedAt: NOW - DAY },
      { repo: "/srv/repo", path: "/home/alice/wt/x", removedAt: NOW - DAY },
      { repo: "/home/alice/proj", path: "/home/alice/wt/a:b", removedAt: NOW - DAY },
    ];
    const files: FakeFile[] = [transcript(id), transcript(sessionId(2)), transcript(sessionId(3)), { entry: { kind: "removed-worktrees", rel: "removed.json", mtime: NOW }, bytes: JSON.stringify(log) }];
    const plan = await planRestore(fakeBundle(b, files).manifest, m.targets, m.mapping);
    expect(plan.tabs).toMatchObject({ added: 1, refused: 2 });
    const result = await applyRestore(fakeBundle(b, files), plan, m.targets);
    expect((m.state.get(PENDING_TABS_KEY) as { cwd: string }[]).map((tab) => tab.cwd)).toEqual([path.join(m.home, "proj")]);
    expect(result.worktreesLog).toEqual({ added: 1, refused: 3 });
    expect(JSON.parse(fs.readFileSync(m.targets.removedWorktreesFile, "utf8"))).toEqual([{ repo: path.join(m.home, "proj"), path: path.join(m.home, "wt", "ok"), removedAt: NOW - DAY }]);
  });
});

describe("what a backup may bring", () => {
  it("takes a session's newest 1,000 notes, quickly however many notes it and this machine's hold", async () => {
    const m = machine();
    const id = sessionId(1);
    const many = Array.from({ length: 160_000 }, (_, i) => ({ id: `n${i}`, text: `note ${i}  `, at: i }));
    const b = body({ notes: [record(id, many)] });
    fs.mkdirSync(m.targets.recordsDir, { recursive: true });
    const mine = new SessionRecords(m.targets.recordsDir);
    fs.writeFileSync(mine.fileOf(id), JSON.stringify(record(id, Array.from({ length: 50_000 }, (_, i) => ({ id: `m${i}`, text: `mine ${i}`, at: i })))));
    const started = performance.now();
    const plan = await planRestore(fakeBundle(b, []).manifest, m.targets, m.mapping);
    await applyRestore(fakeBundle(b, []), plan, m.targets);
    // Merged one by one against every note, it took minutes.
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(plan.notes).toEqual({ added: 0, merged: 1, unchanged: 0, skipped: 0 });
    const notes = new SessionRecords(m.targets.recordsDir).get(id)!.notes!;
    expect(notes).toHaveLength(51_000);
    expect(notes.filter((note) => note.id.startsWith("n")).map((note) => note.at)).toEqual(Array.from({ length: 1_000 }, (_, i) => 159_000 + i));
    // Each through the note page's cleaning.
    expect(notes.find((note) => note.id === "n159999")?.text).toBe("note 159999");
  }, 30_000);

  it("looks at the first 10,000 records with notes and skips the rest", async () => {
    const m = machine();
    const records = Array.from({ length: 10_001 }, (_, i) => record(`s-${i}`, [{ id: "a", text: `only ${i}`, at: 1 }]));
    const plan = await planRestore(fakeBundle(body({ notes: records }), []).manifest, m.targets, m.mapping);
    expect(plan.notes).toEqual({ added: 10_000, merged: 0, unchanged: 0, skipped: 1 });
  });

  it("caps the favourites, the archive, parking and the account names, and keeps only ids that are ids", async () => {
    const m = machine();
    const ids = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}-${i}`);
    m.state.values.set("lookout.archive", ids(4_990, "mine"));
    const b = body({
      state: {
        "lookout.favourites": ["../bad", "has space", "x".repeat(129), ...ids(6_000, "fav")],
        "lookout.archive": ids(100, "arch"),
        "lookout.parking": { parked: ids(600, "p"), kept: ["ok", 5, "bad/id"] },
        "lookout.claudeOrgs": Object.fromEntries(ids(150, "org").map((org) => [org, "k"])),
      },
    });
    await applyRestore(fakeBundle(b, []), await planRestore(fakeBundle(b, []).manifest, m.targets, m.mapping), m.targets);
    const favourites = m.state.get("lookout.favourites") as string[];
    expect(favourites).toHaveLength(5_000);
    expect(favourites[0]).toBe("fav-0");
    // The archive here stays whole; the backup adds up to the cap.
    expect((m.state.get("lookout.archive") as string[]).length).toBe(5_000);
    expect(m.state.get("lookout.parking")).toEqual({ parked: ids(500, "p"), kept: ["ok"] });
    expect(Object.keys(m.state.get("lookout.claudeOrgs") as object)).toHaveLength(100);
  });
});

describe("the backup's history database", () => {
  it("is refused unread when it says it is larger than 2 GiB", async () => {
    const m = machine();
    const huge: FakeFile = { entry: { kind: "history", rel: "history.sqlite", mtime: NOW, size: 2 * 1024 ** 3 + 1 }, bytes: "x" };
    const source = fakeBundle(body(), [huge]);
    const ahead = await readBackupHistory(source, m.base);
    expect(source.visits).toEqual([]);
    expect(ahead?.failed).toBe("it is larger than the 2 GiB a restore takes");
    const plan = await planRestore(source.manifest, m.targets, m.mapping, ahead);
    expect(plan.history?.failed).toBe("it is larger than the 2 GiB a restore takes");
    const again = fakeBundle(body(), [huge]);
    const result = await applyRestore(again, plan, m.targets);
    expect(again.visits).toEqual([]);
    expect(result.history?.failed).toBe("it is larger than the 2 GiB a restore takes");
    expect(fs.readdirSync(m.base).filter((name) => name.startsWith("lookout-restore-"))).toEqual([]);
  });

  it("is read into a folder of the restore's own, and folders a restore left over a day ago are removed", async () => {
    const m = machine();
    const temp = path.join(m.base, "tmp");
    fs.mkdirSync(temp);
    const old = path.join(temp, "lookout-restore-old");
    const fresh = path.join(temp, "lookout-restore-fresh");
    const other = path.join(temp, "something-else");
    for (const dir of [old, fresh, other]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "history.sqlite"), "x");
    }
    const dayAgo = (NOW - 2 * DAY) / 1000;
    fs.utimesSync(old, dayAgo, dayAgo);
    fs.utimesSync(other, dayAgo, dayAgo);
    fs.symlinkSync(other, path.join(temp, "lookout-restore-link"));
    sweepRestoreTemp(temp, NOW);
    expect(fs.readdirSync(temp).sort()).toEqual(["lookout-restore-fresh", "lookout-restore-link", "something-else"]);
  });
});
