import { isHere } from "./model";
import type { SessionView, State, TypedQuestion } from "./types";

export interface AttentionUpdate {
  /** The views, with "done" in place of "idle" for turns the user has not looked at, and typed questions as waiting. */
  views: SessionView[];
  /** Sessions that finished a turn in this update while the user was not looking. */
  finished: SessionView[];
  /** Sessions that started to wait for the user in this update while the user was not looking. */
  waiting: SessionView[];
}

export interface AttentionOptions {
  /** An idle session whose last message asks the user something needs them. */
  typedQuestions: boolean;
  /** Another window that runs Lookout hosts this session and marked its turn finished. */
  doneElsewhere?: (view: SessionView) => boolean;
}

function keyOf(question: TypedQuestion): string {
  return question.at !== undefined ? String(question.at) : question.text;
}

/** A question announced late, when the reply reached the transcript after the turn ended, still counts this long after it ended. */
const LATE_QUESTION_MS = 60_000;

/**
 * Tracks which finished turns the user has not seen. A session is "done" from
 * the moment it goes from working to idle unwatched, until the user looks at
 * it, it starts working again, or it ends. Sessions that run elsewhere (another
 * window, an external terminal) are never marked here: this window can't tell
 * when they are looked at. Another window that runs Lookout marks its own, and
 * they show as it says.
 *
 * An idle session of this window whose last message asks the user something
 * needs them, the way a prompt does, until it works again or the user
 * dismisses that question. Like finished turns, other windows' sessions are
 * left to those windows.
 */
export class Attention {
  private readonly previous = new Map<string, State>();
  /** The state each session was shown in by the last update. */
  private readonly shown = new Map<string, State>();
  private readonly done = new Set<string>();
  /** The question each idle session asks now. */
  private readonly questions = new Map<string, string>();
  /** The question the user dismissed, per session. */
  private readonly dismissed = new Map<string, string>();

  update(views: readonly SessionView[], isWatched: (view: SessionView) => boolean, options: AttentionOptions = { typedQuestions: true }, now: number = Date.now()): AttentionUpdate {
    const update: AttentionUpdate = { views: [], finished: [], waiting: [] };
    for (const view of views) {
      const shown = this.present(view, isWatched, options, update, now);
      this.shown.set(view.id, shown.state);
      update.views.push(shown);
    }
    // Forget sessions that ended, including those restored from a reload that never came back.
    const live = new Set(views.map((view) => view.id));
    for (const ids of [this.previous.keys(), this.done.keys(), this.dismissed.keys()]) {
      for (const id of [...ids]) {
        if (live.has(id)) continue;
        this.previous.delete(id);
        this.shown.delete(id);
        this.done.delete(id);
        this.questions.delete(id);
        this.dismissed.delete(id);
      }
    }
    return update;
  }

  /** How one session is shown now; what changed for the user goes into `update`. */
  private present(view: SessionView, isWatched: (view: SessionView) => boolean, options: AttentionOptions, update: AttentionUpdate, now: number): SessionView {
    const before = this.previous.get(view.id);
    const shownBefore = this.shown.get(view.id);
    this.previous.set(view.id, view.state);
    const here = isHere(view);
    if (view.state !== "idle") {
      this.done.delete(view.id);
      this.questions.delete(view.id);
      if (view.state === "waiting" && before !== undefined && before !== "waiting" && here && !isWatched(view)) update.waiting.push(view);
      return view;
    }
    // Another window's session: that window knows whether its turn was seen.
    if (!here) return options.doneElsewhere?.(view) ? { ...view, state: "done" } : view;
    const unseen = before === "working" && !isWatched(view);
    if (unseen) this.done.add(view.id);
    const question = view.question;
    if (question) this.questions.set(view.id, keyOf(question));
    else this.questions.delete(view.id);
    if (options.typedQuestions && question && this.dismissed.get(view.id) !== keyOf(question)) {
      const asked: SessionView = { ...view, state: "waiting", reason: { kind: "typed", ask: question.text }, evidence: { source: "transcript", at: question.at, note: "its last message asks you" } };
      // A turn the user has not seen that ends on a question is announced once; the
      // reply can reach the transcript a poll after the session goes idle.
      const recent = view.since === undefined || now - view.since < LATE_QUESTION_MS;
      if (this.done.has(view.id) && shownBefore !== undefined && shownBefore !== "waiting" && recent) update.waiting.push(asked);
      return asked;
    }
    if (unseen) update.finished.push(view);
    return this.done.has(view.id) ? { ...view, state: "done" } : view;
  }

  /** Ids of the sessions marked done, to carry across a window reload. */
  snapshot(): string[] {
    return [...this.done].sort();
  }

  /** Marks these sessions done, so a reload doesn't forget what the user has not looked at. */
  restore(ids: readonly string[]): void {
    for (const id of ids) this.done.add(id);
  }

  /** The dismissed questions, by session id, to carry across a window reload. */
  dismissals(): Record<string, string> {
    return Object.fromEntries([...this.dismissed].sort(([a], [b]) => a.localeCompare(b)));
  }

  restoreDismissals(dismissals: Readonly<Record<string, string>>): void {
    for (const [id, key] of Object.entries(dismissals)) if (typeof key === "string") this.dismissed.set(id, key);
  }

  /** True when the session was marked done. */
  markSeen(id: string): boolean {
    return this.done.delete(id);
  }

  markAllSeen(): boolean {
    const any = this.done.size > 0;
    this.done.clear();
    return any;
  }

  /** The user dismissed the question the session asks: it is idle until it asks another. */
  dismiss(id: string): boolean {
    const key = this.questions.get(id);
    if (key === undefined || this.dismissed.get(id) === key) return false;
    this.dismissed.set(id, key);
    this.done.delete(id);
    return true;
  }

  isDone(id: string): boolean {
    return this.done.has(id);
  }
}
