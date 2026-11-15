// What a backup file holds and how its parts are named: the contract shared
// by the file's writer and reader, the backup, the restore, the open-tabs
// capture and Settings Sync. Nothing here touches the disk.
import type { RepoRecord } from "./repos";
import type { Readable } from "node:stream";
import type { SessionRecord } from "../sessionRecords";

/** The parts a backup can hold. The backup page offers each one. */
export type SectionId =
  /** Favourites, archive, parked sessions, sort order, grouping, account names. */
  | "state"
  | "notes"
  /** The Claude tabs open in each window. */
  | "tabs"
  /** Lookout's conversation history database. */
  | "history"
  /** Claude Code transcripts: `<configDir>/projects/<folder>/<sessionId>.jsonl`. */
  | "transcripts"
  /** `<configDir>/projects/<folder>/<sessionId>/subagents/**`. */
  | "subagents"
  /** `<configDir>/projects/<folder>/<sessionId>/tool-results/**`. */
  | "toolResults"
  /** The transcripts Lookout keeps. */
  | "vault"
  | "usage"
  /** The removed-worktrees log. */
  | "worktreesLog";

export const SECTIONS: readonly SectionId[] = ["state", "notes", "tabs", "history", "transcripts", "subagents", "toolResults", "vault", "usage", "worktreesLog"];

/** The globalState keys a backup carries and Settings Sync syncs, besides the notes. Each holds only session ids, names and choices, the same on every machine. */
export const LIGHT_STATE_KEYS = ["lookout.favourites", "lookout.archive", "lookout.parking", "lookout.sort", "lookout.group", "lookout.claudeOrgs"] as const;
export type LightStateKey = (typeof LIGHT_STATE_KEYS)[number];

/** Settings Sync carries the light state, merged across machines, under this globalState key: `SyncedState`. */
export const SYNC_STATE_KEY = "lookout.sync.state";
/** Settings Sync carries every session's notes, merged across machines, under this globalState key: `SyncedNotes`. */
export const SYNC_NOTES_KEY = "lookout.sync.notes";
/** The only keys Lookout ever gives Settings Sync, always both while it syncs. */
export const SYNC_KEYS: readonly string[] = [SYNC_STATE_KEY, SYNC_NOTES_KEY];

/** Restore leaves the tabs it could not open yet under this globalState key (not synced): `PendingTab[]`. */
export const PENDING_TABS_KEY = "lookout.pendingTabs";

export type FileKind = "transcript" | "subagent" | "tool-result" | "history" | "vault" | "usage" | "removed-worktrees";

/** One file in a backup's payload. */
export interface BundleFile {
  kind: FileKind;
  /** Claude files: the label (`ClaudeDir.label`) of the config directory it came from. */
  dir?: string;
  /**
   * Its path under its root, with forward slashes: under `<configDir>/projects`
   * for Claude files, under the vault or usage directory for those, the file's
   * own name for the history and the removed-worktrees log. Never absolute,
   * never with a `..` segment. A reader checks this again before using it.
   */
  rel: string;
  /** The session it belongs to, when it belongs to one. */
  sessionId?: string;
  /** Transcripts: where the session worked on the source machine, for mapping it to this one. */
  cwd?: string;
  /** Bytes. */
  size: number;
  /** Epoch ms it was last written, kept on restore. */
  mtime: number;
  /** Hex sha256 of its bytes. */
  sha256: string;
  /** Where it starts in the uncompressed payload. */
  offset: number;
}

/** What the writer is told about a file before its bytes; the rest it works out. */
export type NewFile = Omit<BundleFile, "size" | "sha256" | "offset">;

/** A Claude tab open in a window. */
export interface TabEntry {
  sessionId: string;
  title: string;
}

/** The Claude tabs open in one window, in tab order. */
export interface WindowTabs {
  label: string;
  /** The window's workspace folders on the source machine, first one first. */
  folders: string[];
  tabs: TabEntry[];
}

/** A tab a restore has yet to open: kept until a window whose first folder is `cwd` opens it, or the user forgets it. */
export interface PendingTab {
  sessionId: string;
  title: string;
  /** Where the session works on this machine, after mapping. */
  cwd: string;
  /** The machine it was open on. */
  from: string;
  /** Epoch ms the backup was made. */
  madeAt: number;
}

export interface SourceMachine {
  /** os.hostname(). */
  host: string;
  platform: NodeJS.Platform;
  /** os.homedir(). */
  home: string;
  /** Inside WSL. */
  wsl: boolean;
}

/** Everything a backup says about itself and the light state it carries. */
export interface BundleManifest {
  format: 1;
  createdAt: number;
  lookoutVersion: string;
  source: SourceMachine;
  /** The sections the user chose. */
  sections: SectionId[];
  state: Partial<Record<LightStateKey, unknown>>;
  notes: SessionRecord[];
  tabs: WindowTabs[];
  claudeDirs: { label: string; resolved: string; isDefault: boolean }[];
  /** The git repositories the sessions, notes and tabs worked in, with their remotes, for a restore to find them here; none in a backup of 0.1.6. */
  repos?: RepoRecord[];
  /** In payload order. */
  files: BundleFile[];
}

/** The manifest as the writer is given it: the files it lists itself. */
export type ManifestBody = Omit<BundleManifest, "files">;

export type Codec = "zstd" | "gzip";

/** Stored in the clear at the start of the file. Nothing secret: enough to say what the file is and ask for its passphrase. */
export interface BundleHeader {
  format: 1;
  cipher: "none" | "aes-256-gcm-stream";
  kdf?: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  codec: Codec;
  createdAt: number;
  host: string;
}

export interface WriteOptions {
  /** Encrypts the file when given. */
  passphrase?: string;
  codec: Codec;
  /** zstd 3 (fast) or 9 (smaller); gzip 6. */
  level: number;
  host: string;
  createdAt: number;
}

/** A backup being written. Files go in one after another; the manifest last. */
export interface BundleSink {
  /** Streams a file's bytes into the payload and returns its entry. `source` is a path or a stream. */
  addFile(entry: NewFile, source: string | Readable): Promise<BundleFile>;
  /** Writes the manifest, closes the file and moves it into place. Until then nothing sits under the file's name. */
  finish(manifest: ManifestBody): Promise<{ bytes: number }>;
  /** Drops what was written. */
  abort(): Promise<void>;
}

/** A backup being read. */
export interface BundleSource {
  header: BundleHeader;
  manifest: BundleManifest;
  /**
   * Goes through the payload in order. `visit` is called for each file
   * `want` accepts (all when it is absent) with a stream of its bytes, which
   * it must read to the end; the rest are read past. A file whose bytes do
   * not match its sha256 rejects with a `BundleError` of code "corrupt".
   */
  forEachFile(visit: (entry: BundleFile, data: Readable) => Promise<void>, want?: (entry: BundleFile) => boolean): Promise<void>;
  close(): Promise<void>;
}

export type BundleErrorCode = "not-a-backup" | "wrong-passphrase" | "corrupt" | "truncated" | "unsupported";

export class BundleError extends Error {
  constructor(
    readonly code: BundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BundleError";
  }
}

/** One prefix of the source machine's paths and where it is on this one. The longest prefix that matches wins. */
export interface PathMapping {
  from: string;
  to: string;
  /** "repo": a repository found here by its remote, not a folder the user or the home folder gave. */
  by?: "repo";
}
