// What Lookout keeps about a session of its own: the note the user wrote on
// it, and what the session was called and where it worked as last seen, so
// the note still says which session it was once the agent's transcript is
// gone. One small file per session under a directory every window shares,
// written whole and moved into place, so another window never reads half of
// one. A window watches the directory and reads it again when it changes;
// where no watch can be had, the directory's own time says when a file came
// or went.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionRecord {
  v: 1;
  id: string;
  /** Id of the agent provider the session belongs to. */
  agent: string;
  /** Its title, as last seen. */
  title?: string;
  /** Where it worked, as last seen. */
  cwd?: string;
  /** The git branch it last worked on, as last seen. */
  branch?: string;
  /** Epoch ms its transcript was last written, as last seen. */
  modifiedAt?: number;
  /** The user's note on it: one line. */
  note?: string;
  /** Epoch ms the note was written. */
  noteAt?: number;
}

/** What a session was called and where it worked, as the board has it now. */
export interface SessionSeen {
  agent: string;
  title: string;
  cwd: string;
  branch?: string;
  modifiedAt?: number;
}

/** The longest note: one line on a card. */
export const NOTE_MAX = 280;
/** One write is several file events: the listener hears once, this long after the last. */
const WATCH_SETTLE_MS = 100;
/** Without a watch, the directory is looked at this often at most. */
const DIR_CHECK_MS = 1000;

/** A note as the user typed it, trimmed and kept to one line; undefined for nothing to keep. */
export function cleanNote(text: string | undefined): string | undefined {
  const note = (text ?? "").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  return note === "" ? undefined : note;
}

/** The records of the sessions, one file each under `dir`, named after the session id. */
export class SessionRecords {
  private readonly byId = new Map<string, SessionRecord>();
  private loaded = false;
  /** Saves made by this window, for temporary names no other save shares. */
  private saves = 0;
  private watcher: fs.FSWatcher | undefined;
  private settling: ReturnType<typeof setTimeout> | undefined;
  /** The directory's time as last seen, and when, for want of a watch. */
  private dirMtime = -1;
  private checkedAt = -Infinity;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Where a session's record is kept. */
  fileOf(id: string): string {
    return path.join(this.dir, `${crypto.createHash("sha1").update(id).digest("hex")}.json`);
  }

  /** Every record, by session id: read from disk on first use, and again after the directory changed. */
  all(): ReadonlyMap<string, SessionRecord> {
    if (!this.watcher) this.checkDir();
    this.load();
    return this.byId;
  }

  /** Without a watch, the directory's own time tells of files that came or went: looked at once a second at most. */
  private checkDir(): void {
    const now = this.now();
    if (now - this.checkedAt < DIR_CHECK_MS) return;
    this.checkedAt = now;
    let mtime: number;
    try {
      mtime = fs.statSync(this.dir).mtimeMs;
    } catch {
      mtime = -1;
    }
    if (mtime === this.dirMtime) return;
    this.dirMtime = mtime;
    this.loaded = false;
  }

  /** The session's record as the file has it now, not as this window last read it; the map follows. */
  private fresh(id: string): SessionRecord | undefined {
    this.load();
    const record = readRecord(this.fileOf(id));
    if (record) this.byId.set(id, record);
    else this.byId.delete(id);
    return record;
  }

  get(id: string): SessionRecord | undefined {
    return this.all().get(id);
  }

  /** The user's note on the session, when there is one. */
  noteOf(id: string): string | undefined {
    return this.get(id)?.note;
  }

  /** The sessions with a note, newest note first. */
  noted(): SessionRecord[] {
    return [...this.all().values()].filter((record) => record.note !== undefined).sort((a, b) => (b.noteAt ?? 0) - (a.noteAt ?? 0));
  }

  /**
   * Writes the note on a session, with what the session is called and where
   * it works, or takes the note away: a record with nothing left to say is
   * deleted. False when the note could not be written; true otherwise, with
   * nothing to do included.
   */
  setNote(id: string, note: string | undefined, seen: SessionSeen | undefined, now: number = Date.now()): boolean {
    const clean = cleanNote(note);
    // As the file has it: another window may have written since.
    const before = this.fresh(id);
    if (clean === undefined) {
      if (before) this.remove(id);
      return true;
    }
    if (before?.note === clean && (!seen || sameSeen(before, seen))) return true;
    const agent = seen?.agent ?? before?.agent;
    if (!agent) return false;
    const record: SessionRecord = { v: 1, id, agent, ...pick(seen ?? before ?? {}), note: clean, noteAt: before?.note === clean ? (before.noteAt ?? now) : now };
    return this.write(record);
  }

  /**
   * The session was seen on the board: its record follows its title and
   * place. Nothing for a session without a record, nor for one another
   * window removed meanwhile; a time left out, as for a running session
   * whose transcript grows all the time, keeps the one on record.
   */
  observe(id: string, seen: SessionSeen): void {
    const cached = this.get(id);
    if (!cached || sameSeen(cached, seen)) return;
    const current = this.fresh(id);
    if (!current || sameSeen(current, seen)) return;
    this.write({ ...current, ...pick(seen) });
  }

  /** Tells `listener` when the directory changes, as another window writes to it; without a watch, `all` looks at the directory's time instead. */
  watch(listener: () => void): { dispose(): void } {
    this.watcher?.close();
    this.watcher = undefined;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.watcher = fs.watch(this.dir, { persistent: false }, () => {
        this.loaded = false;
        // One write is several events: the listener hears once they settle.
        this.settling ??= setTimeout(() => {
          this.settling = undefined;
          listener();
        }, WATCH_SETTLE_MS);
      });
      this.watcher.on("error", () => {
        this.watcher = undefined;
      });
    } catch {
      // No watch: the directory's time is looked at instead.
    }
    return { dispose: () => this.dispose() };
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.byId.clear();
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = readRecord(path.join(this.dir, name));
      if (record) this.byId.set(record.id, record);
    }
  }

  /** Writes a record; false when it could not be. */
  private write(record: SessionRecord): boolean {
    const target = this.fileOf(record.id);
    const temp = `${target}.${process.pid}.${++this.saves}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(record));
      // Moved into place whole: a window reading it meanwhile sees the old record or the new one.
      fs.renameSync(temp, target);
      this.byId.set(record.id, record);
      return true;
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Nothing to take back.
      }
      return false;
    }
  }

  private remove(id: string): void {
    try {
      fs.rmSync(this.fileOf(id), { force: true });
    } catch {
      // Gone already, or not ours to remove: the next read tells.
    }
    this.byId.delete(id);
  }

  dispose(): void {
    if (this.settling) clearTimeout(this.settling);
    this.settling = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }
}

/** The fields of a record that follow the session, from what was seen. */
function pick(seen: Partial<SessionSeen>): Pick<SessionRecord, "title" | "cwd" | "branch" | "modifiedAt"> {
  const out: Pick<SessionRecord, "title" | "cwd" | "branch" | "modifiedAt"> = {};
  if (seen.title !== undefined) out.title = seen.title;
  if (seen.cwd !== undefined) out.cwd = seen.cwd;
  if (seen.branch !== undefined) out.branch = seen.branch;
  if (seen.modifiedAt !== undefined) out.modifiedAt = seen.modifiedAt;
  return out;
}

function sameSeen(record: SessionRecord, seen: SessionSeen): boolean {
  return record.agent === seen.agent && record.title === seen.title && record.cwd === seen.cwd && record.branch === seen.branch && (seen.modifiedAt === undefined || record.modifiedAt === seen.modifiedAt);
}

/** The record in `file`; none when it is missing, unreadable or not a record. */
function readRecord(file: string): SessionRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const r = raw as Partial<SessionRecord> | null;
  if (!r || r.v !== 1 || typeof r.id !== "string" || r.id === "" || typeof r.agent !== "string" || r.agent === "") return undefined;
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const time = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const record: SessionRecord = { v: 1, id: r.id, agent: r.agent };
  const title = text(r.title);
  if (title !== undefined) record.title = title;
  const cwd = text(r.cwd);
  if (cwd !== undefined) record.cwd = cwd;
  const branch = text(r.branch);
  if (branch !== undefined) record.branch = branch;
  const modifiedAt = time(r.modifiedAt);
  if (modifiedAt !== undefined) record.modifiedAt = modifiedAt;
  const note = cleanNote(text(r.note));
  if (note !== undefined) {
    record.note = note;
    const noteAt = time(r.noteAt);
    if (noteAt !== undefined) record.noteAt = noteAt;
  }
  return record;
}
