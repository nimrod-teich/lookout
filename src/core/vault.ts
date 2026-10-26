// The transcripts the user asked Lookout to keep: a copy of each under the
// extension's storage, as a hard link where the file system allows one (no
// room taken, and the copy follows the file as the agent appends to it) or
// a plain copy where it does not, so the agent's own deletion of the file
// takes nothing from the user. And the way back: the copy put where the
// agent keeps its transcripts, for the agent to resume it. The agent's
// format is its own and changes between releases, so a restore may not
// resume on a later one; the words are kept all the same.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** A transcript kept, as its record says. */
export interface KeptTranscript {
  id: string;
  /** Id of the agent provider the session belongs to. */
  agent: string;
  /** Where the agent keeps the transcript: the file linked or copied, and where a restore puts it back. */
  file: string;
  /** Epoch ms it was first kept. */
  keptAt: number;
  /** Bytes, as last seen. */
  size: number;
  /** The copy is a hard link to the agent's file, and follows it; else a plain copy, refreshed when the file grows. */
  linked: boolean;
}

interface Record extends KeptTranscript {
  v: 1;
}

/** How a restore went. */
export type Restore = { ok: true; file: string } | { ok: false; file: string; why: string };

export class TranscriptVault {
  constructor(private readonly dir: string) {}

  /** Where a session's kept transcript sits. */
  fileOf(id: string): string {
    return path.join(this.dir, `${hash(id)}.jsonl`);
  }

  private recordOf(id: string): string {
    return path.join(this.dir, `${hash(id)}.json`);
  }

  /** The session's transcript is kept. */
  has(id: string): boolean {
    return this.record(id) !== undefined && fs.existsSync(this.fileOf(id));
  }

  /** What is kept of a session, when something is. */
  record(id: string): KeptTranscript | undefined {
    return readRecord(this.recordOf(id));
  }

  /** Every transcript kept, the most recently kept first. */
  kept(): KeptTranscript[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: KeptTranscript[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = readRecord(path.join(this.dir, name));
      if (record && fs.existsSync(this.fileOf(record.id))) out.push(record);
    }
    return out.sort((a, b) => b.keptAt - a.keptAt);
  }

  /**
   * Keeps a session's transcript: a hard link to the file where the file
   * system allows one, a copy otherwise. One kept already is left as it
   * is, unless the agent replaced the file since: then the new file is
   * kept. What is kept, or nothing when the file cannot be read.
   */
  keep(id: string, agent: string, file: string, now: number = Date.now()): KeptTranscript | undefined {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return undefined;
    }
    const target = this.fileOf(id);
    const before = this.record(id);
    const held = statOf(target);
    if (before && held) {
      // A link still to the same file: nothing to do; a copy: brought up to the file.
      if (sameFile(held, st)) return this.write({ ...before, file, size: st.size });
      if (!before.linked && before.file === file && held.size <= st.size && held.ino !== st.ino) {
        try {
          fs.copyFileSync(file, target);
          return this.write({ ...before, file, size: st.size });
        } catch {
          return undefined;
        }
      }
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.rmSync(target, { force: true });
    } catch {
      return undefined;
    }
    let linked = true;
    try {
      fs.linkSync(file, target);
    } catch {
      // Another file system, or one without links: a copy.
      linked = false;
      try {
        fs.copyFileSync(file, target);
      } catch {
        return undefined;
      }
    }
    return this.write({ id, agent, file, keptAt: before?.keptAt ?? now, size: st.size, linked });
  }

  /** Follows a kept transcript whose file the agent replaced or grew: kept again from the file as it is now. Nothing when the file is gone. */
  refresh(id: string): KeptTranscript | undefined {
    const record = this.record(id);
    if (!record || !fs.existsSync(record.file)) return record;
    return this.keep(id, record.agent, record.file, record.keptAt) ?? record;
  }

  /** Stops keeping a session's transcript: the copy goes. */
  release(id: string): void {
    for (const file of [this.fileOf(id), this.recordOf(id)]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Gone already.
      }
    }
  }

  /**
   * Puts a kept transcript back where the agent keeps its transcripts, the
   * place it was kept from and nowhere else, as a link where one can be
   * made so the agent's appends are kept too. Refused when a file is there
   * already: the agent's own is never written over.
   */
  restore(id: string): Restore {
    const record = this.record(id);
    const source = this.fileOf(id);
    if (!record || !fs.existsSync(source)) return { ok: false, file: record?.file ?? "", why: "is not kept" };
    if (fs.existsSync(record.file)) return { ok: false, file: record.file, why: "is there already" };
    try {
      fs.mkdirSync(path.dirname(record.file), { recursive: true });
    } catch {
      return { ok: false, file: record.file, why: "its folder could not be made" };
    }
    try {
      fs.linkSync(source, record.file);
      this.write({ ...record, linked: true });
    } catch {
      try {
        fs.copyFileSync(source, record.file);
      } catch {
        return { ok: false, file: record.file, why: "could not be written" };
      }
    }
    return { ok: true, file: record.file };
  }

  /** How much is kept: files, and bytes as last seen. */
  size(): { files: number; bytes: number } {
    const kept = this.kept();
    return { files: kept.length, bytes: kept.reduce((sum, record) => sum + record.size, 0) };
  }

  private write(record: KeptTranscript): KeptTranscript {
    const target = this.recordOf(record.id);
    const temp = `${target}.${process.pid}.tmp`;
    const full: Record = { v: 1, ...record };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(full));
      fs.renameSync(temp, target);
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Nothing to take back.
      }
    }
    return record;
  }
}

function hash(id: string): string {
  return crypto.createHash("sha1").update(id).digest("hex");
}

function statOf(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

/** The two names are the same file: the same inode on the same device. */
function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev && a.ino !== 0;
}

function readRecord(file: string): KeptTranscript | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const r = raw as Partial<Record> | null;
  if (!r || r.v !== 1 || typeof r.id !== "string" || typeof r.agent !== "string" || typeof r.file !== "string" || typeof r.keptAt !== "number") return undefined;
  return { id: r.id, agent: r.agent, file: r.file, keptAt: r.keptAt, size: typeof r.size === "number" ? r.size : 0, linked: r.linked === true };
}
