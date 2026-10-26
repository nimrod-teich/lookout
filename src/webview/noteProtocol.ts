/** The session a note is on, as the note page heads it. */
export interface NoteSession {
  id: string;
  title: string;
  /** Its project, worktree and git branch, e.g. "api · ⎇ fix-login". */
  where?: string;
  agent?: string;
  /** Running now. */
  live?: boolean;
  /** `open` can reach it: false for one running where Lookout cannot bring it forward. */
  openable?: boolean;
}

/** Extension → note page: the session and the note on it; how a save went. */
export type ToNote =
  | { type: "note"; session: NoteSession; note: string | undefined; noteAt?: number; max: number; markers?: boolean }
  | { type: "saved"; id: string; note: string | undefined; noteAt?: number }
  | { type: "failed"; id: string };

/** Note page → extension. */
export type FromNote = { type: "ready" } | { type: "save"; id: string; text: string } | { type: "remove"; id: string } | { type: "open"; id: string };
