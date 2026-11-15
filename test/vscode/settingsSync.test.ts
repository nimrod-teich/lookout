import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionRecords } from "../../src/core/sessionRecords";
import { readSyncedNotes } from "../../src/core/syncedNotes";
import { readSyncedState } from "../../src/core/syncedState";
import { SYNC_LIMIT, syncBytes } from "../../src/core/syncLimit";
import { SYNC_KEYS, SYNC_NOTES_KEY, SYNC_STATE_KEY } from "../../src/core/transfer/types";
import { registerSettingsSync, SettingsSync, SYNC_BASE_KEY, SYNC_CAPPED_KEY, SYNC_SEEN_KEY, SYNC_STATUS_COMMAND } from "../../src/vscode/settingsSync";
import { settle } from "./helpers";
import { stub, StubMemento } from "./stub-vscode";

const SETTING = "lookout.settingsSync.enabled";
const FAVOURITES = "lookout.favourites";
const ARCHIVE = "lookout.archive";
const SEEN = { agent: "claude-code", title: "Wire the cache", cwd: "/work/app" };
const DAY = 24 * 3_600_000;
const WAIT = { timeout: 5_000, interval: 20 };
const S1 = "11111111-1111-4111-8111-111111111111";

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let root: string;
let clock: number;
let open: { dispose(): void }[];

beforeEach(() => {
  stub.reset();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-settings-sync-"));
  clock = 1_000 * DAY;
  open = [];
});

afterEach(() => {
  for (const one of open) one.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

type State = Record<string, unknown>;

/** What Settings Sync keeps in the cloud of Lookout's state: the merged keys of the machine that sent it last. */
interface Cloud {
  state: State | undefined;
}

/** A machine: its globalState, its notes' files, a Lookout window, and what Settings Sync last synced of Lookout here. */
class Machine {
  readonly memento = new StubMemento();
  readonly recordsDir: string;
  readonly sync: SettingsSync;
  /** This machine's `lookout.settingsSync.enabled`. */
  enabled = true;
  /** Settings Sync's copy of Lookout's state as this machine last synced it. */
  lastSync: State | undefined;
  /** Times the window was told a merge changed Lookout's keys or the notes. */
  changes = 0;
  /** What the window wrote to Lookout's log. */
  readonly logged: string[] = [];

  /** `here`: the sessions on this machine, by id, with their titles. */
  constructor(
    readonly name: string,
    readonly here: Record<string, string> = {},
  ) {
    this.recordsDir = path.join(root, name, "global-storage", "sessions");
    this.sync = new SettingsSync(this.memento, {
      recordsDir: this.recordsDir,
      now: () => clock,
      changed: () => this.changes++,
      host: name,
      describe: (id) => (id in this.here ? { title: this.here[id], agent: "claude-code" } : undefined),
      log: { info: (line) => this.logged.push(line), errorOnce: () => {} },
    });
    open.push(this.sync);
  }

  /** The window merges, with this machine's setting. */
  merge(): void {
    stub.config[SETTING] = this.enabled;
    this.sync.merge();
  }

  /** The notes as the window writes them. */
  get notes(): SessionRecords {
    return this.sync.records;
  }

  /** A session's notes as the files have them. */
  texts(id: string): string[] {
    return new SessionRecords(this.recordsDir).notesOf(id).map((note) => note.text);
  }

  list(key: string): string[] {
    return (this.memento.get<string[]>(key) ?? []).slice();
  }

  /** The board stars a session, newest first. */
  star(id: string): void {
    this.memento.values.set(FAVOURITES, [id, ...this.list(FAVOURITES).filter((other) => other !== id)]);
  }

  unstar(id: string): void {
    this.memento.values.set(FAVOURITES, this.list(FAVOURITES).filter((other) => other !== id));
  }

  /** The two synced values in this machine's globalState. */
  synced(): [unknown, unknown] {
    return [this.memento.get(SYNC_STATE_KEY), this.memento.get(SYNC_NOTES_KEY)];
  }
}

/**
 * VS Code's merge of one extension's synced state, for two machines on the
 * same version of it: this machine's keys, with the cloud's where the
 * cloud's changed since this machine last synced, a key both changed taking
 * the cloud's copy whole, and a key the cloud lost going unless this
 * machine changed it.
 */
function mergeExtensionState(local: State | undefined, remote: State | undefined, base: State | undefined): State | undefined {
  if (!local) return remote;
  if (!remote) return local;
  const merged = clone(local);
  const diff = (from: State | undefined, to: State) => ({
    added: Object.keys(to).filter((key) => !from || !(key in from)),
    removed: from ? Object.keys(from).filter((key) => !(key in to)) : [],
    updated: from ? Object.keys(from).filter((key) => key in to && !same(from[key], to[key])) : [],
  });
  const toRemote = diff(base, remote);
  const toLocal = diff(base, local);
  for (const key of [...toRemote.added, ...toRemote.updated]) merged[key] = clone(remote[key]);
  for (const key of toRemote.removed) if (!toLocal.updated.includes(key)) delete merged[key];
  return merged;
}

/**
 * Settings Sync's Extensions step for Lookout on one machine, as VS Code
 * runs it. The machine sends only the keys it gave `setKeysForSync`, and no
 * state at all when it never gave any. The merge is written back only under
 * the keys the machine gave, a key missing from it removed; or under every
 * key it holds when the machine gave none.
 */
function settingsSync(machine: Machine, cloud: Cloud): void {
  const keys = machine.memento.keysForSync;
  const local = keys === undefined ? undefined : Object.fromEntries(keys.filter((key) => machine.memento.get(key) !== undefined).map((key) => [key, clone(machine.memento.get(key))]));
  const merged = mergeExtensionState(local, cloud.state, machine.lastSync);
  if (merged === undefined) return;
  if (!same(merged, local)) {
    for (const key of keys ?? Object.keys(merged)) {
      if (merged[key] === undefined) machine.memento.values.delete(key);
      else machine.memento.values.set(key, clone(merged[key]));
    }
  }
  if (!same(merged, cloud.state)) cloud.state = clone(merged);
  machine.lastSync = clone(merged);
}

/** Each machine merges and then syncs, in turn, a few rounds over, and merges what the last round brought: enough for every change to reach every machine. */
function converge(cloud: Cloud, machines: Machine[], rounds = 3): void {
  for (let round = 0; round < rounds; round++) {
    for (const machine of machines) {
      clock += 1000;
      machine.merge();
      settingsSync(machine, cloud);
    }
  }
  for (const machine of machines) machine.merge();
}

const ops = (action: string) => stub.ops.filter(([target, op]) => target === "globalState" && op === action);
const warnings = () => stub.ops.filter(([target, kind]) => target === "window" && kind === "warning").map(([, , message]) => message as string);

describe("Settings Sync between two machines", () => {
  let cloud: Cloud;
  let a: Machine;
  let b: Machine;

  beforeEach(() => {
    cloud = { state: undefined };
    a = new Machine("a");
    b = new Machine("b");
  });

  it("gives Settings Sync its two keys and never Lookout's own, so the cloud holds only those", () => {
    a.star("x");
    a.notes.addNote(S1, "has the retag recipe", SEEN, clock);
    a.merge();
    expect(a.memento.keysForSync).toEqual([...SYNC_KEYS]);
    settingsSync(a, cloud);
    expect(Object.keys(cloud.state ?? {}).sort()).toEqual([...SYNC_KEYS].sort());
    expect(readSyncedState(cloud.state?.[SYNC_STATE_KEY])?.favourites.ids.map(([id]) => id)).toEqual(["x"]);
    // Merged again with nothing new: nothing written, and the same keys.
    stub.ops.length = 0;
    a.merge();
    expect(ops("update")).toEqual([]);
    expect(ops("setKeysForSync")).toEqual([]);
  });

  it("brings a note on a session the other machine never noted, and it stays", () => {
    converge(cloud, [b]);
    a.notes.addNote(S1, "has the retag recipe", SEEN, clock);
    a.merge();
    // A's first sync gives it the cloud's copy whole; its window merges the note back in, and the next sync sends it.
    settingsSync(a, cloud);
    expect(readSyncedNotes(cloud.state?.[SYNC_NOTES_KEY])?.has(S1)).toBe(false);
    a.merge();
    settingsSync(a, cloud);
    expect(readSyncedNotes(cloud.state?.[SYNC_NOTES_KEY])?.has(S1)).toBe(true);
    settingsSync(b, cloud);
    b.merge();
    expect(b.texts(S1)).toEqual(["has the retag recipe"]);
    expect(new SessionRecords(b.recordsDir).get(S1)).toMatchObject({ agent: "claude-code", title: "Wire the cache" });
    converge(cloud, [a, b]);
    expect(b.texts(S1)).toEqual(["has the retag recipe"]);
    expect(a.texts(S1)).toEqual(["has the retag recipe"]);
    expect(b.changes).toBeGreaterThan(0);
  });

  it("keeps both stars when each machine starred a session before they synced", () => {
    converge(cloud, [a, b]);
    a.star("x");
    b.star("y");
    a.merge();
    b.merge();
    settingsSync(a, cloud);
    settingsSync(b, cloud);
    // Both changed the key: Settings Sync gave B the cloud's copy whole, without B's star.
    expect(b.synced()[0]).toEqual(a.synced()[0]);
    expect(b.list(FAVOURITES)).toEqual(["y"]);
    converge(cloud, [b, a]);
    // Each machine keeps its own order, with the other's star after.
    expect(a.list(FAVOURITES)).toEqual(["x", "y"]);
    expect(b.list(FAVOURITES)).toEqual(["y", "x"]);
  });

  it("keeps a session unstarred on one machine unstarred on both, while the other stars another", () => {
    a.star("x");
    converge(cloud, [a, b]);
    expect(b.list(FAVOURITES)).toEqual(["x"]);
    a.unstar("x");
    b.star("y");
    a.merge();
    b.merge();
    settingsSync(a, cloud);
    settingsSync(b, cloud);
    converge(cloud, [b, a]);
    expect(a.list(FAVOURITES)).toEqual(["y"]);
    expect(b.list(FAVOURITES)).toEqual(["y"]);
    // A month on, synced again and again, it stays out.
    clock += 30 * DAY;
    converge(cloud, [a, b]);
    expect(a.list(FAVOURITES)).toEqual(["y"]);
    expect(b.list(FAVOURITES)).toEqual(["y"]);
  });

  it("keeps a deleted note deleted, while an edit made meanwhile on the other machine still arrives", () => {
    const keep = a.notes.addNote(S1, "keep", SEEN, clock)!;
    const drop = a.notes.addNote(S1, "drop", SEEN, clock + 1)!;
    converge(cloud, [a, b]);
    expect(b.texts(S1)).toEqual(["keep", "drop"]);
    clock += 1000;
    b.notes.removeNote(S1, drop.id);
    a.notes.editNote(S1, keep.id, "kept, and edited", clock);
    a.merge();
    b.merge();
    // Both changed the notes' key: B syncs first, and A gets B's copy whole.
    settingsSync(b, cloud);
    settingsSync(a, cloud);
    converge(cloud, [a, b]);
    expect(a.texts(S1)).toEqual(["kept, and edited"]);
    expect(b.texts(S1)).toEqual(["kept, and edited"]);
    clock += 30 * DAY;
    converge(cloud, [b, a]);
    expect(a.texts(S1)).toEqual(["kept, and edited"]);
    expect(b.texts(S1)).toEqual(["kept, and edited"]);
  });

  it("holds the synced copies under 64 KB with a huge archive, deleting nothing anywhere, and says so once", () => {
    const mine = Array.from({ length: 3000 }, (_, i) => sid(i));
    a.memento.values.set(ARCHIVE, mine);
    b.memento.values.set(ARCHIVE, [sid(90_000), sid(90_001)]);
    b.notes.addNote(S1, "noted on B", SEEN, clock);
    converge(cloud, [a, b]);
    for (const machine of [a, b]) expect(syncBytes(...machine.synced())).toBeLessThanOrEqual(SYNC_LIMIT);
    expect(syncBytes(cloud.state?.[SYNC_STATE_KEY], cloud.state?.[SYNC_NOTES_KEY])).toBeLessThanOrEqual(SYNC_LIMIT);
    // A keeps every session it archived, and gains B's.
    expect(a.list(ARCHIVE)).toEqual([...mine, sid(90_000), sid(90_001)]);
    // B keeps its own and gains A's newest, as many as the copy holds.
    const onB = b.list(ARCHIVE);
    expect(onB.slice(0, 2)).toEqual([sid(90_000), sid(90_001)]);
    expect(onB.length).toBeGreaterThan(500);
    expect(onB.slice(2)).toEqual(mine.slice(0, onB.length - 2));
    expect(a.texts(S1)).toEqual(["noted on B"]);
    // Each machine says it once.
    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toMatch(/^Lookout: the \d+ oldest archived sessions no longer sync to your other machines, as Settings Sync keeps Lookout's data under 64 KB\. They stay on this machine, and a backup carries them\.$/);
    expect(a.memento.get(SYNC_CAPPED_KEY)).toBe(true);
  });

  it("with the setting off on a machine that never had it on, gives Settings Sync no keys and keeps no synced copy", () => {
    a.star("x");
    a.notes.addNote(S1, "from A", SEEN, clock);
    converge(cloud, [a]);
    b.enabled = false;
    b.star("mine");
    converge(cloud, [b]);
    expect(b.memento.keysForSync).toBeUndefined();
    // Settings Sync writes every key of a machine that gave none; the window takes them out again.
    settingsSync(b, cloud);
    expect(b.memento.get(SYNC_STATE_KEY)).toBeDefined();
    b.merge();
    expect(b.synced()).toEqual([undefined, undefined]);
    // Nothing of A's came into B's own keys or notes, and nothing of B's went out.
    expect(b.list(FAVOURITES)).toEqual(["mine"]);
    expect(b.texts(S1)).toEqual([]);
    expect(readSyncedState(cloud.state?.[SYNC_STATE_KEY])?.favourites.ids.map(([id]) => id)).toEqual(["x"]);
  });

  it("with the setting turned off, takes its keys back and its synced copies out, and the other machine loses nothing", () => {
    a.star("x");
    b.star("y");
    a.notes.addNote(S1, "from A", SEEN, clock);
    converge(cloud, [a, b]);
    expect(b.list(FAVOURITES)).toEqual(["y", "x"]);
    b.enabled = false;
    b.merge();
    expect(b.memento.keysForSync).toEqual([]);
    expect(b.synced()).toEqual([undefined, undefined]);
    // B sends an empty state, which takes the synced keys out of the cloud, and through it out of A's globalState where A did not change them since.
    settingsSync(b, cloud);
    expect(cloud.state).toEqual({});
    settingsSync(a, cloud);
    b.star("z");
    converge(cloud, [a, b]);
    expect(a.list(FAVOURITES)).toEqual(["x", "y"]);
    expect(a.texts(S1)).toEqual(["from A"]);
    expect(b.list(FAVOURITES)).toEqual(["z", "y", "x"]);
    expect(b.synced()).toEqual([undefined, undefined]);
    expect(b.memento.keysForSync).toEqual([]);
  });

  it("never loses a machine's state or notes to synced values that do not read, and writes its own over them", () => {
    b.star("mine");
    b.notes.addNote(S1, "mine", SEEN, clock);
    converge(cloud, [b]);
    for (const garbage of ["oops", 42, null, [1, 2], { v: 1, sessions: "x" }, { v: 1, favourites: "x" }]) {
      cloud.state = { [SYNC_STATE_KEY]: garbage, [SYNC_NOTES_KEY]: garbage };
      settingsSync(b, cloud);
      b.merge();
      expect(b.list(FAVOURITES)).toEqual(["mine"]);
      expect(b.texts(S1)).toEqual(["mine"]);
      expect(readSyncedState(b.memento.get(SYNC_STATE_KEY))?.favourites.ids.map(([id]) => id)).toEqual(["mine"]);
    }
  });

  it("keeps the light state's base with the state, so a window writing back older values takes nothing out", () => {
    a.star("x");
    b.star("y");
    converge(cloud, [b, a]);
    expect(a.list(FAVOURITES)).toEqual(["x", "y"]);
    // B stars another; A's merge takes it in, and then another window of A, which had not heard of that merge, writes its older copy of globalState whole.
    b.star("w");
    converge(cloud, [b], 1);
    settingsSync(a, cloud);
    const older = new Map(a.memento.values);
    a.merge();
    expect(a.list(FAVOURITES)).toEqual(["x", "y", "w"]);
    a.memento.values.clear();
    for (const [key, value] of older) a.memento.values.set(key, value);
    converge(cloud, [a, b]);
    expect(a.list(FAVOURITES)).toEqual(["x", "y", "w"]);
    expect(b.list(FAVOURITES)).toEqual(["w", "y", "x"]);
    expect(readSyncedState(a.memento.get(SYNC_BASE_KEY))?.favourites.removed).toEqual([]);
  });

  it("carries a starred session's title and machine to a machine that does not have it", () => {
    const laptop = new Machine("laptop", { [S1]: "Wire the cache" });
    laptop.star(S1);
    converge(cloud, [laptop, b]);
    expect(readSyncedState(b.memento.get(SYNC_STATE_KEY))?.about?.[S1]).toMatchObject({ title: "Wire the cache", agent: "claude-code", host: "laptop" });
    expect(readSyncedState(b.memento.get(SYNC_BASE_KEY))?.about?.[S1]).toMatchObject({ title: "Wire the cache", host: "laptop" });
    expect(b.list(FAVOURITES)).toEqual([S1]);
  });

  it("carries the machine a noted session is on with its notes", () => {
    const laptop = new Machine("laptop", { [S1]: "Wire the cache" });
    laptop.notes.addNote(S1, "has the retag recipe", SEEN, clock);
    converge(cloud, [laptop, b]);
    expect(readSyncedNotes(b.memento.get(SYNC_NOTES_KEY))?.get(S1)?.host).toBe("laptop");
  });

  it("names the machine that last changed each copy, and two machines that agree leave the name alone", () => {
    a.star("x");
    converge(cloud, [a, b]);
    expect((cloud.state?.[SYNC_STATE_KEY] as { by?: string }).by).toBe("a");
    b.star("y");
    b.merge();
    settingsSync(b, cloud);
    expect((cloud.state?.[SYNC_STATE_KEY] as { by?: string }).by).toBe("b");
    // Once they agree, neither machine writes either copy again, and the name stays whoever changed it last.
    converge(cloud, [a, b]);
    const last = (cloud.state?.[SYNC_STATE_KEY] as { by?: string }).by;
    stub.ops.length = 0;
    converge(cloud, [a, b]);
    expect(ops("update").filter(([, , args]) => SYNC_KEYS.includes((args as unknown[])[0] as string))).toEqual([]);
    expect((cloud.state?.[SYNC_STATE_KEY] as { by?: string }).by).toBe(last);
  });

  it("says in Lookout's log when another machine's copy arrives, with what it brought, and not for its own", () => {
    a.star("x");
    a.star("y");
    a.notes.addNote(S1, "has the retag recipe", SEEN, clock);
    a.merge();
    settingsSync(a, cloud);
    a.merge();
    expect(a.logged).toEqual([]);
    settingsSync(b, cloud);
    b.merge();
    expect(b.logged).toEqual(["Settings Sync brought a's copy of the stars and lists: 2 stars.", "Settings Sync brought a's copy of the notes: 1 note on 1 session."]);
    expect(b.sync.status().arrived).toEqual({ state: { at: clock, by: "a", stars: 2 }, notes: { at: clock, by: "a", notes: 1, sessions: 1 } });
    // The same copy merged again: nothing more said.
    b.merge();
    expect(b.logged).toHaveLength(2);
    // b's own copy goes back to a: a hears of it, b does not hear of its own.
    b.star("z");
    b.merge();
    settingsSync(b, cloud);
    settingsSync(a, cloud);
    a.merge();
    expect(a.logged).toEqual(["Settings Sync brought b's copy of the stars and lists: 3 stars."]);
    b.merge();
    expect(b.logged).toHaveLength(2);
  });

  it("does not take a copy another window of this machine wrote for another machine's", () => {
    const second = new SettingsSync(a.memento, { recordsDir: a.recordsDir, now: () => clock, host: "a", log: { info: (line) => a.logged.push(line), errorOnce: () => {} } });
    open.push(second);
    a.star("x");
    stub.config[SETTING] = true;
    second.merge();
    a.merge();
    // The other window writes a new copy; what it saw reaches this window later than the copy does.
    a.star("y");
    const seenBefore = clone(a.memento.get(SYNC_SEEN_KEY));
    second.merge();
    a.memento.values.set(SYNC_SEEN_KEY, seenBefore);
    a.merge();
    expect(a.logged).toEqual([]);
  });

  it("does not take this machine's own copy from before the copies named their machine for another machine's", () => {
    // As Lookout 0.1.6 left it: a synced copy with no name, and nothing seen.
    a.memento.values.set(SYNC_STATE_KEY, { v: 1, favourites: { ids: [["x", 0]], removed: [] }, archive: { ids: [], removed: [] }, parked: { ids: [], removed: [] }, kept: { ids: [], removed: [] }, claudeOrgs: {} });
    a.star("x");
    a.merge();
    expect(a.logged).toEqual([]);
    expect(a.sync.status().arrived).toEqual({});
    expect(a.memento.get(SYNC_SEEN_KEY)).toMatchObject({ state: expect.any(String), notes: expect.any(String) });
  });

  it("tells what it syncs, what came from another machine, and what is not on this machine, and opens VS Code's own Settings Sync log", async () => {
    a.star("x");
    a.notes.addNote(S1, "has the retag recipe", SEEN, clock);
    converge(cloud, [a, b]);
    expect(b.sync.status()).toMatchObject({ enabled: true, mergedAt: clock, stars: 1, notes: 1, sessions: 1 });
    stub.config[SETTING] = true;
    open.push(registerSettingsSync({ globalState: b.memento } as never, { recordsDir: b.recordsDir, now: () => clock, host: "b", elsewhere: () => ({ sessions: 2, stars: 1, notes: 1 }), version: "0.1.7" }));
    stub.commands.set("workbench.userDataSync.actions.showLog", () => undefined);
    stub.notificationAnswer = "Show Settings Sync Log";
    stub.notices.length = 0;
    await stub.commands.get(SYNC_STATUS_COMMAND)!();
    const notice = stub.notices.at(-1)!;
    expect(notice).toMatchObject({ modal: true, message: "Lookout's Settings Sync", actions: ["Sync Now", "Show Settings Sync Log", "Restore from Backup…"] });
    expect(notice.detail).toContain("came from a on");
    expect(notice.detail).toContain("This machine syncs 1 star, 0 archived sessions, 0 parked sessions and 1 note on 1 session.");
    expect(notice.detail).toContain("2 starred or noted sessions (1 star, 1 note) are of conversations that are not on this machine");
    // Machines on different versions of Lookout exchange nothing: the status says which this one runs.
    expect(notice.detail).toContain("only on a machine that runs the same version of Lookout as the one that sent it: this one runs 0.1.7.");
    await settle();
    expect(stub.ops).toContainEqual(["commands", "workbench.userDataSync.actions.showLog", []]);
    // In a remote window: says that Settings Sync carries Lookout's data only where it is installed in VS Code itself.
    const vscodeEnv = (await import("./stub-vscode")).env;
    vscodeEnv.remoteName = "wsl";
    stub.notificationAnswer = undefined;
    await stub.commands.get(SYNC_STATUS_COMMAND)!();
    vscodeEnv.remoteName = undefined;
    expect(stub.notices.at(-1)!.detail).toContain("This window's Lookout runs in wsl. Settings Sync carries Lookout's data only where Lookout is also installed in VS Code itself");
    // Off: says so, and offers only the restore.
    stub.config[SETTING] = false;
    await stub.commands.get(SYNC_STATUS_COMMAND)!();
    expect(stub.notices.at(-1)).toMatchObject({ actions: ["Restore from Backup…"] });
    expect(stub.notices.at(-1)!.detail).toContain("lookout.settingsSync.enabled is off");
    expect(stub.notices.at(-1)!.detail).not.toContain("same version");
  });
});

describe("SettingsSync in one machine", () => {
  it("says once when the synced copies leave notes out, again only after they all fit, and offers a backup", () => {
    const a = new Machine("a");
    // Twelve sessions with one long note each, the first noted first.
    for (let i = 0; i < 12; i++) a.notes.addNote(`s${i}`, `${i} `.padEnd(8000, "x"), SEEN, clock + i);
    clock += 1000;
    a.merge();
    const synced = Object.keys((a.memento.get<{ sessions: object }>(SYNC_NOTES_KEY) ?? { sessions: {} }).sessions);
    expect(synced.length).toBeGreaterThan(0);
    expect(synced.length).toBeLessThan(12);
    const left = 12 - synced.length;
    expect(warnings()).toEqual([`Lookout: ${left} notes on ${left} older sessions no longer sync to your other machines, as Settings Sync keeps Lookout's data under 64 KB. They stay on this machine, and a backup carries them.`]);
    // The notes stay here.
    expect(a.texts("s0")).toHaveLength(1);
    a.merge();
    expect(warnings()).toHaveLength(1);
    for (let i = 6; i < 12; i++) a.notes.removeNotes(`s${i}`);
    clock += 1000;
    a.merge();
    expect(a.memento.get(SYNC_CAPPED_KEY)).toBeUndefined();
    stub.notificationAnswer = "Back Up…";
    const backUps: unknown[] = [];
    stub.commands.set("lookout.backUp", () => backUps.push("ran"));
    for (let i = 20; i < 26; i++) a.notes.addNote(`s${i}`, `${i} `.padEnd(8000, "y"), SEEN, clock + i);
    clock += 1000;
    a.merge();
    expect(warnings()).toHaveLength(2);
    return settle().then(() => expect(backUps).toEqual(["ran"]));
  });

  it("never takes away a note another window wrote and merged while this window's view of the records was older", () => {
    const a = new Machine("a");
    a.notes.addNote("s1", "first", SEEN, clock);
    clock += 1000;
    a.merge();
    // Another window adds a note and merges it before this window's view of the records catches up.
    const other = new SettingsSync(a.memento, { recordsDir: a.recordsDir, now: () => clock });
    open.push(other);
    other.records.addNote("s1", "from the other window", SEEN, clock);
    other.merge();
    clock += 1000;
    a.merge();
    expect(a.texts("s1")).toEqual(["first", "from the other window"]);
    const synced = a.memento.get<{ sessions: Record<string, { notes: { text: string }[]; removed: unknown[] }> }>(SYNC_NOTES_KEY)!.sessions.s1!;
    expect(synced.notes.map((note) => note.text)).toEqual(["first", "from the other window"]);
    expect(synced.removed).toEqual([]);
  });

  it("settles two windows on the same values, which neither writes again", async () => {
    const cloud: Cloud = { state: undefined };
    const other = new Machine("other");
    other.notes.addNote(S1, "from the laptop", SEEN, clock);
    other.star("x");
    converge(cloud, [other]);
    const a = new Machine("a");
    a.notes.addNote("s2", "here", SEEN, clock);
    settingsSync(a, cloud);
    const second = new SettingsSync(a.memento, { recordsDir: a.recordsDir, now: () => clock });
    second.records.watch(() => {});
    open.push(second);
    const both = () => {
      a.merge();
      second.merge();
    };
    both();
    await expect
      .poll(() => {
        both();
        stub.ops.length = 0;
        const base = fs.readFileSync(path.join(root, "a", "global-storage", "notes-sync.json"), "utf8");
        both();
        return ops("update").length === 0 && fs.readFileSync(path.join(root, "a", "global-storage", "notes-sync.json"), "utf8") === base;
      }, WAIT)
      .toBe(true);
    expect(a.texts(S1)).toEqual(["from the laptop"]);
    expect(a.texts("s2")).toEqual(["here"]);
    expect(a.list(FAVOURITES)).toEqual(["x"]);
  });
});

describe("registerSettingsSync", () => {
  let cloud: Cloud;
  let laptop: Machine;
  let here: Machine;

  beforeEach(() => {
    cloud = { state: undefined };
    laptop = new Machine("laptop");
    laptop.notes.addNote(S1, "from the laptop", SEEN, clock);
    here = new Machine("here");
  });

  function register(mergeEveryMs = 60_000) {
    const disposable = registerSettingsSync({ globalState: here.memento } as never, { recordsDir: here.recordsDir, mergeEveryMs, now: () => clock });
    open.push(disposable);
    return disposable;
  }

  /** The laptop's notes reach this machine's globalState through Settings Sync. */
  function pull(): void {
    converge(cloud, [laptop], 1);
    settingsSync(here, cloud);
  }

  it("syncs with the setting left as it comes", () => {
    here.notes.addNote("s2", "here", SEEN, clock);
    register();
    expect(here.memento.keysForSync).toEqual([...SYNC_KEYS]);
    expect(Object.keys((here.memento.get<{ sessions: object }>(SYNC_NOTES_KEY) ?? { sessions: {} }).sessions)).toEqual(["s2"]);
  });

  it("with the setting off, gives Settings Sync no keys and merges nothing", () => {
    stub.config[SETTING] = false;
    here.notes.addNote("s2", "here", SEEN, clock);
    register();
    expect(here.memento.keysForSync).toBeUndefined();
    expect(here.synced()).toEqual([undefined, undefined]);
  });

  it("merges when the window opens with the setting on", () => {
    stub.config[SETTING] = true;
    here.notes.addNote("s2", "here", SEEN, clock);
    register();
    expect(here.memento.keysForSync).toEqual([...SYNC_KEYS]);
    expect(Object.keys((here.memento.get<{ sessions: object }>(SYNC_NOTES_KEY) ?? { sessions: {} }).sessions)).toEqual(["s2"]);
  });

  it("merges when the setting turns on, and takes the keys back when it turns off", () => {
    register();
    const toggle = (on: boolean) => {
      stub.config[SETTING] = on;
      stub.configChange.fire({ affectsConfiguration: (section) => section === SETTING || section === "lookout" });
    };
    toggle(true);
    expect(here.memento.keysForSync).toEqual([...SYNC_KEYS]);
    pull();
    toggle(true);
    expect(here.texts(S1)).toEqual(["from the laptop"]);
    toggle(false);
    expect(here.memento.keysForSync).toEqual([]);
    expect(here.synced()).toEqual([undefined, undefined]);
    // Its notes stay.
    expect(here.texts(S1)).toEqual(["from the laptop"]);
  });

  it("merges what Settings Sync pulled when the window comes to the front", () => {
    stub.config[SETTING] = true;
    stub.focused = false;
    register();
    pull();
    stub.focusChange.fire();
    expect(here.texts(S1)).toEqual([]);
    stub.focused = true;
    stub.focusChange.fire();
    expect(here.texts(S1)).toEqual(["from the laptop"]);
  });

  it("puts a note another window wrote into the synced copy while the window is in front", async () => {
    stub.config[SETTING] = true;
    register();
    new SessionRecords(here.recordsDir).addNote("s2", "written in another window", SEEN, clock);
    await expect.poll(() => Object.keys((here.memento.get<{ sessions: object }>(SYNC_NOTES_KEY) ?? { sessions: {} }).sessions), WAIT).toEqual(["s2"]);
  });

  it("merges again on a timer while the window is in front, and not while it is behind", async () => {
    stub.config[SETTING] = true;
    stub.focused = false;
    register(40);
    pull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(here.texts(S1)).toEqual([]);
    // In front without a focus event: the timer finds it.
    stub.focused = true;
    await expect.poll(() => here.texts(S1), WAIT).toEqual(["from the laptop"]);
  });

  it("stops merging once disposed", async () => {
    stub.config[SETTING] = true;
    const disposable = register(40);
    disposable.dispose();
    pull();
    stub.focusChange.fire();
    stub.configChange.fire({ affectsConfiguration: () => true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(here.texts(S1)).toEqual([]);
  });
});
