import type { SessionView, State } from "./types";

export interface AttentionUpdate {
  /** The views, with "done" in place of "idle" for turns the user has not looked at. */
  views: SessionView[];
  /** Sessions that finished a turn in this update while the user was not looking. */
  finished: SessionView[];
  /** Sessions that started to wait for the user in this update while the user was not looking. */
  waiting: SessionView[];
}

/**
 * Tracks which finished turns the user has not seen. A session is "done" from
 * the moment it goes from working to idle unwatched, until the user looks at
 * it, it starts working again, or it ends. Sessions that run elsewhere (another
 * window, an external terminal) are never marked: this window can't tell when
 * they are looked at.
 */
export class Attention {
  private readonly previous = new Map<string, State>();
  private readonly done = new Set<string>();

  update(views: readonly SessionView[], isWatched: (view: SessionView) => boolean): AttentionUpdate {
    const finished: SessionView[] = [];
    const waiting: SessionView[] = [];
    const live = new Set<string>();
    const out = views.map((view) => {
      live.add(view.id);
      const before = this.previous.get(view.id);
      this.previous.set(view.id, view.state);
      const here = view.host !== "elsewhere";
      if (view.state !== "idle") {
        this.done.delete(view.id);
        if (view.state === "waiting" && before !== undefined && before !== "waiting" && here && !isWatched(view)) waiting.push(view);
        return view;
      }
      if (before === "working" && here && !isWatched(view)) {
        this.done.add(view.id);
        finished.push(view);
      }
      return this.done.has(view.id) ? { ...view, state: "done" as const } : view;
    });
    for (const id of this.previous.keys()) {
      if (live.has(id)) continue;
      this.previous.delete(id);
      this.done.delete(id);
    }
    return { views: out, finished, waiting };
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

  isDone(id: string): boolean {
    return this.done.has(id);
  }
}
