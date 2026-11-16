import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectDir } from "../../src/core/agents/claude/paths";
import { writeRetention } from "../../src/core/agents/claude/retention";
import { loadSqlite } from "../../src/core/sqlite";
import { BundleError, SECTIONS, type BundleHeader, type ManifestBody } from "../../src/core/transfer/types";
import { registerRestore, RESTORE_COMMAND, type RestoreDeps } from "../../src/vscode/restore";
import type { RetentionOutcome } from "../../src/vscode/controller";
import { sessionId, tempConfigDir } from "../core/helpers";
import { fakeBundle, historyBytes, type FakeFile } from "../core/transfer/fakeBundle";
import { stub, type StubNotice } from "./stub-vscode";

// Key derivation, compression and SQLite at real sizes: slower runners need more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const sqlite = loadSqlite() !== undefined;
const NOW = Date.UTC(2026, 10, 14, 9, 30);
const PASSPHRASE = "correct horse battery";
const NOTE = "a private thought about the webhook";

/** VS Code's globalState, in memory. */
class Memento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T | undefined {
    return this.values.has(key) ? (structuredClone(this.values.get(key)) as T) : fallback;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

const DAY = 24 * 60 * 60_000;

function setup(options: { encrypted?: boolean; history?: boolean; mtime?: number; host?: string; open?: () => Promise<never>; repos?: ManifestBody["repos"]; tabs?: ManifestBody["tabs"] } = {}) {
  const base = fs.realpathSync.native(tempConfigDir());
  const home = path.join(base, "home", "bob");
  const claude = path.join(home, ".claude");
  const storage = path.join(base, "storage");
  const temp = path.join(storage, "tmp");
  fs.mkdirSync(home, { recursive: true });
  const id = sessionId(1);
  const gone = sessionId(2);
  const backupFile = path.join(base, "alice-laptop-2026-11-14.lookout");
  const host = options.host ?? "alice-laptop";
  const body: ManifestBody = {
    format: 1,
    createdAt: NOW,
    lookoutVersion: "0.1.5",
    source: { host, platform: "linux", home: "/home/alice", wsl: true },
    sections: [...SECTIONS],
    state: { "lookout.favourites": [id] },
    notes: [{ v: 1, id, agent: "claude-code", cwd: "/home/alice/proj", notes: [{ id: "n1", text: NOTE, at: 1 }] }],
    tabs: [],
    claudeDirs: [{ label: "default", resolved: "/home/alice/.claude", isDefault: true }],
    ...(options.repos ? { repos: options.repos } : {}),
  };
  if (options.tabs) body.tabs = options.tabs;
  const files: FakeFile[] = [{ entry: { kind: "transcript", dir: "default", rel: `-home-alice-proj/${id}.jsonl`, sessionId: id, cwd: "/home/alice/proj", mtime: options.mtime ?? Date.now() - DAY }, bytes: '{"type":"user"}\n' }];
  if (options.history) {
    const rows = [{ id: gone, agent: "claude-code", file: `/home/alice/.claude/projects/-home-alice-old/${gone}.jsonl`, cwd: "/home/alice/old", purgedAt: NOW - 1000, messages: ["an old conversation"] }];
    files.unshift({ entry: { kind: "history", rel: "history.sqlite", mtime: NOW }, bytes: historyBytes(base, rows) });
  }
  const header: BundleHeader = { format: 1, cipher: options.encrypted ? "aes-256-gcm-stream" : "none", codec: "zstd", createdAt: NOW, host };
  let opens = 0;
  const deps: RestoreDeps = {
    claudeDirs: () => [{ dir: claude, resolved: claude, label: "default", isDefault: true }],
    recordsDir: path.join(storage, "sessions"),
    storeFile: path.join(storage, "history.sqlite"),
    vaultDir: path.join(storage, "vault"),
    usageDir: path.join(storage, "usage"),
    removedWorktreesFile: path.join(storage, "worktrees", "removed.json"),
    home,
    reader: {
      readBundleHeader: async (file) => {
        if (file !== backupFile) throw new BundleError("not-a-backup", "no magic");
        return header;
      },
      openBundle: async (_file, passphrase) => {
        opens++;
        if (options.open) return options.open();
        if (options.encrypted && passphrase !== PASSPHRASE) throw new BundleError("wrong-passphrase", "the first segment did not open");
        return fakeBundle(body, files, header);
      },
    },
  };
  const memento = new Memento();
  const context = { globalState: memento, globalStorageUri: { fsPath: storage } } as never;
  const disposable = registerRestore(context, deps);
  let reloaded = 0;
  stub.commands.set("workbench.action.reloadWindow", () => void reloaded++);
  stub.openDialog = (asked) => ((asked as { canSelectFolders?: boolean }).canSelectFolders ? undefined : [backupFile]);
  return {
    base,
    home,
    claude,
    id,
    gone,
    temp,
    storage,
    memento,
    deps,
    disposable,
    backupFile,
    opens: () => opens,
    reloaded: () => reloaded,
    transcriptIn: (folder: string) => path.join(claude, "projects", encodeProjectDir(folder), `${id}.jsonl`),
  };
}

async function run(): Promise<void> {
  await stub.commands.get(RESTORE_COMMAND)!();
}

function modals(): StubNotice[] {
  return stub.notices.filter((notice) => notice.modal);
}

describe("Restore from Backup…", () => {
  beforeEach(() => stub.reset());

  it("shows what it would do, restores on the user's say-so, and says what it did", async () => {
    const t = setup();
    stub.answerNotice = (notice) => (notice.modal ? "Restore" : undefined);
    await run();
    const [summary] = modals();
    expect(summary?.message).toBe("Restore the backup of alice-laptop?");
    expect(summary?.actions).toEqual(["Restore", "Change Folder Mapping…"]);
    expect(summary?.detail).toContain("Made on alice-laptop (Linux under WSL) on ");
    expect(summary?.detail).toContain(`Folders: /home/alice → ${t.home}`);
    expect(summary?.detail).toContain("Notes: notes on 1 session to add.");
    expect(summary?.detail).toContain("Favourites and choices: favourites taken from the backup.");
    expect(summary?.detail).toContain("Claude transcripts: 1 new (1 KB).");
    expect(summary?.detail).toContain(`Folders not on this machine (1):\n  ${path.join(t.home, "proj")} (1 session)`);
    expect(summary?.detail).not.toContain(NOTE);
    expect(fs.readFileSync(t.transcriptIn(path.join(t.home, "proj")), "utf8")).toBe('{"type":"user"}\n');
    expect(t.memento.get("lookout.favourites")).toEqual([t.id]);
    const closing = stub.notices.at(-1)!;
    expect(closing).toMatchObject({ kind: "info", modal: false, actions: [] });
    expect(closing.message).toContain("Lookout restored notes on 1 session, 1 transcript and favourites and choices.");
    expect(t.reloaded()).toBe(0);
    t.disposable.dispose();
  });

  it.skipIf(!sqlite)("asks for the passphrase again after a wrong one, reads the history ahead, and never shows the passphrase", async () => {
    const t = setup({ encrypted: true, history: true });
    const typed = ["not it", PASSPHRASE];
    stub.inputBox = () => typed.shift();
    stub.answerNotice = (notice) => (notice.modal ? "Restore" : undefined);
    await run();
    const asked = stub.ops.filter(([target]) => target === "inputBox").map(([, , options]) => (options as { prompt: string; password: boolean }));
    expect(asked.map((options) => options.password)).toEqual([true, true]);
    expect(asked[1]!.prompt).toBe("That passphrase does not open this backup. Enter it again.");
    // Opened with the wrong one, the right one, and again for the restore after the history was read ahead.
    expect(t.opens()).toBe(3);
    expect(modals()[0]!.detail).toContain("Conversation history: 1 session whose transcripts are gone to add.");
    expect(stub.notices.at(-1)!.message).toContain("1 conversation from the history");
    expect(JSON.stringify([stub.ops, stub.notices])).not.toContain(PASSPHRASE);
    expect(JSON.stringify([stub.ops, stub.notices])).not.toContain(NOTE);
    expect(fs.readdirSync(t.temp)).toEqual([]);
  });

  it("changes the folder mapping when asked, folder by folder, and shows the new one before restoring", async () => {
    const t = setup();
    const elsewhere = path.join(t.base, "elsewhere");
    const real = path.join(t.base, "real-proj");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(real);
    let summaries = 0;
    stub.answerNotice = (notice) => (notice.modal ? (++summaries === 1 ? "Change Folder Mapping…" : "Restore") : undefined);
    stub.inputBox = () => elsewhere;
    // The one folder still missing is picked, and said to be `real`.
    stub.quickPick = (items) => (items as { from?: string }[]).find((item) => item.from === "/home/alice/proj");
    stub.openDialog = (asked) => ((asked as { canSelectFolders?: boolean }).canSelectFolders ? [real] : [t.backupFile]);
    await run();
    const [first, second] = modals();
    expect(first?.detail).toContain(`Folders: /home/alice → ${t.home}`);
    expect(second?.detail).toContain(`Folders: /home/alice → ${elsewhere}; /home/alice/proj → ${real}`);
    expect(second?.detail).not.toContain("Folders not on this machine");
    expect(fs.existsSync(t.transcriptIn(real))).toBe(true);
  });

  it.skipIf(!sqlite)("restores nothing when the user backs out at the summary, and lets go of what it read", async () => {
    const t = setup({ history: true });
    stub.answerNotice = () => undefined;
    await run();
    expect(modals()).toHaveLength(1);
    expect(fs.existsSync(t.claude)).toBe(false);
    expect(t.memento.keys()).toEqual([]);
    expect(fs.readdirSync(t.temp)).toEqual([]);
  });

  it("says plainly when the file is not a backup", async () => {
    const t = setup();
    stub.openDialog = () => [path.join(t.base, "notes.txt")];
    await run();
    expect(stub.notices).toEqual([{ kind: "error", message: "That file is not a Lookout backup.", modal: false, detail: undefined, actions: [] }]);
  });

  it("does nothing when no file is picked", async () => {
    setup();
    stub.openDialog = () => undefined;
    await run();
    expect(stub.notices).toEqual([]);
  });
});


describe("Restore from Backup… and Claude Code's retention", () => {
  beforeEach(() => stub.reset());

  /** A transcript last written 100 days ago, less a minute: Claude Code's default keeps 30. */
  const OLD = () => Date.now() - 100 * DAY + 60_000;

  /** Writes the setting into Claude Code's user settings as the controller does, saying whether the transcript was written yet. */
  function applying(t: ReturnType<typeof setup>, written: boolean[]): () => RetentionOutcome | undefined {
    return () => {
      written.push(fs.existsSync(t.transcriptIn(path.join(t.home, "proj"))));
      const days = stub.config["lookout.retention.days"] as number;
      const outcome = writeRetention(t.claude, days);
      return outcome.ok ? { kind: "written", days, file: outcome.file } : { kind: "failed", days, file: outcome.file, why: outcome.why };
    };
  }

  it("says plainly which restored transcripts Claude Code would delete, and keeps them on the user's say-so before writing any", async () => {
    const t = setup({ mtime: OLD() });
    const written: boolean[] = [];
    t.deps.applyRetention = applying(t, written);
    stub.answerNotice = (notice) => (notice.modal ? "Restore and Keep Them" : undefined);
    await run();
    const [summary, ...more] = modals();
    expect(summary?.actions).toEqual(["Restore and Keep Them", "Restore", "Change Folder Mapping…"]);
    expect(summary?.detail).toContain("Claude Code deletes transcripts last written more than 30 days ago when it starts, and 1 restored transcript (1 KB) is older, the oldest 100 days old.");
    expect(summary?.detail).toContain("Restore puts it back, and Claude Code deletes it at its next start");
    expect(summary?.detail).toContain("Restore and Keep Them first sets lookout.retention.days to 130");
    expect(more).toEqual([]);
    expect(stub.ops).toContainEqual(["config:lookout", "update", { key: "retention.days", value: 130, target: 1 }]);
    // The setting reached Claude Code's settings before the transcript was written.
    expect(written).toEqual([false]);
    expect(JSON.parse(fs.readFileSync(path.join(t.claude, "settings.json"), "utf8"))).toEqual({ cleanupPeriodDays: 130 });
    expect(fs.existsSync(t.transcriptIn(path.join(t.home, "proj")))).toBe(true);
  });

  it("restores as asked with plain Restore, the setting left alone", async () => {
    const t = setup({ mtime: OLD() });
    const written: boolean[] = [];
    t.deps.applyRetention = applying(t, written);
    stub.answerNotice = (notice) => (notice.modal ? "Restore" : undefined);
    await run();
    expect(written).toEqual([]);
    expect(stub.ops.some(([target]) => target === "config:lookout")).toBe(false);
    expect(fs.existsSync(t.transcriptIn(path.join(t.home, "proj")))).toBe(true);
  });

  it("says when managed settings still win, and restores only on the user's say-so", async () => {
    for (const answer of [undefined, "Restore Anyway"]) {
      stub.reset();
      const t = setup({ mtime: OLD() });
      fs.mkdirSync(t.claude, { recursive: true });
      const managed = path.join(t.claude, "remote-settings.json");
      fs.writeFileSync(managed, JSON.stringify({ cleanupPeriodDays: 3 }));
      t.deps.applyRetention = () => ({ kind: "managed", days: stub.config["lookout.retention.days"] as number, file: managed });
      stub.answerNotice = (notice) => (!notice.modal ? undefined : notice.actions.includes("Restore Anyway") ? answer : "Restore and Keep Them");
      await run();
      const warning = modals()[1]!;
      expect(warning.message).toBe("Claude Code would still delete 1 restored transcript at its next start.");
      expect(warning.detail).toContain(`Managed settings at ${managed} keep transcripts 3 days in ${t.claude}, and they win over the user's settings.`);
      expect(fs.existsSync(t.transcriptIn(path.join(t.home, "proj")))).toBe(answer !== undefined);
    }
  });
});

describe("Restore from Backup… with a backup from someone else", () => {
  beforeEach(() => stub.reset());

  it("shows what the backup says only as plain text, never a link", async () => {
    setup({ encrypted: true, host: "laptop [Open](command:workbench.action.quit)" });
    stub.inputBox = () => PASSPHRASE;
    stub.answerNotice = (notice) => (notice.modal ? "Restore" : undefined);
    await run();
    const prompts = stub.ops.filter(([target]) => target === "inputBox").map(([, , options]) => (options as { prompt: string }).prompt);
    const shown = [...prompts, ...stub.notices.flatMap((notice) => [notice.message, notice.detail ?? ""])];
    expect(shown.some((text) => text.includes("laptop [Open] (command:workbench.action.quit)"))).toBe(true);
    for (const text of shown) expect(text).not.toMatch(/\]\(/);
  });

  it("shows an error's text as plain text", async () => {
    setup({ open: () => Promise.reject(new Error("see [here](command:workbench.action.quit)")) });
    await run();
    expect(stub.notices.at(-1)?.message).toBe("Lookout could not restore the backup: see [here] (command:workbench.action.quit)");
  });

  it("says a file that is damaged or incomplete is", async () => {
    setup({ open: () => Promise.reject(new BundleError("truncated", "The backup file is damaged or incomplete.")) });
    await run();
    expect(stub.notices.at(-1)?.message).toBe("The backup file is damaged or incomplete. Copy it again from the machine it was made on.");
  });

  it("asks to restore only a backup the user made, and says when this one was restored before", async () => {
    setup();
    stub.answerNotice = (notice) => (notice.modal ? "Restore" : undefined);
    await run();
    expect(modals()[0]!.detail).toContain("Restore only a backup you made yourself: its conversations become Claude Code's to resume.");
    expect(modals()[0]!.detail).not.toContain("restored on this machine before");
    stub.notices = [];
    await run();
    expect(modals()[0]!.detail).toContain("This backup was restored on this machine before, on ");
  });

  it("keeps this machine's transcript when it went on differently, and says where the backup's copy is", async () => {
    const t = setup();
    const mine = t.transcriptIn(path.join(t.home, "proj"));
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, '{"type":"mine"}\n');
    stub.answerNotice = (notice) => (notice.modal ? "Restore" : undefined);
    await run();
    expect(modals()[0]!.detail).toContain("Claude transcripts: 1 that went on differently here, kept as they are with the backup's set aside.");
    expect(fs.readFileSync(mine, "utf8")).toBe('{"type":"mine"}\n');
    const closing = stub.notices.at(-1)!.message;
    const dir = /the backup's copies are in (.+?\bdiverged)\./.exec(closing)?.[1];
    expect(closing).toContain("Kept as they are here, having gone on differently from the backup's: 1 transcript;");
    expect(dir).toBe(path.join(t.storage, "restore-backups", fs.readdirSync(path.join(t.storage, "restore-backups"))[0]!, "diverged"));
    expect(fs.readFileSync(path.join(dir!, "claude", "default", "projects", path.basename(path.dirname(mine)), `${t.id}.jsonl`), "utf8")).toBe('{"type":"user"}\n');
  });

  it("reads the history into Lookout's own temporary folder, only the user's, and clears what restores left there", async () => {
    const t = setup();
    fs.mkdirSync(t.temp, { recursive: true });
    const stale = path.join(t.temp, "lookout-restore-stale");
    fs.mkdirSync(stale);
    const old = (Date.now() - 2 * DAY) / 1000;
    fs.utimesSync(stale, old, old);
    stub.answerNotice = () => undefined;
    await run();
    expect(fs.existsSync(stale)).toBe(false);
    if (process.platform !== "win32") expect(fs.statSync(t.temp).mode & 0o777).toBe(0o700);
  });
});

describe("Restore from Backup… and the backup's repositories and tabs", () => {
  beforeEach(() => stub.reset());

  /** A clone with this remote, as git writes its config. */
  const clone = (dir: string, url: string) => {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
    return dir;
  };
  const repos = [{ root: "/home/alice/proj", linked: false, remotes: ["alice/proj"] }];

  it("finds a repository renamed here by its git remote, says so, and puts its transcripts where Claude Code looks for that clone", async () => {
    const t = setup({ repos });
    const renamed = clone(path.join(t.home, "code", "renamed"), "git@github.com:alice/proj.git");
    stub.answerNotice = (notice) => (notice.modal ? "Restore" : undefined);
    await run();
    const [summary] = modals();
    expect(summary?.detail).toContain(`Folders: /home/alice → ${t.home}\nRepositories found here by their git remote (1):\n  /home/alice/proj → ${renamed}`);
    expect(summary?.detail).not.toContain("Folders not on this machine");
    expect(fs.existsSync(t.transcriptIn(renamed))).toBe(true);
    expect(fs.existsSync(t.transcriptIn(path.join(t.home, "proj")))).toBe(false);
  });

  it("names a repository with several clones here, and takes the one Change Folder Mapping… picks", async () => {
    const t = setup({ repos });
    const one = clone(path.join(t.home, "a", "proj"), "git@github.com:alice/proj.git");
    clone(path.join(t.home, "b", "proj"), "https://github.com/alice/proj");
    let asked = 0;
    stub.answerNotice = (notice) => (notice.modal ? (asked++ === 0 ? "Change Folder Mapping…" : "Restore") : undefined);
    // The home folder stays; the repository is the one picked.
    stub.inputBox = () => t.home;
    stub.quickPick = (items) => {
      const list = items as { label: string; choices?: string[]; choice?: string }[];
      return list.find((item) => item.choices) ?? list.find((item) => item.choice === one) ?? list[0];
    };
    await run();
    const [first, second] = modals();
    expect(first?.detail).toContain(`Repositories with several clones here (1), left where the folders above put them until Change Folder Mapping… says which:\n  /home/alice/proj: ${one}, ${path.join(t.home, "b", "proj")}`);
    expect(second?.detail).toContain(`Repositories found here by their git remote (1):\n  /home/alice/proj → ${one}`);
    expect(second?.detail).not.toContain("several clones");
    expect(fs.existsSync(t.transcriptIn(one))).toBe(true);
  });

  it("offers to reopen the restored tabs from its closing message", async () => {
    const t = setup({ tabs: [{ label: "proj", folders: ["/home/alice/proj"], tabs: [{ sessionId: sessionId(1), title: "Billing" }] }] });
    let listed = 0;
    stub.commands.set("lookout.reopenTabs", () => void listed++);
    stub.answerNotice = (notice) => (notice.modal ? "Restore" : notice.actions.includes("Reopen Tabs…") ? "Reopen Tabs…" : undefined);
    await run();
    await vi.waitFor(() => expect(listed).toBe(1));
    const done = stub.notices.find((notice) => notice.actions.includes("Reopen Tabs…"));
    expect(done?.message).toContain("1 tab to reopen");
    expect(t.memento.values.size).toBeGreaterThan(0);
  });
});
