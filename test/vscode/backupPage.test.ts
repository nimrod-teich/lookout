import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SectionId, SourceMachine, WindowTabs } from "../../src/core/transfer/types";
import type { BackupChoice, BackupState } from "../../src/webview/backupProtocol";
import type { BackUpOptions, BackupCore, Inventory, InventoryItem, InventorySources, Selection } from "../../src/vscode/backupCore";
import { BACK_UP, BACKUP_VIEW_TYPE, BackupPage, defaultFileName, registerBackUp, type BackUpDeps } from "../../src/vscode/backupPage";
import { stub, Uri } from "./stub-vscode";

const DAY = 24 * 60 * 60_000;
const NOW = Date.now();
const PASSPHRASE = "correct horse battery staple";
const S1 = "00000000-0000-4000-8000-000000000001";
const S2 = "00000000-0000-4000-8000-000000000002";
const S3 = "00000000-0000-4000-8000-000000000003";
const ALL: SectionId[] = ["state", "notes", "tabs", "history", "transcripts", "subagents", "toolResults", "vault", "usage", "worktreesLog"];

function item(section: SectionId, kind: InventoryItem["kind"], rel: string, size: number, extra: Partial<InventoryItem> = {}): InventoryItem {
  return { section, kind, rel, abs: `/claude/projects/${rel}`, size, ...extra };
}

/** Three sessions in two repositories, one of them old, with what goes with them and the rest. */
function inventory(): Inventory {
  const items = [
    item("history", "history", "history.sqlite", 4000),
    item("transcripts", "transcript", `-src-api/${S1}.jsonl`, 1000, { sessionId: S1, repo: "/src/api", lastActive: NOW - 2 * DAY }),
    item("subagents", "subagent", `-src-api/${S1}/subagents/a.jsonl`, 200, { sessionId: S1 }),
    item("transcripts", "transcript", `-src-api/${S2}.jsonl`, 3000, { sessionId: S2, repo: "/src/api", lastActive: NOW - 40 * DAY }),
    item("subagents", "subagent", `-src-api/${S2}/subagents/b.jsonl`, 300, { sessionId: S2 }),
    item("transcripts", "transcript", `-src-web/${S3}.jsonl`, 500, { sessionId: S3, repo: "/src/web", lastActive: NOW - DAY }),
    item("toolResults", "tool-result", `-src-web/${S3}/tool-results/t.txt`, 100, { sessionId: S3 }),
    item("vault", "vault", "kept.jsonl", 700),
    item("usage", "usage", "alerts/a.json", 50),
    item("worktreesLog", "removed-worktrees", "removed.json", 20),
  ];
  return {
    items,
    notes: [
      { v: 1, id: S1, agent: "claude-code", notes: [{ id: "n1", text: "one", at: 1 }, { id: "n2", text: "two", at: 2 }] },
      { v: 1, id: S2, agent: "claude-code", notes: [{ id: "n3", text: "three", at: 3 }] },
    ],
    state: { "lookout.favourites": [S1], "lookout.archive": [S2, S3], "lookout.parking": { parked: [S3], kept: [] }, "lookout.sort": { by: "recent" } },
    tabs: [
      { label: "api", folders: ["/src/api"], tabs: [{ sessionId: S1, title: "One" }, { sessionId: S2, title: "Two" }] },
      { label: "empty", folders: [], tabs: [] },
    ],
    claudeDirs: [{ dir: "/claude", label: "default", resolved: "/claude", isDefault: true }],
    totals: {} as Inventory["totals"],
    takenAt: Date.now(),
    repos: [
      { repo: "/src/web", sessions: 1, bytes: 600 },
      { repo: "/src/api", sessions: 2, bytes: 4500 },
    ],
  };
}

const TRANSCRIPT_SECTIONS = new Set<SectionId>(["transcripts", "subagents", "toolResults"]);

/** Selects as the core does: a session's subagents and tool outputs follow its transcript's age and repository. */
function select(inv: Inventory, selection: Selection): InventoryItem[] {
  const on = new Set(selection.sections);
  return inv.items.filter((one) => {
    if (!on.has(one.section)) return false;
    if (!TRANSCRIPT_SECTIONS.has(one.section)) return true;
    const lead = inv.items.find((other) => other.kind === "transcript" && other.sessionId === one.sessionId) ?? one;
    if (selection.activeWithinDays !== undefined && (lead.lastActive ?? 0) < NOW - selection.activeWithinDays * DAY) return false;
    return !selection.repos || selection.repos.includes(lead.repo ?? "");
  });
}

interface BackUpCall {
  file: string;
  selection: Selection;
  options: BackUpOptions;
  signal?: AbortSignal;
}

/** The core, in memory: the write puts a partial file down, then moves it into place or drops it. */
function fakeCore(over: Partial<BackupCore> & { hold?: boolean; vanish?: number } = {}) {
  const sources: InventorySources[] = [];
  const writes: BackUpCall[] = [];
  const core: BackupCore = {
    takeInventory: async (given) => {
      sources.push(given);
      return inventory();
    },
    select,
    estimate: (items, codec, level) => Math.round(items.reduce((sum, one) => sum + one.size, 0) * (codec === "gzip" ? 0.3 : level === 9 ? 0.12 : 0.13)),
    async backUp(file, inv, selection, options, progress, signal) {
      writes.push({ file, selection, options, signal });
      const items = select(inv, selection);
      const total = items.reduce((sum, one) => sum + one.size, 0);
      const partial = `${file}.partial`;
      fs.writeFileSync(partial, "LOOKOUTB");
      let done = 0;
      for (const one of items) {
        done += one.size;
        progress?.(done, total);
      }
      if (over.hold) {
        await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      if (signal?.aborted) {
        fs.rmSync(partial, { force: true });
        throw new Error("aborted");
      }
      fs.renameSync(partial, file);
      const gone = items.slice(0, over.vanish ?? 0);
      return { bytes: 8, files: items.length - gone.length, skipped: gone.map((item) => ({ item, why: "is gone" })) };
    },
    zstdAvailable: () => true,
    ...over,
  };
  return { core, sources, writes };
}

function setup(over: Parameters<typeof fakeCore>[0] = {}, deps: Partial<BackUpDeps> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-backup-"));
  const { core, sources, writes } = fakeCore(over);
  const tabs: WindowTabs[] = [];
  const fullDeps: BackUpDeps = {
    claudeDirs: () => [{ dir: "/claude", resolved: "/claude", label: "default", isDefault: true }],
    storeFile: "/storage/history.sqlite",
    recordsDir: "/storage/sessions",
    vaultDir: "/storage/vault",
    usageDir: "/storage/usage",
    removedWorktreesFile: "/storage/worktrees/removed.json",
    tabs: async () => tabs,
    ...deps,
  };
  const machine: SourceMachine = { host: "devbox", platform: "linux", home, wsl: false };
  const tempDir = path.join(home, "storage", "tmp");
  const page = new BackupPage({ fsPath: "/ext" } as never, fullDeps, { state: () => ({ "lookout.favourites": [S1] }), version: "9.9.9", machine: async () => machine, tempDir }, core);
  return { home, page, core, sources, writes, tempDir };
}

/** The page's last state, as the panel was sent it. */
function shown(): BackupState {
  const posted = stub.panels.at(-1)!.posted.filter((m): m is { type: "state"; state: BackupState } => (m as { type?: string }).type === "state");
  return posted.at(-1)!.state;
}

async function settled(page: BackupPage): Promise<void> {
  await vi.waitFor(() => expect(page.current.busy).toBeUndefined());
}

function choice(over: Partial<BackupChoice> = {}): BackupChoice {
  return { sections: [...ALL], skipRepos: [], level: "fast", encrypt: true, ...over };
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("BackupPage", () => {
  beforeEach(() => {
    stub.reset();
    stub.commands.set("revealFileInOS", () => undefined);
  });

  it("looks at what there is when it opens, telling the page first, and lists each section with its count and size", async () => {
    let toldFirst = false;
    const { page, core, sources } = setup();
    const take = core.takeInventory;
    core.takeInventory = async (given) => {
      toldFirst = stub.panels[0]!.posted.some((m) => (m as { state?: BackupState }).state?.busy === "look");
      return take(given);
    };
    page.show();
    expect(page.current.busy).toBe("look");
    await settled(page);
    expect(toldFirst).toBe(true);
    expect(sources[0]).toMatchObject({ storeFile: "/storage/history.sqlite", recordsDir: "/storage/sessions", vaultDir: "/storage/vault", usageDir: "/storage/usage", removedWorktreesFile: "/storage/worktrees/removed.json", state: { "lookout.favourites": [S1] }, tabs: [] });
    expect(sources[0]!.claudeDirs.map((dir) => dir.label)).toEqual(["default"]);
    const rows = Object.fromEntries(shown().sections.map((row) => [row.id, row]));
    expect(rows.transcripts).toEqual({ id: "transcripts", count: 3, bytes: 4500 });
    expect(rows.subagents).toEqual({ id: "subagents", count: 2, bytes: 500 });
    expect(rows.toolResults).toEqual({ id: "toolResults", count: 1, bytes: 100 });
    expect(rows.history).toEqual({ id: "history", count: 1, bytes: 4000 });
    expect(rows.notes).toMatchObject({ count: 3, detail: "3 notes on 2 sessions" });
    expect(rows.state).toMatchObject({ count: 5, detail: "1 starred · 2 archived · 1 parked · board order" });
    expect(rows.tabs).toMatchObject({ count: 2, detail: "2 tabs in 1 window" });
    for (const row of shown().sections) if (row.count) expect(row.bytes, row.id).toBeGreaterThan(0);
    // The biggest repository first, by name.
    expect(shown().repos).toEqual([
      { repo: "/src/api", name: "api", sessions: 2, bytes: 4500 },
      { repo: "/src/web", name: "web", sessions: 1, bytes: 600 },
    ]);
    // Every section in to begin with: every file, its size, and both levels' estimates.
    expect(shown().chosen).toMatchObject({ sessions: 3, files: 10 });
    expect(shown().chosen!.estimate.smaller).toBeLessThan(shown().chosen!.estimate.fast);
    expect(shown()).toMatchObject({ host: "devbox", zstd: true });
    // Brought forward, it does not look again; opened anew, it does.
    page.show();
    expect(sources).toHaveLength(1);
    stub.panels[0]!.dispose();
    page.show();
    await settled(page);
    expect(sources).toHaveLength(2);
    page.dispose();
  });

  it("works out what a choice takes as it changes: the age, the repositories, the inclusions", async () => {
    const { page } = setup();
    page.show();
    await settled(page);
    const panel = stub.panels[0]!;
    panel.receive({ type: "choose", choice: choice({ days: 7, skipRepos: ["/src/web"], sections: ALL.filter((id) => id !== "toolResults") }) });
    await vi.waitFor(() => expect(shown().chosen?.sessions).toBe(1));
    const chosen = shown().chosen!;
    expect(chosen.sections.transcripts).toEqual({ count: 1, bytes: 1000 });
    expect(chosen.sections.subagents).toEqual({ count: 1, bytes: 200 });
    expect(chosen.sections.toolResults).toBeUndefined();
    // Each repository as the age filter and the inclusions leave it, ticked or not.
    expect(chosen.repos).toEqual({ "/src/api": { sessions: 1, bytes: 1200 }, "/src/web": { sessions: 1, bytes: 500 } });
    // Without the transcripts, their subagents and tool outputs stay out too.
    panel.receive({ type: "choose", choice: choice({ sections: ["subagents", "toolResults", "notes"] }) });
    await vi.waitFor(() => expect(shown().chosen?.files).toBe(0));
    expect(Object.keys(shown().chosen!.sections)).toEqual(["notes"]);
    // What is not a choice changes nothing.
    panel.receive({ type: "choose", choice: "everything" });
    panel.receive({ type: "choose" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(Object.keys(shown().chosen!.sections)).toEqual(["notes"]);
    page.dispose();
  });

  it("asks for a passphrase whatever goes in, unless Don't encrypt is ticked, from the page or a message made up to skip it", async () => {
    const { page, writes } = setup();
    page.show();
    await settled(page);
    const panel = stub.panels[0]!;
    const dialogs = () => stub.ops.filter(([target, action]) => target === "window" && action === "showSaveDialog").length;
    const refused = "Type a passphrase, or tick Don't encrypt.";
    panel.receive({ type: "save", choice: choice() });
    await vi.waitFor(() => expect(page.current.error).toBe(refused));
    expect(dialogs()).toBe(0);
    // A new try clears what the last one said.
    await page.save(choice({ encrypt: false }), undefined);
    expect([dialogs(), page.current.error]).toEqual([1, undefined]);
    // Notes, lists and tabs alone want one too: their titles, folders and session ids are the user's.
    for (const sections of [["notes"], ["notes", "state"], ["tabs"], ["usage", "worktreesLog"]] as SectionId[][]) {
      await page.save(choice({ sections }), undefined);
      expect([dialogs(), page.current.error], sections.join()).toEqual([1, refused]);
    }
    // A message with an empty passphrase, none, or an "encrypt" that is not false is refused as well.
    for (const message of [
      { type: "save", choice: { sections: ["notes"], skipRepos: [], level: "fast", encrypt: true }, passphrase: "" },
      { type: "save", choice: { sections: ["notes"], skipRepos: [], level: "fast" } },
      { type: "save", choice: { sections: ["notes"], skipRepos: [], level: "fast", encrypt: "no" }, passphrase: 7 },
    ]) {
      await page.save(choice({ encrypt: false, sections: ["notes"] }), undefined);
      expect(page.current.error).toBeUndefined();
      const before = dialogs();
      panel.receive(message);
      await vi.waitFor(() => expect(page.current.error).toBe(refused));
      expect(dialogs(), JSON.stringify(message)).toBe(before);
    }
    // With a passphrase, notes alone go ahead.
    await page.save(choice({ sections: ["notes", "state"] }), PASSPHRASE);
    expect(page.current.error).toBeUndefined();
    // Dismissed: nothing written.
    expect(writes).toHaveLength(0);
    expect(page.current.busy).toBeUndefined();
    page.dispose();
  });

  it("saves where the dialog says, offering the home folder and the host's name and the day, with the passphrase in the write alone", async () => {
    const { page, home, writes, tempDir } = setup();
    page.show();
    await settled(page);
    const target = path.join(home, "out.lookout");
    let asked: { defaultUri?: { fsPath: string }; filters?: unknown } = {};
    stub.saveDialog = (options) => {
      asked = options as typeof asked;
      return Uri.file(target);
    };
    const panel = stub.panels[0]!;
    panel.receive({ type: "save", choice: choice({ level: "smaller" }), passphrase: PASSPHRASE });
    await vi.waitFor(() => expect(page.current.summary).toBeDefined());
    expect(asked.defaultUri?.fsPath).toBe(path.join(home, `lookout-devbox-${today()}.lookout`));
    expect(asked.filters).toEqual({ "Lookout backup": ["lookout"] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ file: target, selection: { sections: ALL }, options: { passphrase: PASSPHRASE, codec: "zstd", level: 9, host: "devbox", lookoutVersion: "9.9.9", source: { host: "devbox", home }, tempDir } });
    expect(page.current.summary).toMatchObject({ file: target, name: "out.lookout", bytes: fs.statSync(target).size, sessions: 3, files: 10, left: 0, encrypted: true });
    // The history's snapshot goes in a folder made for it that only the user reads.
    if (process.platform !== "win32") expect(fs.statSync(tempDir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(`${target}.partial`)).toBe(false);
    // Progress showed in a notification that can be cancelled, and on the page.
    expect(stub.ops).toContainEqual(["window", "withProgress", expect.objectContaining({ cancellable: true })]);
    const increments = stub.ops.filter(([target]) => target === "progress").map(([, , value]) => (value as { increment: number }).increment);
    expect(increments.reduce((sum, n) => sum + n, 0)).toBe(100);
    expect(panel.posted.filter((m) => (m as { type?: string }).type === "progress").at(-1)).toEqual({ type: "progress", progress: { done: 9870, total: 9870 } });
    // The passphrase went to the write and nowhere else.
    for (const where of [panel.posted, stub.ops, page.current]) expect(JSON.stringify(where)).not.toContain(PASSPHRASE);
    // The page was in sight: no notification.
    expect(stub.ops.some(([target, action]) => target === "window" && action === "info")).toBe(false);
    page.dispose();
  });

  it("stops the write from the notification's Cancel or the page's Stop, leaving no file", async () => {
    const { page, home } = setup({ hold: true });
    page.show();
    await settled(page);
    const panel = stub.panels[0]!;
    const target = path.join(home, "stopped.lookout");
    stub.saveDialog = () => Uri.file(target);
    for (const stop of [() => stub.cancelProgress.fire(), () => panel.receive({ type: "stop" })]) {
      panel.receive({ type: "save", choice: choice({ encrypt: false }) });
      await vi.waitFor(() => expect(page.current.busy).toBe("write"));
      await vi.waitFor(() => expect(fs.existsSync(`${target}.partial`)).toBe(true));
      stop();
      await settled(page);
      expect(page.current).toMatchObject({ notice: "The backup was stopped; nothing was saved.", error: undefined, summary: undefined });
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(`${target}.partial`)).toBe(false);
    }
    page.dispose();
  });

  it("says why a write failed, and leaves no partial file", async () => {
    const { page, home } = setup({
      backUp: async (file) => {
        fs.writeFileSync(`${file}.partial`, "half");
        throw new Error("no space left on the device");
      },
    });
    page.show();
    await settled(page);
    const target = path.join(home, "full.lookout");
    stub.saveDialog = () => Uri.file(target);
    stub.panels[0]!.receive({ type: "save", choice: choice(), passphrase: PASSPHRASE });
    await vi.waitFor(() => expect(page.current.error).toBe("The backup stopped: no space left on the device"));
    expect(fs.existsSync(`${target}.partial`)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    page.dispose();
  });

  it("adds the extension to a name typed without it, and replaces a file of that name only when asked", async () => {
    const { page, home, writes } = setup();
    page.show();
    await settled(page);
    const panel = stub.panels[0]!;
    stub.saveDialog = () => Uri.file(path.join(home, "mine"));
    panel.receive({ type: "save", choice: choice({ encrypt: false }) });
    await vi.waitFor(() => expect(page.current.summary?.file).toBe(path.join(home, "mine.lookout")));
    const taken = path.join(home, "taken.lookout");
    fs.writeFileSync(taken, "keep me");
    stub.saveDialog = () => Uri.file(path.join(home, "taken"));
    panel.receive({ type: "save", choice: choice({ encrypt: false }) });
    await vi.waitFor(() => expect(stub.ops).toContainEqual(["window", "warning", "Replace taken.lookout?"]));
    await settled(page);
    expect(writes).toHaveLength(1);
    expect(fs.readFileSync(taken, "utf8")).toBe("keep me");
    stub.notificationAnswer = "Replace";
    panel.receive({ type: "save", choice: choice({ encrypt: false }) });
    await vi.waitFor(() => expect(page.current.summary?.file).toBe(taken));
    expect(writes).toHaveLength(2);
    page.dispose();
  });

  it("writes only to a file on the machine it runs on", async () => {
    const { page, writes } = setup();
    page.show();
    await settled(page);
    stub.saveDialog = () => ({ scheme: "vscode-local", fsPath: "/c/Users/me/x.lookout" });
    stub.panels[0]!.receive({ type: "save", choice: choice({ encrypt: false }) });
    await vi.waitFor(() => expect(page.current.error).toBe("Lookout writes the backup on the machine it runs on, devbox: pick a folder there."));
    expect(writes).toHaveLength(0);
    page.dispose();
  });

  it("counts the files gone since the look, and says it is saved in a notification when the page is out of sight", async () => {
    const { page, home } = setup({ vanish: 1 });
    page.show();
    await settled(page);
    const panel = stub.panels[0]!;
    // Nothing written yet: nothing to reveal.
    panel.receive({ type: "reveal" });
    expect(stub.ops.some(([target, action]) => target === "commands" && action === "revealFileInOS")).toBe(false);
    const target = path.join(home, "away.lookout");
    stub.saveDialog = () => Uri.file(target);
    stub.notificationAnswer = "Show in Folder";
    panel.visible = false;
    panel.receive({ type: "save", choice: choice({ encrypt: false }) });
    await vi.waitFor(() => expect(page.current.summary).toMatchObject({ files: 9, left: 1, encrypted: false }));
    expect(stub.ops).toContainEqual(["window", "info", expect.stringMatching(/^Lookout saved the backup to away\.lookout \(.+\)\.$/)]);
    await vi.waitFor(() => expect(stub.ops).toContainEqual(["commands", "revealFileInOS", [expect.objectContaining({ fsPath: target })]]));
    panel.receive({ type: "dismiss" });
    expect(page.current.summary).toBeUndefined();
    page.dispose();
  });

  it("leaves out the tabs it cannot read, and says so", async () => {
    const { page, sources } = setup(
      {},
      {
        tabs: async () => {
          throw new Error("the database is locked");
        },
      },
    );
    page.show();
    await settled(page);
    expect(sources[0]!.tabs).toEqual([]);
    expect(page.current).toMatchObject({ notice: "The open Claude tabs could not be read, and are left out: the database is locked", error: undefined });
    expect(page.current.lookedAt).toBeDefined();
    page.dispose();
  });

  it("says why it could not look, and saves nothing", async () => {
    const { page, writes } = setup({
      takeInventory: async () => {
        throw new Error("EACCES: permission denied");
      },
    });
    page.show();
    await settled(page);
    expect(page.current.error).toBe("Lookout could not list what there is to back up: EACCES: permission denied");
    stub.panels[0]!.receive({ type: "save", choice: choice({ encrypt: false }) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stub.ops.some(([, action]) => action === "showSaveDialog")).toBe(false);
    expect(writes).toHaveLength(0);
    page.dispose();
  });

  it("offers gzip at both levels where the runtime has no zstd", async () => {
    const { page, home, writes } = setup({ zstdAvailable: () => false });
    page.show();
    await settled(page);
    expect(shown().zstd).toBe(false);
    expect(shown().chosen!.estimate.fast).toBe(shown().chosen!.estimate.smaller);
    stub.saveDialog = () => Uri.file(path.join(home, "gz.lookout"));
    stub.panels[0]!.receive({ type: "save", choice: choice({ encrypt: false, level: "smaller" }) });
    await vi.waitFor(() => expect(page.current.summary).toBeDefined());
    expect(writes[0]!.options).toMatchObject({ codec: "gzip", level: 6 });
    expect(writes[0]!.options).not.toHaveProperty("passphrase");
    page.dispose();
  });
});

describe("registerBackUp", () => {
  beforeEach(() => stub.reset());

  it("registers Back Up…, which opens the page over the light state and Lookout's version", async () => {
    const { core, sources, writes } = fakeCore();
    const memento = new Map<string, unknown>([
      ["lookout.favourites", [S1]],
      ["lookout.group", "project"],
      ["lookout.pendingTabs", [{ sessionId: S2 }]],
    ]);
    const context = { extensionUri: { fsPath: "/ext" }, globalStorageUri: { fsPath: "/storage" }, extension: { packageJSON: { version: "1.2.3" } }, globalState: { get: (key: string) => memento.get(key) } };
    const deps: BackUpDeps = {
      claudeDirs: () => [],
      storeFile: "/s/history.sqlite",
      recordsDir: "/s/sessions",
      vaultDir: "/s/vault",
      usageDir: "/s/usage",
      removedWorktreesFile: "/s/removed.json",
      tabs: async () => [],
    };
    const registered = registerBackUp(context as never, deps, core);
    expect(stub.commands.has(BACK_UP)).toBe(true);
    await stub.commands.get(BACK_UP)!();
    const panel = stub.panels.at(-1)!;
    expect(panel.viewType).toBe(BACKUP_VIEW_TYPE);
    expect(panel.title).toBe("Lookout: Back Up");
    expect(panel.webview.html).toMatch(/script-src 'nonce-[^']+'/);
    expect(panel.webview.html).toContain("/ext/dist/backup.js");
    expect(panel.webview.html).toContain("/ext/media/backup.css");
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    // Only the light state's keys.
    expect(sources[0]!.state).toEqual({ "lookout.favourites": [S1], "lookout.group": "project" });
    await vi.waitFor(() => expect(shown().lookedAt).toBeDefined());
    expect(shown().host).toBe(os.hostname());
    stub.saveDialog = (options) => {
      expect((options as { defaultUri: { fsPath: string } }).defaultUri.fsPath).toBe(path.join(os.homedir(), defaultFileName(os.hostname(), new Date())));
      return undefined;
    };
    panel.receive({ type: "save", choice: choice({ encrypt: false }) });
    await vi.waitFor(() => expect(stub.ops.some(([, action]) => action === "showSaveDialog")).toBe(true));
    expect(writes).toHaveLength(0);
    registered.dispose();
    expect(stub.commands.has(BACK_UP)).toBe(false);
  });

  it("makes the history's snapshot in the global storage's tmp folder, which only the user reads", async () => {
    const { core, writes } = fakeCore();
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-storage-"));
    const tmp = path.join(storage, "tmp");
    // Made before, open to others: the write closes it.
    fs.mkdirSync(tmp);
    fs.chmodSync(tmp, 0o755);
    const context = { extensionUri: { fsPath: "/ext" }, globalStorageUri: { fsPath: storage }, extension: { packageJSON: { version: "1.2.3" } }, globalState: { get: () => undefined } };
    const deps: BackUpDeps = { claudeDirs: () => [], storeFile: "/s/history.sqlite", recordsDir: "/s/sessions", vaultDir: "/s/vault", usageDir: "/s/usage", removedWorktreesFile: "/s/removed.json", tabs: async () => [] };
    const registered = registerBackUp(context as never, deps, core);
    try {
      await stub.commands.get(BACK_UP)!();
      await vi.waitFor(() => expect(shown().lookedAt).toBeDefined());
      stub.saveDialog = () => Uri.file(path.join(storage, "b.lookout"));
      stub.panels.at(-1)!.receive({ type: "save", choice: choice({ encrypt: false }) });
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]!.options.tempDir).toBe(tmp);
      if (process.platform !== "win32") expect(fs.statSync(tmp).mode & 0o777).toBe(0o700);
    } finally {
      registered.dispose();
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it("names the file after the host and the day, with what no file system takes replaced", () => {
    const day = new Date(2026, 2, 4, 23, 59);
    expect(defaultFileName("devbox", day)).toBe("lookout-devbox-2026-03-04.lookout");
    expect(defaultFileName("Dev's Mac: 2", day)).toBe("lookout-Dev-s-Mac-2-2026-03-04.lookout");
    expect(defaultFileName("..", day)).toBe("lookout-machine-2026-03-04.lookout");
  });
});
