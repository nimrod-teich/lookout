import { describe, expect, it } from "vitest";
import { Attention } from "../../src/core/attention";
import type { SessionView, State } from "../../src/core/types";
import { view } from "../vscode/helpers";

const unwatched = () => false;
const watched = () => true;

function states(update: { views: SessionView[] }): State[] {
  return update.views.map((v) => v.state);
}

describe("Attention", () => {
  it("marks a turn that finished unwatched as done and reports it once", () => {
    const attention = new Attention();
    expect(states(attention.update([view({ state: "working" })], unwatched))).toEqual(["working"]);
    const finished = attention.update([view({ state: "idle" })], unwatched);
    expect(states(finished)).toEqual(["done"]);
    expect(finished.finished.map((v) => v.id)).toEqual([view().id]);

    const again = attention.update([view({ state: "idle" })], unwatched);
    expect(states(again)).toEqual(["done"]);
    expect(again.finished).toEqual([]);
  });

  it("does not mark sessions that were already idle when Lookout first saw them", () => {
    const attention = new Attention();
    const update = attention.update([view({ state: "idle" })], unwatched);
    expect(states(update)).toEqual(["idle"]);
    expect(update.finished).toEqual([]);
  });

  it("does not mark a turn the user watched finish", () => {
    const attention = new Attention();
    attention.update([view({ state: "working" })], watched);
    const update = attention.update([view({ state: "idle" })], watched);
    expect(states(update)).toEqual(["idle"]);
    expect(update.finished).toEqual([]);
  });

  it("does not mark sessions that run elsewhere", () => {
    const attention = new Attention();
    attention.update([view({ state: "working", host: "elsewhere" })], unwatched);
    const update = attention.update([view({ state: "idle", host: "elsewhere" })], unwatched);
    expect(states(update)).toEqual(["idle"]);
    expect(update.finished).toEqual([]);
  });

  it("marks terminal sessions of this window", () => {
    const attention = new Attention();
    attention.update([view({ state: "working", host: "terminal", terminalPid: 70 })], unwatched);
    expect(states(attention.update([view({ state: "idle", host: "terminal", terminalPid: 70 })], unwatched))).toEqual(["done"]);
  });

  it("clears done when the user looks, when the session works again, and on mark all", () => {
    const attention = new Attention();
    const finish = () => {
      attention.update([view({ state: "working" })], unwatched);
      attention.update([view({ state: "idle" })], unwatched);
    };
    finish();
    expect(attention.markSeen(view().id)).toBe(true);
    expect(attention.markSeen(view().id)).toBe(false);
    expect(states(attention.update([view({ state: "idle" })], unwatched))).toEqual(["idle"]);

    finish();
    expect(states(attention.update([view({ state: "working" })], unwatched))).toEqual(["working"]);
    expect(attention.isDone(view().id)).toBe(false);

    attention.update([view({ state: "idle" })], unwatched);
    expect(attention.markAllSeen()).toBe(true);
    expect(attention.markAllSeen()).toBe(false);
  });

  it("forgets a session that ended", () => {
    const attention = new Attention();
    attention.update([view({ state: "working" })], unwatched);
    attention.update([view({ state: "idle" })], unwatched);
    attention.update([], unwatched);
    expect(attention.isDone(view().id)).toBe(false);
    // The same id showing up again idle is a first sighting, not a finished turn.
    expect(states(attention.update([view({ state: "idle" })], unwatched))).toEqual(["idle"]);
  });

  it("reports a session that starts to wait, once, unless the user is looking or it was already waiting", () => {
    const attention = new Attention();
    expect(attention.update([view({ state: "waiting" })], unwatched).waiting).toEqual([]);

    attention.update([view({ state: "working" })], unwatched);
    expect(attention.update([view({ state: "waiting" })], unwatched).waiting).toHaveLength(1);
    expect(attention.update([view({ state: "waiting" })], unwatched).waiting).toEqual([]);

    attention.update([view({ state: "working" })], unwatched);
    expect(attention.update([view({ state: "waiting" })], watched).waiting).toEqual([]);

    attention.update([view({ state: "working", host: "elsewhere" })], unwatched);
    expect(attention.update([view({ state: "waiting", host: "elsewhere" })], unwatched).waiting).toEqual([]);
  });

  it("does not treat waiting then idle as a finished turn", () => {
    const attention = new Attention();
    attention.update([view({ state: "waiting" })], unwatched);
    expect(states(attention.update([view({ state: "idle" })], unwatched))).toEqual(["idle"]);
  });
});
