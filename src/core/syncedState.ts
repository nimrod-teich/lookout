// The light state as Settings Sync carries it from machine to machine, in
// one synced value: the stars, the archive and the parked sessions as sets
// that remember what was taken out of them lately, the board's order and
// grouping as single values, and the account names. A machine merges three
// ways, as for the notes: what it merged last (the base), its own state
// (local) and the synced value (remote), which Settings Sync replaces whole
// with another machine's copy when both changed it. Nothing here touches
// the disk.
//
// The stars also carry what a machine that has a starred session knows of
// it, its title, agent and machine, for a machine that does not have the
// conversation: it shows the star under On other machines.
import { readGroupBy, type GroupBy } from "./grouping";
import { readParking, type Parking } from "./parking";
import { readSort, type SessionSort } from "./sorting";
import { isSyncedId, TOMBSTONE_MS } from "./syncedNotes";
import type { LightStateKey } from "./transfer/types";

/** A session id, and when it was put in a list or taken out of it, epoch ms. */
export type Stamped = [id: string, at: number];

/** A list of session ids as it syncs. */
export interface SyncedList {
  /** The ids in it, in this machine's order, each with when it was put there; 0 for one there before this machine first merged. */
  ids: Stamped[];
  /** The ids taken out in the last 90 days, each with when, in the order of the ids. */
  removed: Stamped[];
}

/**
 * What the machine a starred session is on tells the others of it: its
 * title, its agent and the machine's name, and when it said so last.
 */
export interface AboutSession {
  title?: string;
  agent?: string;
  host?: string;
  at: number;
}

/** What a machine knows of the sessions on it, for the stars' `about`. */
export interface SessionsHere {
  /** This machine's name, os.hostname(). */
  host: string;
  /** A session on this machine: its title and agent; none for one that is not here. */
  of(id: string): { title?: string; agent?: string } | undefined;
}

/** The longest title, agent id and machine name an `about` entry is read with. */
const TITLE_MAX = 300;
const AGENT_MAX = 64;
const HOST_MAX = 255;
/** The longest title read at all; up to it, a title is cut to TITLE_MAX. */
const READ_MAX = 4096;

/** The lists of the light state, as the synced value names them. */
export const LISTS = ["favourites", "archive", "parked", "kept"] as const;
export type ListName = (typeof LISTS)[number];

/** The light state as the synced value and this machine's base hold it. */
export interface SyncedState extends Record<ListName, SyncedList> {
  v: 1;
  /** The board's order, once one was chosen. */
  sort?: SessionSort;
  /** The board's grouping, once one was chosen. */
  group?: GroupBy;
  /** The Claude accounts seen signed in: organization uuid → the key of the account's address. */
  claudeOrgs: Record<string, string>;
  /** Of each starred session, what the machine it is on says of it, by session id. */
  about?: Record<string, AboutSession>;
  /** The machine that last changed the synced copy; only the synced value carries it. */
  by?: string;
}

/** This machine's light state, as Lookout keeps it in globalState. */
export interface LocalState {
  favourites: string[];
  archive: string[];
  parking: Parking;
  sort?: SessionSort;
  group?: GroupBy;
  claudeOrgs: Record<string, string>;
}

/** This machine's light state from the keys Lookout keeps it under; `get` reads a key. */
export function readLocalState(get: (key: LightStateKey) => unknown): LocalState {
  const sort = get("lookout.sort");
  const group = get("lookout.group");
  const out: LocalState = { favourites: ids(get("lookout.favourites")), archive: ids(get("lookout.archive")), parking: readParking(get("lookout.parking")), claudeOrgs: readOrgs(get("lookout.claudeOrgs")) };
  if (sort !== undefined) out.sort = readSort(sort);
  if (group !== undefined) out.group = readGroupBy(group);
  return out;
}

/** What each of Lookout's keys holds once the state is merged; undefined leaves a key unset. */
export function localValues(state: SyncedState): Record<LightStateKey, unknown> {
  const list = (name: ListName) => state[name].ids.map(([id]) => id);
  return {
    "lookout.favourites": list("favourites"),
    "lookout.archive": list("archive"),
    "lookout.parking": { parked: list("parked"), kept: list("kept") },
    "lookout.sort": state.sort,
    "lookout.group": state.group,
    "lookout.claudeOrgs": state.claudeOrgs,
  };
}

/** The keys a merged state changes: those whose value differs from what this machine holds. */
export function changedKeys(local: LocalState, state: SyncedState): LightStateKey[] {
  const before = localValues(fromLocal(local));
  const after = localValues(state);
  return (Object.keys(after) as LightStateKey[]).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/** A synced value or a base as this version reads it; none for one that is not the light state. What does not read in it is left out. */
export function readSyncedState(value: unknown): SyncedState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (r.v !== 1) return undefined;
  const out: SyncedState = { v: 1, favourites: readList(r.favourites), archive: readList(r.archive), parked: readList(r.parked), kept: readList(r.kept), claudeOrgs: readOrgs(r.claudeOrgs) };
  if (typeof r.sort === "object" && r.sort !== null && !Array.isArray(r.sort)) out.sort = readSort(r.sort);
  if (typeof r.group === "string" && readGroupBy(r.group) === r.group) out.group = r.group as GroupBy;
  const about = readAbout(r.about);
  if (Object.keys(about).length > 0) out.about = about;
  if (typeof r.by === "string" && r.by !== "" && r.by.length <= HOST_MAX) out.by = r.by;
  return ordered(out);
}

/**
 * Merges the light state three ways. Each list is a set: an id is in it
 * when this machine or the remote copy has it and no tombstone outdates it;
 * one the base has and this machine no longer has was taken out here, and
 * gets a tombstone. Only a tombstone takes an id out: a remote copy that is
 * missing, or that lacks an id, says nothing. The list keeps this
 * machine's order, with what the remote copy adds after it. A session is
 * parked or kept, not both: the later of the two wins, parked on a tie.
 *
 * The board's order and grouping: this machine's when it changed since the
 * last merge, else the remote copy's. The account names: both machines',
 * this machine's where they differ.
 *
 * With no base, on this machine's first merge, what this machine has counts
 * as older than anything the remote copy says: an id another machine took
 * out stays out, and the remote copy's order and grouping are taken.
 *
 * What the stars carry of their sessions: see `mergeAbout`. The merged state
 * names no machine (`by`): the one that writes it as the synced copy does.
 */
export function mergeState(base: SyncedState | undefined, local: LocalState, remote: SyncedState | undefined, now: number, here?: SessionsHere): SyncedState {
  const first = base === undefined;
  const merged: SyncedState = {
    v: 1,
    favourites: mergeList(base?.favourites, local.favourites, remote?.favourites, now, first),
    archive: mergeList(base?.archive, local.archive, remote?.archive, now, first),
    parked: mergeList(base?.parked, local.parking.parked, remote?.parked, now, first),
    kept: mergeList(base?.kept, local.parking.kept, remote?.kept, now, first),
    claudeOrgs: { ...remote?.claudeOrgs, ...local.claudeOrgs },
  };
  apart(merged.parked, merged.kept);
  const sort = single(base?.sort, local.sort, remote?.sort, first);
  if (sort !== undefined) merged.sort = sort;
  const group = single(base?.group, local.group, remote?.group, first);
  if (group !== undefined) merged.group = group;
  const about = mergeAbout(base?.about, remote?.about, merged.favourites.ids.map(([id]) => id), here, now);
  if (Object.keys(about).length > 0) merged.about = about;
  return ordered(merged);
}

/**
 * What the stars carry of their sessions, for the starred ids only. Of the
 * base's and the remote copy's word on a session, the later one. A machine
 * that has the session says what it knows of it when no machine has yet,
 * or when it was the one that said it and the title or agent changed since;
 * a machine that also has the session, after a restore, leaves the first
 * one's word as it is, so two machines never take turns rewriting it.
 */
export function mergeAbout(
  base: Readonly<Record<string, AboutSession>> | undefined,
  remote: Readonly<Record<string, AboutSession>> | undefined,
  starred: readonly string[],
  here: SessionsHere | undefined,
  now: number,
): Record<string, AboutSession> {
  const out: Record<string, AboutSession> = {};
  for (const id of starred) {
    let said = newer(base?.[id], remote?.[id]);
    const known = here?.of(id);
    if (here && known) {
      const mine: AboutSession = aboutOf(known.title, known.agent, here.host, now);
      if (!said || (said.host === here.host && (said.title !== mine.title || said.agent !== mine.agent))) said = mine;
    }
    if (said) out[id] = said;
  }
  return out;
}

/** Of two words on a session, the later one; for two at one time, the same one on every machine. */
function newer(a: AboutSession | undefined, b: AboutSession | undefined): AboutSession | undefined {
  if (!a || !b) return a ?? b;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/** An `about` entry with its fields in one order and in their limits, so two copies of it read alike. */
function aboutOf(title: string | undefined, agent: string | undefined, host: string | undefined, at: number): AboutSession {
  return {
    ...(title ? { title: title.slice(0, TITLE_MAX) } : {}),
    ...(agent ? { agent: agent.slice(0, AGENT_MAX) } : {}),
    ...(host ? { host: host.slice(0, HOST_MAX) } : {}),
    at,
  };
}

function readAbout(raw: unknown): Record<string, AboutSession> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, AboutSession> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isSyncedId(id) || typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const v = value as Partial<Record<keyof AboutSession, unknown>>;
    if (typeof v.at !== "number" || !Number.isFinite(v.at)) continue;
    const text = (field: unknown, max: number) => (typeof field === "string" && field !== "" && field.length <= max ? field : undefined);
    // A longer title is cut, not left out: the session is still worth naming.
    out[id] = aboutOf(text(v.title, READ_MAX), text(v.agent, AGENT_MAX), text(v.host, HOST_MAX), v.at);
  }
  return out;
}

/**
 * Merges one list three ways, as `mergeState` says. An id this machine put
 * in since the last merge counts as put in now; one taken out, as taken out
 * now. Tombstones older than 90 days go: a machine that comes back with the
 * id after that brings it back.
 */
export function mergeList(base: SyncedList | undefined, local: readonly string[], remote: SyncedList | undefined, now: number, first = base === undefined): SyncedList {
  const removed = new Map<string, number>();
  const added = new Map<string, number>();
  const stamp = (map: Map<string, number>, id: string, at: number) => map.set(id, Math.max(map.get(id) ?? -Infinity, at));
  for (const [id, at] of [...(base?.removed ?? []), ...(remote?.removed ?? [])]) if (now - at < TOMBSTONE_MS) stamp(removed, id, at);
  const here = new Set(local);
  const before = new Map(base?.ids ?? []);
  // Taken out here since the last merge.
  for (const [id] of base?.ids ?? []) if (!here.has(id)) stamp(removed, id, now);
  for (const id of local) stamp(added, id, before.get(id) ?? (first ? 0 : now));
  for (const [id, at] of remote?.ids ?? []) stamp(added, id, at);

  const kept = (id: string) => {
    const at = added.get(id);
    const gone = removed.get(id);
    return at !== undefined && (gone === undefined || at > gone);
  };
  const order: string[] = [];
  const seen = new Set<string>();
  for (const id of [...local, ...(remote?.ids ?? []).map(([id]) => id)]) {
    if (seen.has(id) || !kept(id)) continue;
    seen.add(id);
    order.push(id);
  }
  // A tombstone the id outlived says nothing more.
  for (const id of order) removed.delete(id);
  return { ids: order.map((id) => [id, added.get(id)!]), removed: byId(removed) };
}

/** A session parked and kept at once leaves the list it was put in first, with a tombstone of when it went into the other; parked wins a tie. */
function apart(parked: SyncedList, kept: SyncedList): void {
  const keptAt = new Map(kept.ids);
  const both = parked.ids.filter(([id]) => keptAt.has(id));
  if (both.length === 0) return;
  const leave = (list: SyncedList, id: string, at: number) => {
    list.ids = list.ids.filter(([other]) => other !== id);
    const removed = new Map(list.removed);
    removed.set(id, Math.max(removed.get(id) ?? -Infinity, at));
    list.removed = byId(removed);
  };
  for (const [id, parkedAt] of both) {
    const at = keptAt.get(id)!;
    if (at > parkedAt) leave(parked, id, at);
    else leave(kept, id, parkedAt);
  }
}

/** A single value: this machine's when it changed since the last merge, else the remote copy's, else this machine's. */
function single<T>(base: T | undefined, local: T | undefined, remote: T | undefined, first: boolean): T | undefined {
  if (!first && JSON.stringify(local) !== JSON.stringify(base)) return local;
  return remote ?? local;
}

/** The state of a machine that has merged nothing yet, as a base would hold it. */
function fromLocal(local: LocalState): SyncedState {
  const list = (items: readonly string[]): SyncedList => ({ ids: [...new Set(items)].map((id) => [id, 0]), removed: [] });
  const out: SyncedState = { v: 1, favourites: list(local.favourites), archive: list(local.archive), parked: list(local.parking.parked), kept: list(local.parking.kept), claudeOrgs: local.claudeOrgs };
  if (local.sort !== undefined) out.sort = local.sort;
  if (local.group !== undefined) out.group = local.group;
  return out;
}

/** A state with its fields in one order, so two machines' copies of the same state are the same JSON. */
export function ordered(state: SyncedState): SyncedState {
  const out: SyncedState = { v: 1, favourites: state.favourites, archive: state.archive, parked: state.parked, kept: state.kept, claudeOrgs: sortedOrgs(state.claudeOrgs) };
  if (state.sort !== undefined) out.sort = state.sort;
  if (state.group !== undefined) out.group = state.group;
  if (state.about !== undefined && Object.keys(state.about).length > 0) out.about = Object.fromEntries(Object.entries(state.about).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (state.by !== undefined) out.by = state.by;
  return out;
}

function readList(raw: unknown): SyncedList {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const stamped = (value: unknown): Stamped[] => {
    const out = new Map<string, number>();
    for (const entry of Array.isArray(value) ? value : []) {
      if (!Array.isArray(entry)) continue;
      const [id, at] = entry as unknown[];
      if (!isSyncedId(id) || typeof at !== "number" || !Number.isFinite(at)) continue;
      out.set(id, Math.max(out.get(id) ?? -Infinity, at));
    }
    return [...out];
  };
  return { ids: stamped(record.ids), removed: byId(new Map(stamped(record.removed))) };
}

function ids(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

function readOrgs(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => isSyncedId(entry[0]) && isSyncedId(entry[1])));
}

function sortedOrgs(orgs: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(orgs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function byId(removed: ReadonlyMap<string, number>): Stamped[] {
  return [...removed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
