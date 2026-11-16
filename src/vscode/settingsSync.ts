// The light state and the notes follow the user from machine to machine
// through Settings Sync, unless `lookout.settingsSync.enabled` is off. Settings
// Sync sends only the keys a machine gave it, writes on a machine only the
// keys that machine gave it, and of a key two machines changed keeps the
// other machine's copy whole. So Lookout gives it two keys, always the same
// two, holding synced copies of the light state and of every session's
// notes; Lookout's own keys and the notes' files stay this machine's, and
// each window merges them with the synced copies three ways, against what
// this machine merged last.
//
// VS Code keeps an extension's globalState in the workbench, and a value
// Settings Sync pulls replaces the one every open window reads, without a
// reload and without an event; so each window merges when it opens and when
// the setting turns on, and the window in front when it comes to the front,
// when the records change, and once a minute.
//
// globalState is one JSON value per extension that each window writes whole:
// a write from a window that has not yet heard of another window's write
// puts the older values back. Past its opening only the window in front
// merges, and it writes only what changed, so two windows seldom write at
// once; and the merge is the same in every window, so two that do write the
// same thing. The light state's base is kept in globalState with the state
// itself, so such a write puts both back together and never reads as the
// user taking something out; the notes' base is a file beside the notes'
// files for the same reason.
//
// Each synced copy names the machine that last changed it (`by`), written
// only with a change of what it holds, so two machines that agree leave it
// alone. A window notes when a copy another machine wrote arrives, and says
// so in Lookout's log; Lookout: Settings Sync Status shows what it knows.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { plainText } from "../core/plainText";
import { SessionRecords, type NoteEntry } from "../core/sessionRecords";
import { mergeNotes, readSyncedNotes, syncedNotes, type SessionNotes } from "../core/syncedNotes";
import { changedKeys, localValues, mergeState, ordered, readLocalState, readSyncedState, type SessionsHere } from "../core/syncedState";
import { fitSync, SYNC_LIMIT, type SyncFit } from "../core/syncLimit";
import { SYNC_KEYS, SYNC_NOTES_KEY, SYNC_STATE_KEY } from "../core/transfer/types";
import type { Log } from "./log";

/** The setting that turns Settings Sync on for Lookout, under `lookout`. */
export const SYNC_SETTING = "settingsSync.enabled";

/** What this machine last merged of the light state, kept beside it; not synced. */
export const SYNC_BASE_KEY = "lookout.sync.base";

/** Set once this machine gave Settings Sync its keys, until it takes them back; not synced. */
export const SYNC_REGISTERED_KEY = "lookout.sync.registered";

/** Set while the synced copies leave something out and the user was told; not synced. */
export const SYNC_CAPPED_KEY = "lookout.sync.capped";

/** What this machine last saw of each synced copy, and the last copies another machine wrote; not synced. */
export const SYNC_SEEN_KEY = "lookout.sync.seen";

/** The window in front merges this often: Settings Sync says nothing of the values it pulls. */
export const MERGE_EVERY_MS = 60_000;

/** The command that says what Lookout's Settings Sync knows. */
export const SYNC_STATUS_COMMAND = "lookout.syncStatus";

/** VS Code's own Settings Sync commands, as its workbench names them. */
const SYNC_NOW_COMMAND = "workbench.userDataSync.actions.syncNow";
const SYNC_LOG_COMMAND = "workbench.userDataSync.actions.showLog";
const RESTORE_COMMAND = "lookout.restore";

/** A copy another machine wrote, as it arrived. */
export interface Arrival {
  /** Epoch ms this machine saw it. */
  at: number;
  /** The machine that wrote it; none for a Lookout that did not say, before 0.1.7. */
  by?: string;
  /** In the state's copy: its stars. */
  stars?: number;
  /** In the notes' copy: its notes, and the sessions they are on. */
  notes?: number;
  sessions?: number;
}

/** What this machine last saw of the synced copies. */
export interface SyncSeen {
  /** A digest of each copy as this machine last saw or wrote it. */
  state?: string;
  notes?: string;
  /** The last copy of each that another machine wrote. */
  arrived?: { state?: Arrival; notes?: Arrival };
}

/** What Lookout: Settings Sync Status says. */
export interface SyncStatus {
  enabled: boolean;
  /** Epoch ms this window last merged; none before its first merge. */
  mergedAt?: number;
  arrived: { state?: Arrival; notes?: Arrival };
  /** What this machine syncs, as of its last merge. */
  stars: number;
  archived: number;
  parked: number;
  notes: number;
  sessions: number;
  /** What the last merge left out of the synced copies to keep them small. */
  fit?: SyncFit;
}

/**
 * What this machine merged last of the notes, in a file beside the records
 * directory rather than in globalState: globalState belongs to the VS Code
 * client and is shared by every Lookout it runs, locally and in each remote,
 * each with records of its own; and storage wiped takes the records and the
 * base together.
 */
const BASE_FILE = "notes-sync.json";

const BACK_UP_COMMAND = "lookout.backUp";

/** globalState, which syncs the keys it is given. */
export type SyncedMemento = vscode.Memento & { setKeysForSync(keys: readonly string[]): void };

export interface SettingsSyncDeps {
  /** Where the session records are kept, one file per session, shared by every window. */
  recordsDir: string;
  /** Where this machine keeps what it merged last of the notes; by default next to the records directory. */
  baseFile?: string;
  /** Told after a merge changed Lookout's keys or the notes, so the board shows it. */
  changed?: () => void;
  /** How often the window in front merges, for the tests. */
  mergeEveryMs?: number;
  now?: () => number;
  log?: Pick<Log, "errorOnce" | "info">;
  /** A session on this machine, by id: its title and agent, for the stars and notes to carry. None for one that is not here. */
  describe?(id: string): { title?: string; agent?: string } | undefined;
  /** This machine's name, as the synced copies give it; os.hostname() by default. */
  host?: string;
  /** The starred and noted sessions whose conversations are not on this machine, for the status. */
  elsewhere?(): { sessions: number; stars: number; notes: number };
  /** This Lookout's version, for the status: VS Code applies an extension's synced data only where the same version is installed. */
  version?: string;
}

/** Whether the user turned Settings Sync on for Lookout. */
export function syncEnabled(): boolean {
  return vscode.workspace.getConfiguration("lookout").get<boolean>(SYNC_SETTING, true) !== false;
}

/** Settings Sync for the light state and the notes: the window's part. */
export class SettingsSync implements vscode.Disposable {
  /** The records, read and written by this window as by any other. */
  readonly records: SessionRecords;
  private readonly baseFile: string;
  private readonly now: () => number;
  /** The keys last given to Settings Sync by this window. */
  private keysForSync: string | undefined;
  /** A merge runs: one asked for from inside it, by whoever hears of its changes, is not started. */
  private merging = false;
  private disposed = false;
  /** Writes made by this window, for temporary names no other write shares. */
  private saves = 0;
  /** This machine's name in the synced copies. */
  private readonly host: string;
  /** What the last merge saw and kept, for the status. */
  private last: Omit<SyncStatus, "enabled" | "arrived"> | undefined;

  constructor(
    private readonly state: SyncedMemento,
    private readonly deps: SettingsSyncDeps,
  ) {
    this.records = new SessionRecords(deps.recordsDir);
    this.baseFile = deps.baseFile ?? path.join(path.dirname(deps.recordsDir), BASE_FILE);
    this.now = deps.now ?? Date.now;
    this.host = deps.host ?? os.hostname();
  }

  /** What Lookout's Settings Sync knows now. */
  status(): SyncStatus {
    const seen = readSeen(this.state.get<unknown>(SYNC_SEEN_KEY));
    return { enabled: syncEnabled(), arrived: seen.arrived ?? {}, ...(this.last ?? { stars: 0, archived: 0, parked: 0, notes: 0, sessions: 0 }) };
  }

  /**
   * Merges, or with the setting off takes Lookout out of Settings Sync. It
   * runs start to end without yielding, so nothing Settings Sync pulls and
   * no write from another window lands in the middle of it.
   */
  merge(): void {
    if (this.merging || this.disposed) return;
    this.merging = true;
    try {
      this.pass();
    } catch (error) {
      this.deps.log?.errorOnce(`Lookout could not merge what Settings Sync carries: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.merging = false;
    }
  }

  private pass(): void {
    if (!syncEnabled()) {
      this.stop();
      return;
    }
    const now = this.now();
    // Settings Sync hears of the keys before they are written.
    this.syncKeys(SYNC_KEYS);
    if (this.state.get<unknown>(SYNC_REGISTERED_KEY) !== true) void this.state.update(SYNC_REGISTERED_KEY, true);

    const here: SessionsHere = { host: this.host, of: (id) => this.deps.describe?.(id) };
    const seen = this.noticeArrivals(now);

    // The light state: Lookout's keys, written back where the merge changed them.
    const local = readLocalState((key) => this.state.get<unknown>(key));
    const stateBase = readSyncedState(this.state.get<unknown>(SYNC_BASE_KEY));
    const state = mergeState(stateBase, local, readSyncedState(this.state.get<unknown>(SYNC_STATE_KEY)), now, here);
    const values = localValues(state);
    const keys = changedKeys(local, state);
    for (const key of keys) void this.state.update(key, values[key]);

    // The notes: the base first, then each session's record as its file has it now. A window writes the records before the base,
    // so a note the base has is in the file, unless the user took it away; this window's own view of the records may be older.
    const base = readBase(this.baseFile);
    const records = this.records.all();
    const remote = readSyncedNotes(this.state.get<unknown>(SYNC_NOTES_KEY)) ?? new Map<string, SessionNotes>();
    const ids = new Set([...base.keys(), ...remote.keys()]);
    for (const [id, record] of records) if (record.notes?.length) ids.add(id);
    const merged = new Map<string, SessionNotes>();
    const changes = new Map<string, SessionNotes | undefined>();
    let notesChanged = false;
    for (const id of ids) {
      const record = records.get(id);
      const about = remote.get(id) ?? base.get(id);
      const outcome: { before: readonly NoteEntry[]; result: SessionNotes | undefined } = { before: [], result: undefined };
      const written = this.records.updateNotes(
        id,
        (notes) => {
          outcome.before = notes;
          const host = here.of(id) ? this.host : undefined;
          outcome.result = mergeNotes(base.get(id), { agent: record?.agent, title: record?.title, host, notes }, remote.get(id), now);
          return outcome.result?.notes ?? [];
        },
        about && { agent: about.agent, title: about.title },
      );
      const result = outcome.result;
      if (result) merged.set(id, result);
      // A base that says more than the records would take a note away everywhere: it keeps what it had.
      if (!written) continue;
      if (!sameJson(outcome.before, result?.notes ?? [])) notesChanged = true;
      if (!sameJson(base.get(id), result)) changes.set(id, result);
    }

    // The synced copies, within the limit less the room the writer's name takes in each, then the bases.
    const fit = fitSync(state, merged, SYNC_LIMIT - 2 * Buffer.byteLength(JSON.stringify({ by: this.host })));
    const stateCopy = this.copy(SYNC_STATE_KEY, fit.state, (value) => ordered({ ...value, by: this.host }));
    const notesCopy = this.copy(SYNC_NOTES_KEY, fit.notes, (value) => ({ ...value, by: this.host }));
    if (!sameJson(stateBase, state)) void this.state.update(SYNC_BASE_KEY, state);
    if (changes.size > 0) this.writeBase(changes);
    this.saw(seen, stateCopy, notesCopy);
    this.tell(fit);
    let notesKept = 0;
    for (const value of merged.values()) notesKept += value.notes.length;
    this.last = {
      mergedAt: now,
      stars: state.favourites.ids.length,
      archived: state.archive.ids.length,
      parked: state.parked.ids.length,
      notes: notesKept,
      sessions: [...merged.values()].filter((value) => value.notes.length > 0).length,
      fit,
    };
    if (keys.length > 0 || notesChanged) this.deps.changed?.();
  }

  /**
   * The synced copy of `key` as this machine holds it after the merge: the
   * one there when it holds what the merge says (whoever wrote it), else
   * `value` written, naming this machine.
   */
  private copy<T extends object>(key: string, value: T, named: (value: T) => T): unknown {
    const held = this.state.get<unknown>(key);
    if (sameJson(withoutBy(held), value)) return held;
    const written = named(value);
    void this.state.update(key, written);
    return written;
  }

  /**
   * Notes the synced copies another machine wrote since this one last saw
   * them, and says so in Lookout's log: a copy that is not the one this
   * machine last saw or wrote. A copy that names no machine, on a machine
   * that has seen none yet, may be its own from before 0.1.7: not noted.
   */
  private noticeArrivals(now: number): SyncSeen {
    const seen = readSeen(this.state.get<unknown>(SYNC_SEEN_KEY));
    const next: SyncSeen = { ...seen };
    const look = (key: "state" | "notes", value: unknown, counts: () => Omit<Arrival, "at" | "by">) => {
      if (value === undefined) return;
      const digest = digestOf(value);
      if (digest === seen[key]) return;
      next[key] = digest;
      const by = byOf(value);
      if (by === this.host || (seen[key] === undefined && by === undefined)) return;
      const arrival: Arrival = { at: now, ...(by === undefined ? {} : { by }), ...counts() };
      next.arrived = { ...next.arrived, [key]: arrival };
      this.deps.log?.info(`Settings Sync brought ${by === undefined ? "another machine" : `${plainText(by, 80)}`}'s copy of ${key === "state" ? `the stars and lists: ${plural(arrival.stars ?? 0, "star")}` : `the notes: ${plural(arrival.notes ?? 0, "note")} on ${plural(arrival.sessions ?? 0, "session")}`}.`);
    };
    look("state", this.state.get<unknown>(SYNC_STATE_KEY), () => ({ stars: readSyncedState(this.state.get<unknown>(SYNC_STATE_KEY))?.favourites.ids.length ?? 0 }));
    look("notes", this.state.get<unknown>(SYNC_NOTES_KEY), () => {
      const sessions = [...(readSyncedNotes(this.state.get<unknown>(SYNC_NOTES_KEY))?.values() ?? [])];
      return { notes: sessions.reduce((sum, value) => sum + value.notes.length, 0), sessions: sessions.filter((value) => value.notes.length > 0).length };
    });
    return next;
  }

  /** Remembers the synced copies as this machine leaves them, so the next merge tells another machine's from its own. */
  private saw(seen: SyncSeen, state: unknown, notes: unknown): void {
    const next: SyncSeen = { ...seen };
    if (state !== undefined) next.state = digestOf(state);
    if (notes !== undefined) next.notes = digestOf(notes);
    if (!sameJson(readSeen(this.state.get<unknown>(SYNC_SEEN_KEY)), next)) void this.state.update(SYNC_SEEN_KEY, next);
  }

  /**
   * With the setting off: Settings Sync is given no keys, and the synced
   * copies leave this machine's globalState. A machine that never gave it
   * keys gives it none, not an empty list: Settings Sync then leaves
   * Lookout out entirely, where an empty list has it send an empty state,
   * which takes the other machines' synced copies out of the cloud.
   */
  private stop(): void {
    if (this.state.get<unknown>(SYNC_REGISTERED_KEY) === true) {
      this.syncKeys([]);
      void this.state.update(SYNC_REGISTERED_KEY, undefined);
    }
    for (const key of SYNC_KEYS) if (this.state.get<unknown>(key) !== undefined) void this.state.update(key, undefined);
  }

  /** Gives Settings Sync the keys to sync when they are not the ones this window gave it last. */
  private syncKeys(keys: readonly string[]): void {
    const set = [...keys].sort().join("\n");
    if (set === this.keysForSync) return;
    this.keysForSync = set;
    this.state.setKeysForSync([...keys]);
  }

  /** Says what no longer syncs when the synced copies first leave something out, and not again until it all fits once more. */
  private tell(fit: SyncFit): void {
    const told = this.state.get<unknown>(SYNC_CAPPED_KEY) === true;
    if (fit.archiveLeft === 0 && fit.notesLeft === 0 && fit.restLeft === 0) {
      if (told) void this.state.update(SYNC_CAPPED_KEY, undefined);
      return;
    }
    if (told) return;
    void this.state.update(SYNC_CAPPED_KEY, true);
    const parts: string[] = [];
    if (fit.archiveLeft > 0) parts.push(fit.archiveLeft === 1 ? "the oldest archived session" : `the ${fit.archiveLeft} oldest archived sessions`);
    if (fit.notesLeft > 0) parts.push(`${fit.notesLeft === 1 ? "1 note" : `${fit.notesLeft} notes`} on ${fit.sessionsLeft === 1 ? "an older session" : `${fit.sessionsLeft} older sessions`}`);
    if (fit.restLeft > 0) parts.push("older stars, parked sessions and removals");
    const what = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
    void vscode.window
      .showWarningMessage(`Lookout: ${what} no longer sync to your other machines, as Settings Sync keeps Lookout's data under 64 KB. They stay on this machine, and a backup carries them.`, "Back Up…")
      .then((choice) => {
        if (choice === "Back Up…") void Promise.resolve(vscode.commands.executeCommand(BACK_UP_COMMAND)).catch(() => undefined);
      });
  }

  /** Writes what changed into the notes' base, as the file has it now: another window may have written its own merges since. */
  private writeBase(changes: ReadonlyMap<string, SessionNotes | undefined>): void {
    const sessions = readBase(this.baseFile);
    for (const [id, value] of changes) {
      if (value) sessions.set(id, value);
      else sessions.delete(id);
    }
    const temp = `${this.baseFile}.${process.pid}.${++this.saves}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.baseFile), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(syncedNotes(sessions)));
      fs.renameSync(temp, this.baseFile);
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Nothing to take back.
      }
      // The base as it was says less than the records: a note taken away meanwhile may come back, none is lost.
      this.deps.log?.errorOnce(`Lookout could not write ${this.baseFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.records.dispose();
  }
}

/**
 * Syncs the light state and the notes through Settings Sync while the
 * setting is on: merges when the window opens and when the setting changes;
 * then, while it is the window in front, when the records change and once a
 * minute; and whenever it comes to the front.
 */
export function registerSettingsSync(context: Pick<vscode.ExtensionContext, "globalState">, deps: SettingsSyncDeps): vscode.Disposable {
  const sync = new SettingsSync(context.globalState, deps);
  const inFront = () => vscode.window.state.focused;
  let front = inFront();
  const watch = sync.records.watch(() => {
    if (inFront()) sync.merge();
  });
  const windowState = vscode.window.onDidChangeWindowState(() => {
    const now = inFront();
    if (now && !front) sync.merge();
    front = now;
  });
  const setting = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(`lookout.${SYNC_SETTING}`)) sync.merge();
  });
  const timer = setInterval(() => {
    if (inFront()) sync.merge();
  }, deps.mergeEveryMs ?? MERGE_EVERY_MS);
  const status = registerSettingsSyncStatus(sync, deps);
  sync.merge();
  return {
    dispose: () => {
      clearInterval(timer);
      status.dispose();
      setting.dispose();
      windowState.dispose();
      watch.dispose();
      sync.dispose();
    },
  };
}

/** Registers Lookout: Settings Sync Status for this window's sync. */
export function registerSettingsSyncStatus(sync: SettingsSync, deps: SettingsSyncDeps): vscode.Disposable {
  return vscode.commands.registerCommand(SYNC_STATUS_COMMAND, () => showStatus(sync, deps));
}

/** Lookout: Settings Sync Status: what this machine syncs, what came from another, and what is not here. */
export async function showStatus(sync: SettingsSync, deps: Pick<SettingsSyncDeps, "elsewhere" | "version">): Promise<void> {
  const status = sync.status();
  const lines: string[] = [];
  const remote = vscode.env.remoteName;
  if (!status.enabled) lines.push("lookout.settingsSync.enabled is off: Lookout gives Settings Sync nothing, and sends nothing off the machine.");
  else lines.push("Lookout syncs your stars, lists and notes through VS Code's Settings Sync, in its Extensions category.");
  if (remote) lines.push(`This window's Lookout runs in ${plainText(remote, 40)}. Settings Sync carries Lookout's data only where Lookout is also installed in VS Code itself, with Settings Sync on and its Extensions category ticked.`);
  if (status.enabled) {
    lines.push(`VS Code applies Lookout's synced data only on a machine that runs the same version of Lookout as the one that sent it${deps.version ? `: this one runs ${plainText(deps.version, 40)}` : ""}. Machines on different versions exchange nothing until both run the same one.`);
    lines.push(status.mergedAt ? `This window last merged at ${clock(status.mergedAt)}.` : "This window has not merged yet.");
    const arrived = [status.arrived.state, status.arrived.notes].filter((a): a is Arrival => a !== undefined);
    if (arrived.length === 0) lines.push("No copy another machine wrote has arrived on this machine yet.");
    for (const [what, arrival] of [
      ["the stars and lists", status.arrived.state],
      ["the notes", status.arrived.notes],
    ] as const) {
      if (!arrival) continue;
      const counts = arrival.stars !== undefined ? plural(arrival.stars, "star") : `${plural(arrival.notes ?? 0, "note")} on ${plural(arrival.sessions ?? 0, "session")}`;
      lines.push(`The last copy of ${what} from another machine came from ${arrival.by ? plainText(arrival.by, 80) : "a machine with an older Lookout"} on ${dateTime(arrival.at)}: ${counts}.`);
    }
    if (status.mergedAt) lines.push(`This machine syncs ${plural(status.stars, "star")}, ${plural(status.archived, "archived session")}, ${plural(status.parked, "parked session")} and ${plural(status.notes, "note")} on ${plural(status.sessions, "session")}.`);
    const elsewhere = deps.elsewhere?.();
    if (elsewhere && elsewhere.sessions > 0) {
      lines.push(`${plural(elsewhere.sessions, "starred or noted session")} (${plural(elsewhere.stars, "star")}, ${plural(elsewhere.notes, "note")}) ${elsewhere.sessions === 1 ? "is" : "are"} of conversations that are not on this machine: the board shows them under On other machines, and restoring a backup made on their machine brings the conversations.`);
    }
    const fit = status.fit;
    if (fit && (fit.archiveLeft > 0 || fit.notesLeft > 0 || fit.restLeft > 0)) {
      const left: string[] = [];
      if (fit.archiveLeft > 0) left.push(plural(fit.archiveLeft, "archived session"));
      if (fit.notesLeft > 0) left.push(`${plural(fit.notesLeft, "note")} on ${plural(fit.sessionsLeft, "older session")}`);
      if (fit.restLeft > 0) left.push(`${plural(fit.restLeft, "older star, parked session or removal")}`);
      lines.push(`To stay under 64 KB, the synced copies leave out ${left.join(", ")}. They stay on this machine, and a backup carries them.`);
    }
  }
  const SYNC_NOW = "Sync Now";
  const SHOW_LOG = "Show Settings Sync Log";
  const RESTORE = "Restore from Backup…";
  const buttons = status.enabled ? [SYNC_NOW, SHOW_LOG, RESTORE] : [RESTORE];
  const pick = await vscode.window.showInformationMessage("Lookout's Settings Sync", { modal: true, detail: lines.join("\n\n") }, ...buttons);
  const command = pick === SYNC_NOW ? SYNC_NOW_COMMAND : pick === SHOW_LOG ? SYNC_LOG_COMMAND : pick === RESTORE ? RESTORE_COMMAND : undefined;
  if (command) void Promise.resolve(vscode.commands.executeCommand(command)).catch(() => undefined);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dateTime(ms: number): string {
  const at = new Date(ms);
  return `${at.toLocaleDateString(undefined, { month: "long", day: "numeric" })} at ${clock(ms)}`;
}

/** A synced copy without the machine that wrote it: what it holds. */
function withoutBy(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("by" in value)) return value;
  const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete rest.by;
  return rest;
}

/** The machine a synced copy names as its writer. */
function byOf(value: unknown): string | undefined {
  const by = typeof value === "object" && value !== null ? (value as { by?: unknown }).by : undefined;
  return typeof by === "string" && by !== "" ? by : undefined;
}

/** A short digest of a synced copy, to tell one copy from another without keeping it. */
function digestOf(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value) ?? "").digest("base64").slice(0, 22);
}

function readSeen(raw: unknown): SyncSeen {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: SyncSeen = {};
  if (typeof r.state === "string") out.state = r.state;
  if (typeof r.notes === "string") out.notes = r.notes;
  const arrived = typeof r.arrived === "object" && r.arrived !== null ? (r.arrived as Record<string, unknown>) : {};
  const arrival = (value: unknown): Arrival | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const a = value as Record<string, unknown>;
    if (typeof a.at !== "number" || !Number.isFinite(a.at)) return undefined;
    const count = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined);
    const out: Arrival = { at: a.at };
    if (typeof a.by === "string" && a.by !== "") out.by = a.by;
    for (const key of ["stars", "notes", "sessions"] as const) {
      const n = count(a[key]);
      if (n !== undefined) out[key] = n;
    }
    return out;
  };
  const state = arrival(arrived.state);
  const notes = arrival(arrived.notes);
  if (state || notes) out.arrived = { ...(state ? { state } : {}), ...(notes ? { notes } : {}) };
  return out;
}

/** What this machine merged last of the notes, by session id; nothing for a file that is missing or does not read, which only lets a note taken away come back. */
function readBase(file: string): Map<string, SessionNotes> {
  try {
    return readSyncedNotes(JSON.parse(fs.readFileSync(file, "utf8"))) ?? new Map();
  } catch {
    return new Map();
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
