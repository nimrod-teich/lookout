// Lookout's synced values kept small. Settings Sync carries an extension's
// synced keys with every other extension's in its Extensions category, and
// a category that grows too big stops syncing whole, so the two values
// together stay under 64 KB of JSON. Past that, the synced copies leave out
// the oldest archived sessions first, then the oldest sessions' notes, then
// older tombstones, then what the stars carry of the oldest starred sessions,
// then older stars, parked sessions and kept ones. What a synced copy leaves out
// stays on this machine, and takes nothing away elsewhere: only a tombstone
// removes anything. Nothing here touches the disk.
import { lastChange, syncedNotes, type SessionNotes, type SyncedNotes } from "./syncedNotes";
import { LISTS, type ListName, type Stamped, type SyncedState } from "./syncedState";
import { SYNC_NOTES_KEY, SYNC_STATE_KEY } from "./transfer/types";

/** The JSON of Lookout's synced values together stays within this many bytes. */
export const SYNC_LIMIT = 64 * 1024;

/** The synced copies, and what they leave out. */
export interface SyncFit {
  state: SyncedState;
  notes: SyncedNotes;
  /** Archived sessions left out of the state's copy. */
  archiveLeft: number;
  /** Sessions with notes left out, and the notes they hold. */
  sessionsLeft: number;
  notesLeft: number;
  /** Stars, parked sessions, tombstones and what stars carry, left out besides. */
  restLeft: number;
  /** The JSON of both values, in bytes. */
  bytes: number;
}

/** The JSON of the synced values, both keys in one object, in bytes. */
export function syncBytes(state: unknown, notes: unknown): number {
  return Buffer.byteLength(JSON.stringify({ [SYNC_STATE_KEY]: state, [SYNC_NOTES_KEY]: notes }));
}

/** What a list entry is called among those of every list. */
type Entry = { list: ListName; entry: Stamped };

/**
 * The synced copies of the merged state and notes, within `limit` bytes.
 * Each step leaves out as little as it can: the archive's oldest sessions
 * first; then the notes of the sessions that changed longest ago, every
 * session older than the first left out going too; then the oldest
 * tombstones of every list; then the titles and machines the oldest
 * starred sessions carry, the star kept; then the oldest kept, parked and
 * starred sessions, in that order, a star with what it carries. The board's order and grouping and the account
 * names always stay. Within a list the newest go last, by when each was put
 * there and then by its place; ties are broken by id, so machines with the
 * same state choose the same.
 */
export function fitSync(state: SyncedState, sessions: ReadonlyMap<string, SessionNotes>, limit: number = SYNC_LIMIT): SyncFit {
  const archive = newestFirst(state.archive.ids);
  const bySession = [...sessions].sort(([a, x], [b, y]) => lastChange(y) - lastChange(x) || compare(a, b));
  const tombstones: Entry[] = LISTS.flatMap((list) => state[list].removed.map((entry) => ({ list, entry })));
  tombstones.sort((a, b) => b.entry[1] - a.entry[1] || LISTS.indexOf(a.list) - LISTS.indexOf(b.list) || compare(a.entry[0], b.entry[0]));
  const members: Entry[] = (["favourites", "parked", "kept"] as const).flatMap((list) => newestFirst(state[list].ids).map((entry) => ({ list, entry })));
  const about = Object.entries(state.about ?? {}).sort(([a, x], [b, y]) => y.at - x.at || compare(a, b));

  // How many of each, newest first, the copies keep.
  const keep = { archive: archive.length, sessions: bySession.length, tombstones: tombstones.length, about: about.length, members: members.length };
  const build = () => {
    const kept = new Set<string>();
    for (const [id] of archive.slice(0, keep.archive)) kept.add(`archive\0${id}`);
    for (const { list, entry } of members.slice(0, keep.members)) kept.add(`${list}\0${entry[0]}`);
    const gone = new Set(tombstones.slice(0, keep.tombstones).map(({ list, entry }) => `${list}\0${entry[0]}`));
    const copy: SyncedState = { ...state };
    for (const list of LISTS) copy[list] = { ids: state[list].ids.filter(([id]) => kept.has(`${list}\0${id}`)), removed: state[list].removed.filter(([id]) => gone.has(`${list}\0${id}`)) };
    // What a star carries goes with the star.
    const told = about.slice(0, keep.about).filter(([id]) => kept.has(`favourites\0${id}`));
    if (told.length > 0) copy.about = Object.fromEntries(told.sort(([a], [b]) => compare(a, b)));
    else delete copy.about;
    return { state: copy, notes: syncedNotes(new Map(bySession.slice(0, keep.sessions))) };
  };
  const fits = () => {
    const copies = build();
    return syncBytes(copies.state, copies.notes) <= limit;
  };

  for (const step of ["archive", "sessions", "tombstones", "about", "members"] as const) {
    if (fits()) break;
    // The most of this step's entries that fit; none when even that is too many.
    let low = 0;
    let high = keep[step] - 1;
    let best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      keep[step] = mid;
      if (fits()) {
        best = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    keep[step] = best;
  }

  const copies = build();
  const left = bySession.slice(keep.sessions).filter(([, value]) => value.notes.length > 0);
  return {
    ...copies,
    archiveLeft: archive.length - keep.archive,
    sessionsLeft: left.length,
    notesLeft: left.reduce((sum, [, value]) => sum + value.notes.length, 0),
    restLeft: tombstones.length - keep.tombstones + (about.length - keep.about) + (members.length - keep.members),
    bytes: syncBytes(copies.state, copies.notes),
  };
}

/** A list's entries, the most recently put there first, and of those put there at once, the first in the list first. */
function newestFirst(ids: readonly Stamped[]): Stamped[] {
  return ids
    .map((entry, place) => ({ entry, place }))
    .sort((a, b) => b.entry[1] - a.entry[1] || a.place - b.place)
    .map(({ entry }) => entry);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
