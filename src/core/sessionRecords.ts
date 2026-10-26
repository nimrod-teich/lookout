// What Lookout keeps about a session of its own: the notes the user wrote
// on it, each with its time, and what the session was called and where it
// worked as last seen, so the notes still say which session it was once
// the agent's transcript is gone. One small file per session under a
// directory every window shares, written whole and moved into place, so
// another window never reads half of one. A window watches the directory
// and reads it again when it changes; where no watch can be had, the
// files' names, sizes and times are looked at once a second instead.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** One note in a session's thread. */
export interface NoteEntry {
  /** Its own id, for a change or a removal. */
  id: string;
  text: string;
  /** Epoch ms it was written. */
  at: number;
  /** Epoch ms it was last changed, when it was. */
  editedAt?: number;
}

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
  /** The user's notes on it, oldest first; a record with none is deleted. */
  notes?: NoteEntry[];
}

/** What a session was called and where it worked, as the board has it now. */
export interface SessionSeen {
  agent: string;
  title: string;
  cwd: string;
  branch?: string;
  modifiedAt?: number;
}

/** The longest note. */
export const NOTE_MAX = 8000;
/** One write is several file events: the listener hears once, this long after the last. */
const WATCH_SETTLE_MS = 100;
/** Without a watch, the directory is looked at this often at most. */
const DIR_CHECK_MS = 1000;

/** A note as the user typed it: one kind of line end, no blanks at a line's end nor blank lines at either end, cut to the longest; undefined for nothing to keep. */
export function cleanNote(text: string | undefined): string | undefined {
  const note = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim()
    .slice(0, NOTE_MAX);
  return note === "" ? undefined : note;
}

/** The newest note of a record, when it has any. */
export function latestNote(record: SessionRecord | undefined): NoteEntry | undefined {
  return record?.notes?.at(-1);
}

/** The records of the sessions, one file each under `dir`, named after the session id. */
export class SessionRecords {
  private readonly byId = new Map<string, SessionRecord>();
  private loaded = false;
  /** Saves made by this window, for temporary names no other save shares. */
  private saves = 0;
  private watcher: fs.FSWatcher | undefined;
  private settling: ReturnType<typeof setTimeout> | undefined;
  /** The files as last seen (names, sizes, times), and when, for want of a watch. */
  private listing = "";
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

  /**
   * Without a watch, the files themselves tell of one that came, went or
   * changed: their names, sizes and times, looked at once a second at most.
   * (A directory's own time would be cheaper, but Windows reports it late.)
   */
  private checkDir(): void {
    const now = this.now();
    if (now - this.checkedAt < DIR_CHECK_MS) return;
    this.checkedAt = now;
    const parts: string[] = [];
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const st = fs.statSync(path.join(this.dir, name));
          parts.push(`${name}:${st.size}:${st.mtimeMs}`);
        } catch {
          // Gone meanwhile.
        }
      }
    } catch {
      // No directory yet.
    }
    const listing = parts.sort().join("\n");
    if (listing === this.listing) return;
    this.listing = listing;
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

  /** The user's notes on the session, oldest first; none for a session without. */
  notesOf(id: string): NoteEntry[] {
    return this.get(id)?.notes ?? [];
  }

  /** The sessions with notes, newest note first. */
  noted(): SessionRecord[] {
    return [...this.all().values()].filter((record) => (record.notes?.length ?? 0) > 0).sort((a, b) => (latestNote(b)?.at ?? 0) - (latestNote(a)?.at ?? 0));
  }

  /**
   * Adds a note to a session, with what the session is called and where it
   * works. The note added, or nothing when there was nothing to add or it
   * could not be written: a blank note, or a session nothing is known about.
   */
  addNote(id: string, text: string | undefined, seen: SessionSeen | undefined, now: number = Date.now()): NoteEntry | undefined {
    const clean = cleanNote(text);
    if (clean === undefined) return undefined;
    // As the file has it: another window may have written since.
    const before = this.fresh(id);
    const agent = seen?.agent ?? before?.agent;
    if (!agent) return undefined;
    const entry: NoteEntry = { id: newId(before?.notes ?? []), text: clean, at: now };
    const record: SessionRecord = { v: 1, id, agent, ...pick(seen ?? before ?? {}), notes: [...(before?.notes ?? []), entry] };
    return this.write(record) ? entry : undefined;
  }

  /**
   * Changes one note; a blank text takes it away. False when the session or
   * the note is not on record, or the record could not be written.
   */
  editNote(id: string, noteId: string, text: string | undefined, now: number = Date.now()): boolean {
    const clean = cleanNote(text);
    if (clean === undefined) return this.removeNote(id, noteId);
    const before = this.fresh(id);
    const entry = before?.notes?.find((note) => note.id === noteId);
    if (!before || !entry) return false;
    if (entry.text === clean) return true;
    const notes = before.notes!.map((note) => (note.id === noteId ? { ...note, text: clean, editedAt: now } : note));
    return this.write({ ...before, notes });
  }

  /** Takes one note away; the record goes with the last. False when the session or the note is not on record. */
  removeNote(id: string, noteId: string): boolean {
    const before = this.fresh(id);
    if (!before?.notes?.some((note) => note.id === noteId)) return false;
    const notes = before.notes.filter((note) => note.id !== noteId);
    if (notes.length === 0) {
      this.remove(id);
      return true;
    }
    return this.write({ ...before, notes });
  }

  /** Takes every note on a session away, and the record with them. True with nothing to do included. */
  removeNotes(id: string): boolean {
    if (this.fresh(id)) this.remove(id);
    return true;
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

  /** Tells `listener` when the directory changes, as another window writes to it; without a watch, `all` looks at the files instead. */
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
      // No watch: the files are looked at instead.
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

/** An id no note of the thread has. */
function newId(notes: readonly NoteEntry[]): string {
  for (;;) {
    const id = crypto.randomBytes(4).toString("hex");
    if (!notes.some((note) => note.id === id)) return id;
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
  const r = raw as (Partial<SessionRecord> & { note?: unknown; noteAt?: unknown }) | null;
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
  const notes: NoteEntry[] = [];
  for (const raw of Array.isArray(r.notes) ? r.notes : []) {
    const n = raw as Partial<NoteEntry> | null;
    const id = text(n?.id);
    const body = cleanNote(text(n?.text));
    const at = time(n?.at);
    if (id === undefined || id === "" || body === undefined || at === undefined) continue;
    const entry: NoteEntry = { id, text: body, at };
    const editedAt = time(n?.editedAt);
    if (editedAt !== undefined) entry.editedAt = editedAt;
    notes.push(entry);
  }
  // A record from before the thread: its one note, with its time.
  const single = cleanNote(text(r.note));
  if (notes.length === 0 && single !== undefined) notes.push({ id: "first", text: single, at: time(r.noteAt) ?? 0 });
  if (notes.length > 0) record.notes = notes.sort((a, b) => a.at - b.at);
  return record;
}
