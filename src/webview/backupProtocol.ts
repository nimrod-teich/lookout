import type { SectionId } from "../core/transfer/types";

/** Fast is zstd 3; smaller is zstd 9. Without zstd both are gzip 6. */
export type Level = "fast" | "smaller";

/** How far back the transcripts go: every one, or the ones active in the last this many days. */
export type Days = 7 | 30 | 90;

/** What the user chose on the page. The passphrase is not part of it: it goes with the save alone. */
export interface BackupChoice {
  /** The sections ticked, the transcripts' subagents and tool outputs among them. */
  sections: SectionId[];
  /** Only the transcripts active in the last this many days; none for every one. */
  days?: Days;
  /** The repositories unticked; none for every one. */
  skipRepos: string[];
  level: Level;
  /** "Don't encrypt" is unticked. */
  encrypt: boolean;
}

/** One section of what there is to back up, as the page lists it. */
export interface SectionRow {
  id: SectionId;
  /** Files, for a section of files; notes, tabs or lists set, for the others. */
  count: number;
  bytes: number;
  /** What the count is made of, when its number alone does not say: "12 starred · 340 archived". */
  detail?: string;
}

/** A repository the transcripts' sessions worked in. */
export interface RepoRow {
  /** As the inventory names it: the key of its tick. */
  repo: string;
  /** Its folder's own name. */
  name: string;
  /** Every session in it, and the bytes of their transcripts with what goes with them. */
  sessions: number;
  bytes: number;
}

/** What the last choice takes, as the core selects it. */
export interface Chosen {
  /** What it takes of each section ticked. */
  sections: Partial<Record<SectionId, { count: number; bytes: number }>>;
  /** What the age filter and the two inclusions leave of each repository, ticked or not. */
  repos: Record<string, { sessions: number; bytes: number }>;
  /** Transcripts, and the other files. */
  sessions: number;
  files: number;
  /** Bytes on disk. */
  bytes: number;
  /** The file's size, estimated, at each level. */
  estimate: Record<Level, number>;
}

/** How far the write got, in bytes read from disk. */
export interface WriteProgress {
  done: number;
  total: number;
}

/** What the last backup wrote. */
export interface BackupSummary {
  file: string;
  name: string;
  /** The file's size. */
  bytes: number;
  /** Transcripts in it, and every file in it, transcripts included. */
  sessions: number;
  files: number;
  /** Files listed at the look that were gone by the write, and left out. */
  left: number;
  encrypted: boolean;
  tookMs: number;
  /** Epoch ms it finished. */
  at: number;
}

export interface BackupState {
  /** What runs now: the look at what there is, the write, or nothing. */
  busy?: "look" | "write";
  progress?: WriteProgress;
  /** This machine's name, as the file is named after it. */
  host: string;
  /** Epoch ms of the last look, when there was one. */
  lookedAt?: number;
  sections: SectionRow[];
  repos: RepoRow[];
  /** What the last choice takes; none before the first look. */
  chosen?: Chosen;
  /** The runtime has zstd; without it both levels are gzip. */
  zstd: boolean;
  summary?: BackupSummary;
  /** What the last look or write left to say, in a sentence. */
  notice?: string;
  /** What went wrong with the last look or write. */
  error?: string;
}

/** Extension → page: the whole state, or, while the write runs, only how far it got. */
export type ToBackup = { type: "state"; state: BackupState } | { type: "progress"; progress: WriteProgress };

/** Page → extension. */
export type FromBackup =
  | { type: "ready" }
  /** Look at what there is again. */
  | { type: "look" }
  /** The choice changed: what it takes and its estimate come back in the state. */
  | { type: "choose"; choice: BackupChoice }
  /** Ask where to save, then write the file. The passphrase travels only here. */
  | { type: "save"; choice: BackupChoice; passphrase?: string }
  /** Stop the write; nothing is saved. */
  | { type: "stop" }
  /** Show the file the last backup wrote in the file manager. */
  | { type: "reveal" }
  /** Take the last backup's summary off the page. */
  | { type: "dismiss" };
