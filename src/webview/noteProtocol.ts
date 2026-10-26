/** The session a note page is on, as the page heads it. */
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

/** One note of the thread, as the page shows it. */
export interface NoteItem {
  id: string;
  text: string;
  /** Epoch ms it was written. */
  at: number;
  /** Epoch ms it was last changed, when it was. */
  editedAt?: number;
}

/** Extension → note page: the session and its notes, oldest first; a change that could not be kept. */
export type ToNote = { type: "notes"; session: NoteSession; notes: NoteItem[]; max: number; markers?: boolean } | { type: "failed"; id: string };

/** Note page → extension. */
export type FromNote = { type: "ready" } | { type: "add"; id: string; text: string } | { type: "edit"; id: string; noteId: string; text: string } | { type: "remove"; id: string; noteId: string } | { type: "open"; id: string };
