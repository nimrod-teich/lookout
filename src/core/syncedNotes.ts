// The notes as Settings Sync carries them from machine to machine: one
// synced value holds every session's notes, each session's with the notes
// taken away from it lately, so a note removed on one machine does not come
// back from another. A machine merges each session three ways: what it
// merged last (the base), its own records (local) and the synced value
// (remote), which Settings Sync replaces whole with another machine's copy.
// Nothing here touches the disk.
import { cleanNote, type NoteEntry } from "./sessionRecords";

/** A note taken away, and when, epoch ms. */
export interface Tombstone {
  id: string;
  at: number;
}

/** A session's notes as they sync. */
export interface SessionNotes {
  /** Id of the agent provider the session belongs to. */
  agent: string;
  /** Its title, for a machine that has no record of the session. */
  title?: string;
  /** Oldest first. */
  notes: NoteEntry[];
  /** The notes taken away in the last 90 days, by id. */
  removed: Tombstone[];
}

/** Every session's notes, by session id, as the synced value and this machine's base hold them. */
export interface SyncedNotes {
  v: 1;
  sessions: Record<string, SessionNotes>;
}

/** What this machine's records hold of a session. */
export interface LocalNotes {
  agent?: string;
  title?: string;
  notes: readonly NoteEntry[];
}

/** A note taken away is remembered this long, so a machine that still has it does not bring it back. */
export const TOMBSTONE_MS = 90 * 24 * 3_600_000;

/** The longest session id a synced value is read for. */
const ID_MAX = 256;

/** A session id as a synced value may name one. */
export function isSyncedId(id: unknown): id is string {
  return typeof id === "string" && id !== "" && id.length <= ID_MAX;
}

/**
 * Every session's notes in a synced value; none for a value that is not
 * one. A session whose id or notes do not read is left out.
 */
export function readSyncedNotes(value: unknown): Map<string, SessionNotes> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { v, sessions } = value as { v?: unknown; sessions?: unknown };
  if (v !== 1 || typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) return undefined;
  const out = new Map<string, SessionNotes>();
  for (const [id, raw] of Object.entries(sessions)) {
    const notes = readSessionNotes(raw);
    if (notes && isSyncedId(id)) out.set(id, notes);
  }
  return out;
}

/** The synced value of every session's notes, the sessions in the order of their ids, so machines with the same notes write the same JSON. */
export function syncedNotes(sessions: ReadonlyMap<string, SessionNotes>): SyncedNotes {
  const ids = [...sessions.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { v: 1, sessions: Object.fromEntries(ids.map((id) => [id, sessions.get(id)!])) };
}

/**
 * A session's notes as this version reads them; none for a value that is
 * not a session's notes. A note or a tombstone that does not read is left
 * out, and of two notes with one id the later change is kept.
 */
export function readSessionNotes(value: unknown): SessionNotes | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Partial<Record<keyof SessionNotes, unknown>>;
  if (typeof r.agent !== "string" || r.agent === "" || !Array.isArray(r.notes)) return undefined;
  const byId = new Map<string, NoteEntry>();
  for (const raw of r.notes) {
    const note = readNote(raw);
    if (!note) continue;
    const other = byId.get(note.id);
    byId.set(note.id, other ? later(note, other) : note);
  }
  const removed = new Map<string, number>();
  for (const raw of Array.isArray(r.removed) ? r.removed : []) {
    const t = raw as Partial<Record<keyof Tombstone, unknown>> | null;
    if (typeof t?.id !== "string" || t.id === "" || !finite(t.at)) continue;
    removed.set(t.id, Math.max(removed.get(t.id) ?? -Infinity, t.at));
  }
  return session(r.agent, typeof r.title === "string" ? r.title : undefined, sortNotes([...byId.values()]), sortTombstones(removed));
}

/**
 * Merges a session's notes three ways. A note is kept when this machine or
 * the remote copy has it and no tombstone outdates it; of two versions of
 * one note, the later change wins. A note the base has and this machine no
 * longer has was taken away here, and gets a tombstone. Only a tombstone
 * takes a note away: a remote copy that is missing, or that lacks a note,
 * says nothing, since Settings Sync drops a key a machine stopped syncing
 * and keeps one machine's copy of a key two machines changed, and a synced
 * value leaves the oldest sessions out to stay small.
 *
 * A note edited on one machine and taken away on another: the later of the
 * two wins. A note changed after its tombstone was made stays, and the
 * tombstone goes; one changed no later is taken away. A tombstone is kept
 * 90 days: a machine that comes back with the note after that brings it
 * back.
 *
 * The agent and the title come from the synced copy first, then the base,
 * then this machine's records, so every machine settles on the same ones.
 * Undefined when nothing is left to keep: no note and no tombstone.
 */
export function mergeNotes(base: SessionNotes | undefined, local: LocalNotes, remote: SessionNotes | undefined, now: number): SessionNotes | undefined {
  const removed = new Map<string, number>();
  const tombstone = (id: string, at: number) => removed.set(id, Math.max(removed.get(id) ?? -Infinity, at));
  for (const t of [...(base?.removed ?? []), ...(remote?.removed ?? [])]) if (now - t.at < TOMBSTONE_MS) tombstone(t.id, t.at);
  const here = new Set(local.notes.map((note) => note.id));
  // Taken away here since the last merge. A note already tombstoned keeps its tombstone's time.
  for (const note of base?.notes ?? []) if (!here.has(note.id) && !removed.has(note.id)) removed.set(note.id, now);

  const byId = new Map<string, NoteEntry>();
  for (const note of [...local.notes, ...(remote?.notes ?? [])]) {
    const other = byId.get(note.id);
    byId.set(note.id, other ? later(note, other) : copyNote(note));
  }
  const notes = sortNotes(
    [...byId.values()].filter((note) => {
      const gone = removed.get(note.id);
      return gone === undefined || changedAt(note) > gone;
    }),
  );
  for (const note of notes) removed.delete(note.id);
  if (notes.length === 0 && removed.size === 0) return undefined;

  const agent = remote?.agent ?? base?.agent ?? local.agent;
  if (!agent) return undefined;
  return session(agent, remote?.title ?? base?.title ?? local.title, notes, sortTombstones(removed));
}

/** When the session's notes last changed: a note written or edited, or one taken away. */
export function lastChange(value: SessionNotes): number {
  let at = 0;
  for (const note of value.notes) at = Math.max(at, changedAt(note));
  for (const t of value.removed) at = Math.max(at, t.at);
  return at;
}

/** When a note was last changed. */
function changedAt(note: NoteEntry): number {
  return note.editedAt ?? note.at;
}

/** Of two versions of one note, the one kept: the later change, and for two changes at the same time, the same one on every machine. */
function later(a: NoteEntry, b: NoteEntry): NoteEntry {
  if (changedAt(a) !== changedAt(b)) return copyNote(changedAt(a) > changedAt(b) ? a : b);
  if (a.text !== b.text) return copyNote(a.text > b.text ? a : b);
  return copyNote(a.at >= b.at ? a : b);
}

/** A note with its fields in one order, so two copies of it read alike. */
function copyNote(note: NoteEntry): NoteEntry {
  const out: NoteEntry = { id: note.id, text: note.text, at: note.at };
  if (note.editedAt !== undefined) out.editedAt = note.editedAt;
  return out;
}

function readNote(raw: unknown): NoteEntry | undefined {
  const n = raw as Partial<Record<keyof NoteEntry, unknown>> | null;
  if (typeof n?.id !== "string" || n.id === "" || !finite(n.at)) return undefined;
  const text = cleanNote(typeof n.text === "string" ? n.text : undefined);
  if (text === undefined) return undefined;
  const note: NoteEntry = { id: n.id, text, at: n.at };
  if (finite(n.editedAt)) note.editedAt = n.editedAt;
  return note;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Oldest first, as the records keep them; notes written at the same time in the order of their ids. */
function sortNotes(notes: NoteEntry[]): NoteEntry[] {
  return notes.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortTombstones(removed: ReadonlyMap<string, number>): Tombstone[] {
  return [...removed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, at]) => ({ id, at }));
}

/** A session's notes with their fields in one order, so two machines' copies of the same notes are the same JSON. */
function session(agent: string, title: string | undefined, notes: NoteEntry[], removed: Tombstone[]): SessionNotes {
  return title === undefined ? { agent, notes, removed } : { agent, title, notes, removed };
}
