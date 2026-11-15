import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ClaudeDir } from "../core/agents/claude/paths";
import { formatBytes } from "../core/format";
import { readParking } from "../core/parking";
import type { SessionRecord } from "../core/sessionRecords";
import { LIGHT_STATE_KEYS, SECTIONS, type Codec, type LightStateKey, type SectionId, type SourceMachine, type WindowTabs } from "../core/transfer/types";
import { count, defaultChoice, effectiveSections, MAX_PASSPHRASE, NO_PASSPHRASE, readChoice, repoName, TRANSCRIPT_PARTS } from "../webview/backupModel";
import type { BackupChoice, BackupState, BackupSummary, Chosen, FromBackup, Level, RepoRow, SectionRow, ToBackup, WriteProgress } from "../webview/backupProtocol";
import { transferCore, type BackupCore, type Inventory, type InventoryItem, type Selection } from "./backupCore";

export const BACKUP_VIEW_TYPE = "lookout.backup";
export const BACK_UP = "lookout.backUp";

/** A backup file's extension. */
const EXTENSION = ".lookout";
/** The writer's file until it is finished. */
const PARTIAL = ".partial";
/** Progress is sent to the page at most this often. */
const PROGRESS_MS = 150;

/** Where the backup's parts are on this machine, and the Claude tabs open in its windows. */
export interface BackUpDeps {
  /** The Claude Code config directories watched now. */
  claudeDirs(): readonly ClaudeDir[];
  storeFile: string;
  recordsDir: string;
  vaultDir: string;
  usageDir: string;
  removedWorktreesFile: string;
  tabs(): Promise<WindowTabs[]>;
}

/** What the page reads from VS Code and the machine. */
export interface BackupHost {
  /** The light state as it stands now. */
  state(): Partial<Record<LightStateKey, unknown>>;
  /** Lookout's version, written into the file. */
  version: string;
  /** This machine, as the file describes it. */
  machine(): Promise<SourceMachine>;
  /** A folder of Lookout's own for the history's snapshot while a backup is written, made when one starts, readable by the user alone. */
  tempDir: string;
}

/** The sections that are no files of their own: they go into the file's manifest. */
const LIGHT_SECTIONS: readonly SectionId[] = ["state", "notes", "tabs"];
const LEVEL_NUMBERS: Record<Codec, Record<Level, number>> = { zstd: { fast: 3, smaller: 9 }, gzip: { fast: 6, smaller: 6 } };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** `lookout-<host>-<yyyy-mm-dd>.lookout`, the host's name cut to what every file system takes. */
export function defaultFileName(host: string, now: Date): string {
  const name = host.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "machine";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `lookout-${name}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}${EXTENSION}`;
}

function notesRow(records: readonly SessionRecord[]): SectionRow {
  const noted = records.filter((record) => record.notes?.length);
  const notes = noted.reduce((sum, record) => sum + (record.notes?.length ?? 0), 0);
  return { id: "notes", count: notes, bytes: notes ? jsonBytes(noted) : 0, ...(notes ? { detail: `${count(notes, "note")} on ${count(noted.length, "session")}` } : {}) };
}

function stateRow(state: Partial<Record<LightStateKey, unknown>>): SectionRow {
  const length = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  const stars = length(state["lookout.favourites"]);
  const archived = length(state["lookout.archive"]);
  const parked = readParking(state["lookout.parking"]).parked.length;
  const orgs = state["lookout.claudeOrgs"];
  const names = typeof orgs === "object" && orgs !== null ? Object.keys(orgs).length : 0;
  const board = [state["lookout.sort"] !== undefined ? "order" : "", state["lookout.group"] !== undefined ? "grouping" : ""].filter(Boolean);
  const parts = [stars ? `${stars.toLocaleString("en-US")} starred` : "", archived ? `${archived.toLocaleString("en-US")} archived` : "", parked ? `${parked.toLocaleString("en-US")} parked` : "", board.length ? `board ${board.join(" and ")}` : "", names ? count(names, "account name") : ""].filter(Boolean);
  const set = Object.fromEntries(LIGHT_STATE_KEYS.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
  const total = stars + archived + parked + board.length + names;
  return { id: "state", count: total, bytes: total ? jsonBytes(set) : 0, ...(total ? { detail: parts.join(" · ") } : {}) };
}

function tabsRow(windows: readonly WindowTabs[]): SectionRow {
  const open = windows.filter((window) => window.tabs.length);
  const tabs = open.reduce((sum, window) => sum + window.tabs.length, 0);
  return { id: "tabs", count: tabs, bytes: tabs ? jsonBytes(open) : 0, ...(tabs ? { detail: `${count(tabs, "tab")} in ${count(open.length, "window")}` } : {}) };
}

/** Each section's count and bytes: the files of each, and what the notes, the state and the tabs hold. */
export function sectionRows(inventory: Inventory): SectionRow[] {
  const files = new Map<SectionId, { count: number; bytes: number }>();
  for (const item of inventory.items) {
    const total = files.get(item.section) ?? { count: 0, bytes: 0 };
    total.count++;
    total.bytes += item.size;
    files.set(item.section, total);
  }
  return SECTIONS.map((id) => {
    if (id === "notes") return notesRow(inventory.notes);
    if (id === "state") return stateRow(inventory.state);
    if (id === "tabs") return tabsRow(inventory.tabs);
    return { id, ...(files.get(id) ?? { count: 0, bytes: 0 }) };
  });
}

/** The repositories, the one with the most bytes first, in an order the filters do not change. */
export function repoRows(inventory: Inventory): RepoRow[] {
  return inventory.repos
    .map((info) => ({ repo: info.repo, name: repoName(info.repo), sessions: info.sessions, bytes: info.bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name) || a.repo.localeCompare(b.repo));
}

/** The core's selection for a choice: every repository, unless one is unticked. */
export function selectionOf(choice: BackupChoice, repos: readonly string[]): Selection {
  const skip = new Set(choice.skipRepos);
  return {
    sections: effectiveSections(choice),
    ...(choice.days ? { activeWithinDays: choice.days } : {}),
    ...(repos.some((repo) => skip.has(repo)) ? { repos: repos.filter((repo) => !skip.has(repo)) } : {}),
  };
}

/** What a choice takes of each section and repository, its bytes, and the file's size at each level. */
export function chosenOf(core: BackupCore, inventory: Inventory, choice: BackupChoice, rows: readonly SectionRow[], codec: Codec): Chosen {
  const selection = selectionOf(choice, inventory.repos.map((info) => info.repo));
  const items = core.select(inventory, selection);
  const sections: Chosen["sections"] = {};
  for (const item of items) {
    const total = (sections[item.section] ??= { count: 0, bytes: 0 });
    total.count++;
    total.bytes += item.size;
  }
  let light = 0;
  for (const row of rows) {
    if (!LIGHT_SECTIONS.includes(row.id) || !selection.sections.includes(row.id) || !row.count) continue;
    sections[row.id] = { count: row.count, bytes: row.bytes };
    light += row.bytes;
  }
  // Each repository as the age filter and the two inclusions leave it, ticked or not: a subagent's or a tool output's goes by its session's.
  const parts = TRANSCRIPT_PARTS.filter((id) => choice.sections.includes(id));
  const repoOf = new Map(inventory.items.flatMap((item) => (item.kind === "transcript" && item.sessionId && item.repo ? [[item.sessionId, item.repo] as const] : [])));
  const repos: Chosen["repos"] = {};
  for (const item of core.select(inventory, { sections: ["transcripts", ...parts], ...(choice.days ? { activeWithinDays: choice.days } : {}) })) {
    const repo = item.repo ?? (item.sessionId ? repoOf.get(item.sessionId) : undefined);
    if (repo === undefined) continue;
    const total = (repos[repo] ??= { sessions: 0, bytes: 0 });
    if (item.kind === "transcript") total.sessions++;
    total.bytes += item.size;
  }
  const levels = LEVEL_NUMBERS[codec];
  return {
    sections,
    repos,
    sessions: items.filter((item) => item.kind === "transcript").length,
    files: items.length,
    bytes: items.reduce((sum, item) => sum + item.size, 0) + light,
    estimate: { fast: core.estimate(items, codec, levels.fast) + light, smaller: core.estimate(items, codec, levels.smaller) + light },
  };
}

function lightState(memento: vscode.Memento): Partial<Record<LightStateKey, unknown>> {
  const state: Partial<Record<LightStateKey, unknown>> = {};
  for (const key of LIGHT_STATE_KEYS) {
    const value = memento.get<unknown>(key);
    if (value !== undefined) state[key] = value;
  }
  return state;
}

/** WSL reports itself as Linux; its kernel says otherwise. */
async function insideWsl(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft/i.test(await fs.promises.readFile("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The backup page: what there is to back up, each section with its count and
 * size, the transcripts narrowed by age and repository, the compression, the
 * passphrase, and a live estimate of the file's size. The file is written
 * where the save dialog says, with progress in a notification that can stop
 * it. The passphrase goes from the page to the write and nowhere else. One
 * tab, reused; each opening looks at what there is again.
 */
export class BackupPage implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private state: BackupState;
  private inventory: Inventory | undefined;
  private choice: BackupChoice = defaultChoice();
  private source: SourceMachine | undefined;
  /** The write under way, to stop. */
  private writing: AbortController | undefined;
  /** The save dialog is open. */
  private asking = false;
  /** A choice came in and its numbers are yet to be worked out. */
  private counting = false;
  private lastProgress = 0;
  private readonly codec: Codec;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: BackUpDeps,
    private readonly host: BackupHost,
    private readonly core: BackupCore,
  ) {
    this.codec = core.zstdAvailable() ? "zstd" : "gzip";
    this.state = { host: "", sections: [], repos: [], zstd: this.codec === "zstd" };
  }

  /** Opens the page, or brings it forward; a page opened anew looks at what there is. */
  show(): void {
    const fresh = !this.panel;
    const panel = this.ensurePanel();
    panel.reveal(undefined, false);
    this.post();
    if (fresh && !this.state.busy) void this.look();
  }

  /** The page's state, for the tests. */
  get current(): BackupState {
    return this.state;
  }

  /** Looks at what there is to back up. The page hears that it runs before the inventory starts. */
  async look(): Promise<void> {
    if (this.state.busy) return;
    this.set({ busy: "look", summary: undefined, error: undefined, notice: undefined });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let notice: string | undefined;
    try {
      this.source ??= await this.host.machine();
      this.set({ host: this.source.host });
      const tabs = await Promise.resolve()
        .then(() => this.deps.tabs())
        .catch((error: unknown) => {
          notice = `The open Claude tabs could not be read, and are left out: ${messageOf(error)}`;
          return [];
        });
      const inventory = await this.core.takeInventory({
        claudeDirs: this.deps.claudeDirs(),
        storeFile: this.deps.storeFile,
        recordsDir: this.deps.recordsDir,
        vaultDir: this.deps.vaultDir,
        usageDir: this.deps.usageDir,
        removedWorktreesFile: this.deps.removedWorktreesFile,
        state: this.host.state(),
        tabs,
        now: Date.now(),
      });
      this.inventory = inventory;
      const sections = sectionRows(inventory);
      this.state = { ...this.state, sections, repos: repoRows(inventory) };
      this.set({ busy: undefined, lookedAt: Date.now(), notice, ...this.recount() });
    } catch (error) {
      this.set({ busy: undefined, notice, error: `Lookout could not list what there is to back up: ${messageOf(error)}` });
    }
  }

  /** Takes the page's choice; what it takes is worked out once the messages queued now are in. */
  choose(choice: BackupChoice): void {
    this.choice = choice;
    if (this.counting) return;
    this.counting = true;
    setImmediate(() => {
      this.counting = false;
      if (this.inventory && this.state.busy !== "look") this.set(this.recount());
    });
  }

  /** Asks where to save, then writes the file. Nothing is asked without a passphrase unless "Don't encrypt" is ticked, whatever goes in: notes, tab titles, folders and session ids are private too. */
  async save(choice: BackupChoice, passphrase: string | undefined): Promise<void> {
    if (this.state.busy || this.asking || !this.inventory) return;
    this.choice = choice;
    const inventory = this.inventory;
    const selection = selectionOf(choice, inventory.repos.map((info) => info.repo));
    const items = this.core.select(inventory, selection);
    const light = this.state.sections.some((row) => LIGHT_SECTIONS.includes(row.id) && selection.sections.includes(row.id) && row.count > 0);
    if (!items.length && !light) {
      this.set({ error: "Nothing ticked has anything in it to back up.", notice: undefined });
      return;
    }
    const secret = choice.encrypt && passphrase ? passphrase : undefined;
    if (choice.encrypt && secret === undefined) {
      this.set({ error: NO_PASSPHRASE, notice: undefined });
      return;
    }
    if (secret !== undefined && [...secret].length > MAX_PASSPHRASE) {
      this.set({ error: `The passphrase is longer than ${MAX_PASSPHRASE} characters.`, notice: undefined });
      return;
    }
    if (this.state.error || this.state.notice) this.set({ error: undefined, notice: undefined });
    this.asking = true;
    let file: string | undefined;
    try {
      file = await this.pickFile();
    } finally {
      this.asking = false;
    }
    if (!file) {
      this.post();
      return;
    }
    await this.write(file, inventory, selection, items, secret, choice.level);
  }

  /** Stops the write under way; the partial file goes. */
  stop(): void {
    this.writing?.abort();
  }

  /** Takes the last backup's summary off the page. */
  dismiss(): void {
    if (this.state.summary) this.set({ summary: undefined });
  }

  /** Shows the last backup's file in the system's file manager. */
  reveal(): void {
    const file = this.state.summary?.file;
    if (file) void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(file));
  }

  /** Where to save: the home folder and a name of the host and the day, offered; a file on this machine only. */
  private async pickFile(): Promise<string | undefined> {
    const source = this.source ?? (await this.host.machine());
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(source.home, defaultFileName(source.host, new Date()))),
      filters: { "Lookout backup": [EXTENSION.slice(1)] },
      saveLabel: "Back Up",
      title: "Back Up Lookout",
    });
    if (!uri) return undefined;
    if (uri.scheme !== "file") {
      this.set({ error: `Lookout writes the backup on the machine it runs on, ${source.host}: pick a folder there.`, notice: undefined });
      return undefined;
    }
    if (path.extname(uri.fsPath).toLowerCase() === EXTENSION) return uri.fsPath;
    // A name typed without the extension gets it, so the restore's dialog lists the file; a file of that name is replaced only when the user says so.
    const file = `${uri.fsPath}${EXTENSION}`;
    if (!(await exists(file))) return file;
    const answer = await vscode.window.showWarningMessage(`Replace ${path.basename(file)}?`, { modal: true, detail: "A file of that name is there already." }, "Replace");
    return answer === "Replace" ? file : undefined;
  }

  private async write(file: string, inventory: Inventory, selection: Selection, items: InventoryItem[], passphrase: string | undefined, level: Level): Promise<void> {
    const abort = new AbortController();
    this.writing = abort;
    const started = Date.now();
    this.lastProgress = 0;
    this.set({ busy: "write", progress: { done: 0, total: items.reduce((sum, item) => sum + item.size, 0) }, summary: undefined, error: undefined, notice: undefined });
    try {
      const source = this.source ?? (await this.host.machine());
      // The snapshot is the history in the clear: kept off the system's temporary directory, which may be in memory and is shared.
      await fs.promises.mkdir(this.host.tempDir, { recursive: true, mode: 0o700 });
      await fs.promises.chmod(this.host.tempDir, 0o700);
      const options = { ...(passphrase !== undefined ? { passphrase } : {}), codec: this.codec, level: LEVEL_NUMBERS[this.codec][level], host: source.host, createdAt: started, lookoutVersion: this.host.version, source, tempDir: this.host.tempDir };
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Lookout: backing up to ${path.basename(file)}`, cancellable: true }, async (progress, token) => {
        const cancel = token.onCancellationRequested(() => abort.abort());
        let shown = 0;
        try {
          return await this.core.backUp(
            file,
            inventory,
            selection,
            options,
            (done, total) => {
              const percent = total > 0 ? Math.min(100, Math.floor((100 * done) / total)) : 0;
              if (percent > shown) {
                progress.report({ increment: percent - shown, message: `${formatBytes(done)} of ${formatBytes(total)}` });
                shown = percent;
              }
              this.progress({ done, total });
            },
            abort.signal,
          );
        } finally {
          cancel.dispose();
        }
      });
      const bytes = await fs.promises.stat(file).then(
        (stat) => stat.size,
        () => result.bytes,
      );
      const now = Date.now();
      const summary: BackupSummary = {
        file,
        name: path.basename(file),
        bytes,
        sessions: items.filter((item) => item.kind === "transcript").length,
        files: result.files,
        left: result.skipped.length,
        encrypted: passphrase !== undefined,
        tookMs: now - started,
        at: now,
      };
      this.set({ busy: undefined, progress: undefined, summary });
      if (!this.panel?.visible) void this.announce(summary);
    } catch (error) {
      // The writer drops its partial file when it stops; this makes sure of it.
      await fs.promises.rm(`${file}${PARTIAL}`, { force: true }).catch(() => undefined);
      if (abort.signal.aborted) this.set({ busy: undefined, progress: undefined, notice: "The backup was stopped; nothing was saved." });
      else this.set({ busy: undefined, progress: undefined, error: `The backup stopped: ${messageOf(error)}` });
    } finally {
      if (this.writing === abort) this.writing = undefined;
    }
  }

  /** Says the backup is saved, for a page not in sight. */
  private async announce(summary: BackupSummary): Promise<void> {
    const answer = await vscode.window.showInformationMessage(`Lookout saved the backup to ${summary.name} (${formatBytes(summary.bytes)}).`, "Show in Folder");
    if (answer === "Show in Folder" && this.state.summary?.file === summary.file) this.reveal();
  }

  /** What the current choice takes, or why that could not be worked out. */
  private recount(): Partial<BackupState> {
    if (!this.inventory) return {};
    try {
      return { chosen: chosenOf(this.core, this.inventory, this.choice, this.state.sections, this.codec) };
    } catch (error) {
      return { chosen: undefined, error: `Lookout could not work out what the choice takes: ${messageOf(error)}` };
    }
  }

  /** How far the write got, sent on its own: the page redraws its bars, not its form. */
  private progress(progress: WriteProgress): void {
    const now = Date.now();
    this.state = { ...this.state, progress };
    if (now - this.lastProgress < PROGRESS_MS && progress.done < progress.total) return;
    this.lastProgress = now;
    if (this.panel) void this.panel.webview.postMessage({ type: "progress", progress } satisfies ToBackup);
  }

  private set(change: Partial<BackupState>): void {
    this.state = { ...this.state, ...change };
    this.post();
  }

  private post(): void {
    if (!this.panel) return;
    const message: ToBackup = { type: "state", state: this.state };
    void this.panel.webview.postMessage(message);
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) return this.panel;
    const panel = vscode.window.createWebviewPanel(BACKUP_VIEW_TYPE, "Lookout: Back Up", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw));
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    this.panel = panel;
    return panel;
  }

  private receive(raw: unknown): void {
    const message = raw as Partial<FromBackup>;
    switch (message?.type) {
      case "ready":
        this.post();
        return;
      case "look":
        void this.look();
        return;
      case "choose": {
        const choice = readChoice(message.choice);
        if (choice) this.choose(choice);
        return;
      }
      case "save": {
        const choice = readChoice(message.choice);
        if (choice) void this.save(choice, typeof message.passphrase === "string" && message.passphrase !== "" ? message.passphrase : undefined);
        return;
      }
      case "stop":
        this.stop();
        return;
      case "reveal":
        this.reveal();
        return;
      case "dismiss":
        this.dismiss();
        return;
      default:
        return;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "backup.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "backup.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Lookout: Back Up</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.writing?.abort();
    this.panel?.dispose();
    this.panel = undefined;
  }
}

/** Registers "Back Up…": the backup page, over what `deps` says is where. */
export function registerBackUp(context: vscode.ExtensionContext, deps: BackUpDeps, core: BackupCore = transferCore): vscode.Disposable {
  const version = (context.extension?.packageJSON as { version?: unknown } | undefined)?.version;
  const page = new BackupPage(
    context.extensionUri,
    deps,
    {
      state: () => lightState(context.globalState),
      version: typeof version === "string" ? version : "unknown",
      machine: async () => ({ host: os.hostname(), platform: process.platform, home: os.homedir(), wsl: await insideWsl() }),
      tempDir: path.join(context.globalStorageUri.fsPath, "tmp"),
    },
    core,
  );
  const command = vscode.commands.registerCommand(BACK_UP, () => page.show());
  return {
    dispose: () => {
      command.dispose();
      page.dispose();
    },
  };
}
