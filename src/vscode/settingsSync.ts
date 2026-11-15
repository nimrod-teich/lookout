// The light state and the notes follow the user from machine to machine
// through Settings Sync, once `lookout.settingsSync.enabled` is on. Settings
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
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { SessionRecords, type NoteEntry } from "../core/sessionRecords";
import { mergeNotes, readSyncedNotes, syncedNotes, type SessionNotes } from "../core/syncedNotes";
import { changedKeys, localValues, mergeState, readLocalState, readSyncedState } from "../core/syncedState";
import { fitSync, type SyncFit } from "../core/syncLimit";
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

/** The window in front merges this often: Settings Sync says nothing of the values it pulls. */
export const MERGE_EVERY_MS = 60_000;

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
  log?: Pick<Log, "errorOnce">;
}

/** Whether the user turned Settings Sync on for Lookout. */
export function syncEnabled(): boolean {
  return vscode.workspace.getConfiguration("lookout").get<boolean>(SYNC_SETTING, false) === true;
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

  constructor(
    private readonly state: SyncedMemento,
    private readonly deps: SettingsSyncDeps,
  ) {
    this.records = new SessionRecords(deps.recordsDir);
    this.baseFile = deps.baseFile ?? path.join(path.dirname(deps.recordsDir), BASE_FILE);
    this.now = deps.now ?? Date.now;
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

    // The light state: Lookout's keys, written back where the merge changed them.
    const local = readLocalState((key) => this.state.get<unknown>(key));
    const stateBase = readSyncedState(this.state.get<unknown>(SYNC_BASE_KEY));
    const state = mergeState(stateBase, local, readSyncedState(this.state.get<unknown>(SYNC_STATE_KEY)), now);
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
          outcome.result = mergeNotes(base.get(id), { agent: record?.agent, title: record?.title, notes }, remote.get(id), now);
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

    // The synced copies, within the limit, then the bases.
    const fit = fitSync(state, merged);
    if (!sameJson(this.state.get<unknown>(SYNC_STATE_KEY), fit.state)) void this.state.update(SYNC_STATE_KEY, fit.state);
    if (!sameJson(this.state.get<unknown>(SYNC_NOTES_KEY), fit.notes)) void this.state.update(SYNC_NOTES_KEY, fit.notes);
    if (!sameJson(stateBase, state)) void this.state.update(SYNC_BASE_KEY, state);
    if (changes.size > 0) this.writeBase(changes);
    this.tell(fit);
    if (keys.length > 0 || notesChanged) this.deps.changed?.();
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
  sync.merge();
  return {
    dispose: () => {
      clearInterval(timer);
      setting.dispose();
      windowState.dispose();
      watch.dispose();
      sync.dispose();
    },
  };
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
