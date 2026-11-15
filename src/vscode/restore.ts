// Restore from Backup…: a backup file picked, its passphrase asked for when
// it has one, what the restore would do shown in a modal (counts in plain
// words, the folder mapping, the folders not on this machine, the restored
// transcripts Claude Code would delete at its next start; never a note's
// text), the mapping changed if the user asks, then the restore with its
// progress, and what it did. Every window sees the restored state as it
// is: the notes' files are watched, and VS Code hands the stars and lists
// to each window as they change. Whatever the backup says that is shown
// goes through `plainText` first: a backup may come from someone else.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ClaudeDir } from "../core/agents/claude/paths";
import { formatBytes } from "../core/format";
import { plainText } from "../core/plainText";
import { bundleReader, type BundleReader } from "../core/transfer/bundleReader";
import {
  applyRestore,
  defaultMapping,
  planRestore,
  readBackupHistory,
  sweepRestoreTemp,
  type FileCounts,
  type HistoryCopy,
  type RestorePlan,
  type RestoreResult,
  type RestoreTargets,
  type RetentionDir,
  type RetentionRisk,
  type StateStore,
} from "../core/transfer/restore";
import type { BundleHeader, BundleSource, LightStateKey, PathMapping, SourceMachine } from "../core/transfer/types";
import type { RetentionOutcome } from "./controller";

export const RESTORE_COMMAND = "lookout.restore";

const RESTORE = "Restore";
const KEEP = "Restore and Keep Them";
const ANYWAY = "Restore Anyway";
const CHANGE_MAPPING = "Change Folder Mapping…";
/** Wrong passphrases before the restore gives up. */
const TRIES = 5;
/** Folders missing on this machine the summary names; the rest are counted. */
const MISSING_SHOWN = 8;
/** `lookout.retention.days`, under the `lookout` section, and its most. */
const RETENTION_SETTING = "retention.days";
const RETENTION_MAX = 36_500;
/** How many days past the oldest restored transcript's age Restore and Keep Them keeps transcripts. */
const RETENTION_MARGIN = 30;
/** The longest path a message shows. */
const PATH_SHOWN = 300;

export interface RestoreDeps {
  /** This machine's Claude Code config directories, as the board watches them now. */
  claudeDirs(): readonly ClaudeDir[];
  recordsDir: string;
  storeFile: string;
  vaultDir: string;
  usageDir: string;
  removedWorktreesFile: string;
  /** Where Codex and Copilot keep their conversation files here, by agent id: their kept transcripts and history entries need a place. */
  agentRoots?(): Readonly<Record<string, string>>;
  /** Writes `lookout.retention.days` into Claude Code's settings as a change of the setting does, and says how that went. */
  applyRetention?(): RetentionOutcome | undefined;
  /** Told once a restore has written something, for this window to look again. */
  restored?(): void;
  /** Reads backup files; the built-in reader when not given. */
  reader?: BundleReader;
  home?: string;
}

/** What the restore needs of the extension's context. */
export type RestoreContext = Pick<vscode.ExtensionContext, "globalState" | "globalStorageUri">;

export function registerRestore(context: RestoreContext, deps: RestoreDeps): vscode.Disposable {
  return vscode.commands.registerCommand(RESTORE_COMMAND, () => restoreFromBackup(context, deps));
}

/** Lookout's own temporary folder, `<globalStorage>/tmp`: only this user may look in it, and what restores left there over a day ago is removed. */
function tempFolder(context: RestoreContext): string {
  const dir = path.join(context.globalStorageUri.fsPath, "tmp");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch {
    // Reading the history out of the backup says what went wrong.
  }
  sweepRestoreTemp(dir);
  return dir;
}

function targetsOf(context: RestoreContext, deps: RestoreDeps, home: string, tempDir: string): RestoreTargets {
  return {
    home,
    claudeDirs: deps.claudeDirs(),
    recordsDir: deps.recordsDir,
    storeFile: deps.storeFile,
    vaultDir: deps.vaultDir,
    usageDir: deps.usageDir,
    removedWorktreesFile: deps.removedWorktreesFile,
    backupsDir: path.join(context.globalStorageUri.fsPath, "restore-backups"),
    state: context.globalState as StateStore,
    agentRoots: deps.agentRoots?.(),
    tempDir,
    folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  };
}

/** The whole command, from the file picked to the closing message. */
export async function restoreFromBackup(context: RestoreContext, deps: RestoreDeps): Promise<void> {
  const reader = deps.reader ?? bundleReader;
  const home = deps.home ?? os.homedir();
  const tempDir = tempFolder(context);
  const picked = await vscode.window.showOpenDialog({
    title: "Restore from Backup",
    openLabel: RESTORE,
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(home),
    filters: { "Lookout backups": ["lookout"] },
  });
  const file = picked?.[0]?.fsPath;
  if (!file) return;
  let opened: { source: BundleSource; passphrase?: string } | undefined;
  try {
    const header = await reader.readBundleHeader(file);
    opened = await openWithPassphrase(reader, file, header);
  } catch (error) {
    return void vscode.window.showErrorMessage(problemOf(error));
  }
  if (!opened) return;
  let { source } = opened;
  const targets = targetsOf(context, deps, home, tempDir);
  let history: HistoryCopy | undefined;
  // The history is read ahead in a pass of its own: the file is opened again for the restore.
  let passed = false;
  let handedOver = false;
  try {
    if (source.manifest.files.some((entry) => entry.kind === "history")) {
      passed = true;
      history = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Reading the backup…" }, () => readBackupHistory(source, tempDir));
    }
    const manifest = source.manifest;
    const planOf = (mapping: PathMapping[]) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Comparing the backup with this machine…" }, () => planRestore(manifest, targets, mapping, history));
    let mapping = defaultMapping(manifest.source, home);
    for (;;) {
      const plan = await planOf(mapping);
      const keepDays = plan.retention ? retentionToKeep(plan.retention) : undefined;
      const buttons = plan.retention ? [KEEP, RESTORE, CHANGE_MAPPING] : [RESTORE, CHANGE_MAPPING];
      const choice = await vscode.window.showInformationMessage(`Restore the backup of ${hostOf(plan.source)}?`, { modal: true, detail: describePlan(plan, keepDays) }, ...buttons);
      if (choice === CHANGE_MAPPING) {
        mapping = (await askMapping(plan, planOf, home)) ?? mapping;
        continue;
      }
      if (choice === KEEP) {
        if (!(await keepTranscripts(keepDays!, () => planOf(mapping), deps))) return;
      } else if (choice !== RESTORE) return;
      if (passed) {
        await source.close();
        source = await reader.openBundle(file, opened.passphrase);
      }
      handedOver = true;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Restoring from backup", cancellable: true }, (progress, token) => {
        const stop = new AbortController();
        token.onCancellationRequested(() => stop.abort());
        let shown = 0;
        return applyRestore(
          source,
          plan,
          targets,
          (done, total) => {
            const percent = total > 0 ? Math.floor((done / total) * 100) : 100;
            if (percent <= shown) return;
            progress.report({ increment: percent - shown, message: `${formatBytes(done)} of ${formatBytes(total)}` });
            shown = percent;
          },
          stop.signal,
        );
      });
      deps.restored?.();
      const done = describeResult(result);
      const show = result.failed.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void show(done);
      return;
    }
  } catch (error) {
    void vscode.window.showErrorMessage(problemOf(error));
  } finally {
    if (!handedOver) history?.dispose();
    try {
      await source.close();
    } catch {
      // Closed already.
    }
  }
}

/** `lookout.retention.days` as the setting holds it: whole days up to a hundred years, else 0. */
function retentionSetting(): number {
  const value = vscode.workspace.getConfiguration("lookout").get<unknown>(RETENTION_SETTING, 0);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= RETENTION_MAX ? value : 0;
}

/** The retention that keeps the restored transcripts a while: the setting as it is, or the oldest one's age and a month when that is longer. */
function retentionToKeep(risk: RetentionRisk): number {
  return Math.max(retentionSetting(), Math.min(RETENTION_MAX, risk.oldestDays + RETENTION_MARGIN));
}

/**
 * Keeps the restored transcripts from Claude Code's sweep before anything
 * is written: sets `lookout.retention.days` to `days` for the user, has it
 * written into Claude Code's settings, and looks again. When a setting
 * Lookout does not write still wins, says which, and goes on only on the
 * user's say-so.
 */
async function keepTranscripts(days: number, replan: () => Thenable<RestorePlan>, deps: RestoreDeps): Promise<boolean> {
  const problems: string[] = [];
  try {
    if (retentionSetting() !== days) await vscode.workspace.getConfiguration("lookout").update(RETENTION_SETTING, days, vscode.ConfigurationTarget.Global);
  } catch {
    problems.push(`Lookout could not set lookout.retention.days to ${days}.`);
  }
  const outcome = deps.applyRetention?.();
  if (outcome?.kind === "failed") problems.push(`Lookout could not write cleanupPeriodDays ${outcome.days}: ${outcome.file} ${outcome.why}.`);
  const still = (await replan()).retention;
  if (!still) return true;
  const detail = [...problems, ...still.dirs.map(describeWinner), "", "Restore Anyway puts them back all the same, and Claude Code deletes them at its next start."].join("\n");
  const choice = await vscode.window.showWarningMessage(`Claude Code would still delete ${riskWhat(still)} at its next start.`, { modal: true, detail }, ANYWAY);
  return choice === ANYWAY;
}

/** What sets the retention of a config directory that still deletes restored files, in a sentence. */
function describeWinner(dir: RetentionDir): string {
  const days = plural(dir.days, "day");
  switch (dir.level) {
    case "managed":
      return `Managed settings at ${dir.file ?? "the system's settings"} keep transcripts ${days} in ${dir.resolved}, and they win over the user's settings.`;
    case "local":
    case "project":
      return `${dir.file} keeps transcripts ${days} for this window's folder, and it wins over the user's settings.`;
    case "user":
      return `${dir.file} keeps transcripts ${days}.`;
    default:
      return `Claude Code keeps transcripts in ${dir.resolved} ${days}, its default.`;
  }
}

/** The restored files Claude Code deletes, in words: its transcripts, and their other files. */
function riskWhat(risk: RetentionRisk): string {
  const others = risk.files - risk.transcripts;
  if (!risk.transcripts) return plural(others, "restored file");
  return `${plural(risk.transcripts, "restored transcript")}${others ? ` and ${plural(others, "of their other files", "of their other files")}` : ""}`;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Opens the file, asking for its passphrase when it is encrypted, again after a wrong one; none when the user gives up. */
async function openWithPassphrase(reader: BundleReader, file: string, header: BundleHeader): Promise<{ source: BundleSource; passphrase?: string } | undefined> {
  if (header.cipher === "none") return { source: await reader.openBundle(file) };
  let prompt = `The backup of ${plainText(header.host) || "another machine"} is encrypted. Enter its passphrase.`;
  for (let tries = 0; tries < TRIES; tries++) {
    const passphrase = await vscode.window.showInputBox({ title: "Restore from Backup", prompt, password: true, ignoreFocusOut: true });
    if (passphrase === undefined) return undefined;
    try {
      const source = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Opening the backup…" }, () => reader.openBundle(file, passphrase));
      return { source, passphrase };
    } catch (error) {
      if (codeOf(error) !== "wrong-passphrase") throw error;
      prompt = "That passphrase does not open this backup. Enter it again.";
    }
  }
  void vscode.window.showErrorMessage("Lookout did not restore the backup: the passphrase did not open it.");
  return undefined;
}

/** What went wrong, in words, for an error message. */
function problemOf(error: unknown): string {
  switch (codeOf(error)) {
    case "not-a-backup":
      return "That file is not a Lookout backup.";
    case "wrong-passphrase":
      return "Lookout did not restore the backup: the passphrase did not open it.";
    case "corrupt":
      return "The backup is damaged: a file in it does not match what was written. What was restored before that stays.";
    case "truncated":
      return "The backup file is damaged or incomplete. Copy it again from the machine it was made on.";
    default:
      return `Lookout could not restore the backup: ${plainText(error instanceof Error ? error.message : String(error))}`;
  }
}

/** A path from the backup, as a message shows it. */
function shown(p: unknown): string {
  return plainText(p, PATH_SHOWN);
}

/**
 * Asks where the source machine's folders are here: first the home, then,
 * one at a time, the folders still missing. The mapping as the user left
 * it, or none when they backed out at the first question.
 */
async function askMapping(plan: RestorePlan, replan: (mapping: PathMapping[]) => Thenable<RestorePlan>, home: string): Promise<PathMapping[] | undefined> {
  const source = plan.source;
  const host = hostOf(source);
  const others = plan.mapping.filter((entry) => entry.from !== source.home);
  const now = plan.mapping.find((entry) => entry.from === source.home)?.to ?? home;
  const answer = await vscode.window.showInputBox({
    title: "Folder Mapping",
    prompt: `Where are the folders that were under ${shown(source.home)} on ${host}?`,
    value: now,
    ignoreFocusOut: true,
    validateInput: (value) => (path.isAbsolute(value.trim()) ? undefined : "A full path, such as " + home),
  });
  if (answer === undefined) return undefined;
  let mapping: PathMapping[] = [{ from: source.home, to: path.normalize(answer.trim()) }, ...others];
  const asked = new Set<string>();
  for (;;) {
    const missing = (await replan(mapping)).missingFolders.filter((folder) => !asked.has(folder.from));
    if (!missing.length) return mapping;
    const items: (vscode.QuickPickItem & { from?: string; to?: string })[] = [
      { label: "Done", description: "Restore the rest where the mapping puts them" },
      ...missing.map((folder) => ({ label: shown(path.basename(folder.to) || folder.to), description: shown(folder.to), detail: `${plural(folder.sessions, "session")}; on ${host}: ${shown(folder.from)}`, from: folder.from, to: folder.to })),
    ];
    const pick = (await vscode.window.showQuickPick(items, { title: "Folders Not on This Machine", placeHolder: "Pick a folder to say where it is here", ignoreFocusOut: true })) as (typeof items)[number] | undefined;
    if (!pick?.from) return mapping;
    asked.add(pick.from);
    const chosen = await vscode.window.showOpenDialog({ title: `Where is ${shown(pick.from)} on this machine?`, openLabel: "Use This Folder", canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(nearest(pick.to ?? home, home)) });
    const to = chosen?.[0]?.fsPath;
    if (to) mapping = [...mapping.filter((entry) => entry.from !== pick.from), { from: pick.from, to }];
  }
}

/** The nearest folder up from `p` that is there. */
function nearest(p: string, fallback: string): string {
  for (let at = p; ; at = path.dirname(at)) {
    if (fs.existsSync(at)) return at;
    if (path.dirname(at) === at) return fallback;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function hostOf(source: SourceMachine | undefined): string {
  return plainText(source?.host) || "another machine";
}

function platformOf(source: SourceMachine): string {
  if (source.wsl) return "Linux under WSL";
  return source.platform === "darwin" ? "macOS" : source.platform === "win32" ? "Windows" : source.platform === "linux" ? "Linux" : plainText(source.platform, 40);
}

/** A time as the summary says it: "November 14, 2026 at 09:30". */
function when(ms: number): string {
  const at = new Date(ms);
  return `${at.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })} at ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

const STATE_NAMES: Record<LightStateKey, string> = {
  "lookout.favourites": "favourites",
  "lookout.archive": "archive",
  "lookout.parking": "parked sessions",
  "lookout.sort": "sort order",
  "lookout.group": "grouping",
  "lookout.claudeOrgs": "account names",
};

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Claude Code's files as the summary counts them: what is new, longer in the backup, the same, longer here, different, with sizes where they count. */
function describeFiles(counts: FileCounts): string[] {
  const parts: string[] = [];
  const n = (count: number) => count.toLocaleString("en-US");
  if (counts.new.count) parts.push(`${n(counts.new.count)} new (${formatBytes(counts.new.bytes)})`);
  if (counts.newer.count) parts.push(`${n(counts.newer.count)} longer than this machine's (${formatBytes(counts.newer.bytes)})`);
  if (counts.same.count) parts.push(`${n(counts.same.count)} already here`);
  if (counts.kept.count) parts.push(`${n(counts.kept.count)} longer here, kept as they are`);
  if (counts.different.count) parts.push(`${n(counts.different.count)} that went on differently here, kept as they are with the backup's set aside`);
  return parts;
}

/** The days Claude Code keeps transcripts where it would delete restored ones: "30 days", or "30 or 60 days". */
function retentionDays(risk: RetentionRisk): string {
  const days = [...new Set(risk.dirs.map((dir) => dir.days))].sort((a, b) => a - b);
  return `${days.map((d) => d.toLocaleString("en-US")).join(" or ")} ${days.length === 1 && days[0] === 1 ? "day" : "days"}`;
}

/**
 * The modal's text: what the restore would do, in plain words and counts.
 * Never a note's text, nor the passphrase. `keep` is the retention Restore
 * and Keep Them sets, when Claude Code would delete restored transcripts.
 */
export function describePlan(plan: RestorePlan, keep?: number): string {
  const lines: string[] = [];
  lines.push(`Made on ${hostOf(plan.source)} (${platformOf(plan.source)}) on ${when(plan.createdAt)}.`);
  if (plan.restoredBefore !== undefined) lines.push(`This backup was restored on this machine before, on ${when(plan.restoredBefore)}.`);
  lines.push("");
  lines.push(plan.mapping.length ? `Folders: ${plan.mapping.map((entry) => `${shown(entry.from)} → ${shown(entry.to)}`).join("; ")}` : "Folders: as they were on the other machine");
  lines.push("");
  const notes: string[] = [];
  if (plan.notes.added) notes.push(`notes on ${plural(plan.notes.added, "session")} to add`);
  if (plan.notes.merged) notes.push(`${plural(plan.notes.merged, "session")} whose notes here gain some`);
  if (plan.notes.unchanged) notes.push(`${plan.notes.unchanged.toLocaleString("en-US")} already here`);
  lines.push(`Notes: ${notes.length ? list(notes) : "none"}.`);
  const state: string[] = [];
  if (plan.state.merged.length) state.push(`${list(plan.state.merged.map((key) => STATE_NAMES[key]))} merged with this machine's`);
  if (plan.state.taken.length) state.push(`${list(plan.state.taken.map((key) => STATE_NAMES[key]))} taken from the backup`);
  lines.push(`Favourites and choices: ${state.length ? state.join("; ") : "nothing new"}.`);
  const transcripts = describeFiles(plan.transcripts);
  lines.push(`Claude transcripts: ${transcripts.length ? list(transcripts) : "none"}.`);
  const others = describeFiles(plan.sessionFiles);
  if (others.length) lines.push(`Their subagent and tool output files: ${list(others)}.`);
  if (plan.history) {
    const size = formatBytes(plan.history.bytes);
    const leftOut = plan.history.leftOut ? `; ${plural(plan.history.leftOut, "conversation")} left out, their files having no place on this machine` : "";
    if (plan.history.failed) lines.push(`Conversation history: left out, as ${plainText(plan.history.failed)}.`);
    else if (plan.history.sessions === undefined) lines.push(`Conversation history: the sessions whose transcripts are gone are added (${size} database).`);
    else lines.push(`Conversation history: ${plan.history.sessions ? `${plural(plan.history.sessions, "session")} whose transcripts are gone to add` : "nothing to add"}${leftOut}.`);
  }
  const tabs: string[] = [];
  if (plan.tabs.added) tabs.push(`${plural(plan.tabs.added, "tab")} to reopen when its folder is opened here`);
  if (plan.tabs.present) tabs.push(`${plan.tabs.present.toLocaleString("en-US")} waiting already`);
  if (plan.tabs.earlier) tabs.push(`${plan.tabs.earlier.toLocaleString("en-US")} reopened or forgotten since this backup was restored before`);
  if (plan.tabs.gone) tabs.push(`${plan.tabs.gone.toLocaleString("en-US")} left out, their transcripts being on neither machine`);
  if (plan.tabs.refused) tabs.push(`${plan.tabs.refused.toLocaleString("en-US")} left out, their folders being outside the folder mapping`);
  if (tabs.length) lines.push(`Open Claude tabs: ${tabs.join("; ")}.`);
  const rest: string[] = [];
  if (plan.vault.added) rest.push(`${plural(plan.vault.added, "kept transcript")} to add (${formatBytes(plan.vault.bytes)})`);
  if (plan.usage.added) rest.push(`${plural(plan.usage.added, "usage record")} to add (${formatBytes(plan.usage.bytes)})`);
  if (plan.worktreesLog) rest.push("removed worktrees merged with this machine's");
  if (rest.length) lines.push(`${capital(list(rest))}.`);
  const refused = plan.transcripts.refused + plan.sessionFiles.refused;
  if (refused) lines.push(`Left out: ${plural(refused, "file")} whose place is not one a backup may write, or where a link is in the way.`);
  const risk = plan.retention;
  if (risk) {
    const one = risk.files === 1;
    lines.push("");
    lines.push(
      `Claude Code deletes transcripts last written more than ${retentionDays(risk)} ago when it starts, and ${riskWhat(risk)} (${formatBytes(risk.bytes)}) ${one ? "is" : "are"} older, the oldest ${plural(risk.oldestDays, "day")} old. Restore puts ${one ? "it" : "them"} back, and Claude Code deletes ${one ? "it" : "them"} at its next start, which reopening the restored tabs brings about.`,
    );
    if (keep !== undefined) lines.push(`Restore and Keep Them first sets lookout.retention.days to ${keep.toLocaleString("en-US")}, so that Claude Code keeps transcripts that long.`);
  }
  if (plan.missingFolders.length) {
    lines.push("");
    lines.push(`Folders not on this machine (${plan.missingFolders.length.toLocaleString("en-US")}):`);
    for (const folder of plan.missingFolders.slice(0, MISSING_SHOWN)) lines.push(`  ${shown(folder.to)} (${plural(folder.sessions, "session")})`);
    if (plan.missingFolders.length > MISSING_SHOWN) lines.push(`  and ${(plan.missingFolders.length - MISSING_SHOWN).toLocaleString("en-US")} more`);
    lines.push("Their sessions are restored all the same. If those folders are somewhere else here, change the folder mapping.");
  }
  lines.push("");
  lines.push("Nothing here is lost: what the restore replaces is copied to Lookout's restore-backups folder first, and a transcript that went on differently here stays, with the backup's copy put there.");
  lines.push("Restore only a backup you made yourself: its conversations become Claude Code's to resume.");
  return lines.join("\n");
}

/** Transcripts and their other files, in words: "2 transcripts and 3 of their other files". */
function filesWhat(transcripts: number, others: number): string {
  if (!transcripts) return plural(others, "file");
  return `${plural(transcripts, "transcript")}${others ? ` and ${plural(others, "of their other files", "of their other files")}` : ""}`;
}

/** The closing message: what the restore did. */
export function describeResult(result: RestoreResult): string {
  const parts: string[] = [];
  const notes = result.notes.added + result.notes.merged;
  if (notes) parts.push(`notes on ${plural(notes, "session")}`);
  const transcripts = result.transcripts.written.count + result.transcripts.replaced.count;
  if (transcripts) parts.push(plural(transcripts, "transcript"));
  if (result.history?.added) parts.push(`${plural(result.history.added, "conversation")} from the history`);
  if (result.tabs.added) parts.push(`${plural(result.tabs.added, "tab")} to reopen`);
  if (result.vault.added) parts.push(plural(result.vault.added, "kept transcript"));
  if (result.state.taken.length + result.state.merged.length) parts.push("favourites and choices");
  const what = parts.length ? `Lookout restored ${list(parts)}.` : "The backup had nothing this machine lacks.";
  const after: string[] = [];
  if (result.cancelled) after.push("The restore was stopped; what it did until then stays.");
  const kept = result.transcripts.kept.count + result.sessionFiles.kept.count;
  if (kept) after.push(`Kept as they are here, being longer than the backup's: ${filesWhat(result.transcripts.kept.count, result.sessionFiles.kept.count)}.`);
  const diverged = result.transcripts.diverged.count + result.sessionFiles.diverged.count;
  if (diverged) after.push(`Kept as they are here, having gone on differently from the backup's: ${filesWhat(result.transcripts.diverged.count, result.sessionFiles.diverged.count)}; the backup's copies are in ${result.divergedDir ?? "the restore-backups folder"}.`);
  if (result.history?.failed) after.push(`The history was left out: ${plainText(result.history.failed)}.`);
  else if (result.history && (result.history.missing.length || result.history.extra.length)) after.push("The backup's history was made by another version of Lookout: what both versions keep was taken.");
  if (result.historyLeftOut) after.push(`${plural(result.historyLeftOut, "conversation")} of the history ${result.historyLeftOut === 1 ? "was" : "were"} left out: ${result.historyLeftOut === 1 ? "its file has" : "their files have"} no place on this machine.`);
  if (result.tabs.refused || result.worktreesLog.refused) {
    const outside = [result.tabs.refused ? plural(result.tabs.refused, "tab") : "", result.worktreesLog.refused ? plural(result.worktreesLog.refused, "removed worktree") : ""].filter(Boolean);
    after.push(`Left out, their folders being outside the folder mapping: ${list(outside)}.`);
  }
  if (result.failed.length) after.push(`${plural(result.failed.length, "file")} could not be written.`);
  if (result.backupDir) after.push(`What it replaced is in ${result.backupDir}.`);
  if (parts.length) after.push("Other windows show it once reloaded.");
  return [what, ...after].join(" ");
}
