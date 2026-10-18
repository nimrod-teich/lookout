/** Where the user is: an integrated terminal, by its shell pid, or anywhere else in the window. */
export type Place = number | "elsewhere";

/**
 * Where the user last was in a window. VS Code names the active terminal but
 * not whether the user is in it: a terminal stays the active one while the
 * user works in an editor, a tab or another panel. So the place comes from
 * what the user did last: brought a terminal forward, switched tabs, typed in
 * an editor, or sent a session a prompt.
 */
export class Presence {
  private place: Place | undefined;
  private at = -Infinity;

  /** The user was at `place` at `at`; a sighting older than the last one is ignored. */
  saw(place: Place, at: number): void {
    if (at < this.at) return;
    this.place = place;
    this.at = at;
  }

  /** The user is in this terminal as far as known; with nothing known yet, they may be. */
  inTerminal(pid: number): boolean {
    return this.place === undefined || this.place === pid;
  }
}
