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

describe("Attention across a reload", () => {
  it("restores finished marks so a resumed idle session still shows as done", () => {
    const first = new Attention();
    first.update([view({ state: "working" })], unwatched);
    first.update([view({ state: "idle" })], unwatched);
    expect(first.snapshot()).toEqual([view().id]);

    const second = new Attention();
    second.restore(first.snapshot());
    expect(states(second.update([view({ state: "idle" })], unwatched))).toEqual(["done"]);
    expect(second.snapshot()).toEqual([view().id]);
    second.markAllSeen();
    expect(second.snapshot()).toEqual([]);
  });
});

describe("Attention and typed questions", () => {
  const question = { text: "Want me to open the PR?", at: 5_000 };
  const asked = (overrides: Partial<SessionView> = {}) => view({ state: "idle", question, ...overrides });
  const typed = { typedQuestions: true };
  /** A moment after the view's turn ended (`since` 0). */
  const soon = 1_000;

  it("puts an idle session whose last reply asks something in Needs you, read from the transcript", () => {
    const attention = new Attention();
    const [out] = attention.update([asked()], unwatched).views;
    expect(out).toMatchObject({ state: "waiting", reason: { kind: "typed", ask: "Want me to open the PR?" }, evidence: { source: "transcript", at: 5_000 } });
    // Seen or not, it stays until answered: looking at it is not answering it.
    expect(attention.update([asked()], watched).views[0]?.state).toBe("waiting");
  });

  it("announces a turn that ends on a question, unwatched, as a wait rather than a finish", () => {
    const attention = new Attention();
    attention.update([view({ state: "working" })], unwatched);
    const update = attention.update([asked()], unwatched, typed, soon);
    expect(update.waiting.map((v) => v.reason?.kind)).toEqual(["typed"]);
    expect(update.finished).toEqual([]);
    expect(attention.update([asked()], unwatched, typed, soon).waiting).toEqual([]);

    attention.update([view({ state: "working" })], unwatched);
    expect(attention.update([asked()], watched, typed, soon).waiting).toEqual([]);
  });

  it("announces the question once when the reply reaches the transcript a poll after the turn ends", () => {
    const attention = new Attention();
    attention.update([view({ state: "working" })], unwatched);
    const ended = attention.update([view({ state: "idle" })], unwatched, typed, soon);
    expect(states(ended)).toEqual(["done"]);
    expect(ended.finished).toHaveLength(1);
    const late = attention.update([asked()], unwatched, typed, soon);
    expect(late.waiting.map((v) => v.reason?.ask)).toEqual(["Want me to open the PR?"]);
    expect(attention.update([asked()], unwatched, typed, soon).waiting).toEqual([]);
  });

  it("does not announce an old turn's question when typed questions are switched on", () => {
    const attention = new Attention();
    attention.update([view({ state: "working" })], unwatched);
    expect(states(attention.update([asked()], unwatched, { typedQuestions: false }, soon))).toEqual(["done"]);
    const switched = attention.update([asked()], unwatched, typed, 10 * 60_000);
    expect(states(switched)).toEqual(["waiting"]);
    expect(switched.waiting).toEqual([]);
  });

  it("leaves the questions of other windows' sessions to those windows", () => {
    const attention = new Attention();
    expect(states(attention.update([asked({ host: "window", windowLabel: "api" }), asked({ id: "b", host: "elsewhere" })], unwatched))).toEqual(["idle", "idle"]);
    expect(states(attention.update([asked({ host: "terminal", terminalPid: 70 })], unwatched))).toEqual(["waiting"]);
  });

  it("does not announce a question the user was shown before a reload", () => {
    const attention = new Attention();
    attention.restore([view().id]);
    const update = attention.update([asked()], unwatched);
    expect(states(update)).toEqual(["waiting"]);
    expect(update.waiting).toEqual([]);
  });

  it("drops the question when dismissed, until the session asks another", () => {
    const attention = new Attention();
    attention.update([view({ state: "working" })], unwatched);
    attention.update([asked()], unwatched);
    expect(attention.dismiss(view().id)).toBe(true);
    expect(attention.dismiss(view().id)).toBe(false);
    // Dismissed means seen: no finished mark either.
    expect(states(attention.update([asked()], unwatched))).toEqual(["idle"]);
    expect(states(attention.update([asked({ question: { text: "And the changelog?", at: 9_000 } })], unwatched))).toEqual(["waiting"]);
    expect(attention.dismiss("no-such-session")).toBe(false);
  });

  it("keeps a dismissal through a dialog or a short turn, and asks again with a new reply", () => {
    const attention = new Attention();
    attention.update([asked()], unwatched);
    attention.dismiss(view().id);
    attention.update([view({ state: "waiting", reason: { kind: "dialog", ask: "dialog open", raw: "dialog open" } })], unwatched);
    attention.update([view({ state: "unknown" })], unwatched);
    expect(states(attention.update([asked()], unwatched))).toEqual(["idle"]);
    attention.update([view({ state: "working" })], unwatched);
    expect(states(attention.update([asked({ question: { text: "Tag it now?", at: 9_000 } })], unwatched))).toEqual(["waiting"]);
  });

  it("forgets the marks and dismissals of sessions that ended while the window was closed", () => {
    const attention = new Attention();
    attention.restore(["gone", view().id]);
    attention.restoreDismissals({ gone: "5000", [view().id]: "5000" });
    attention.update([asked()], unwatched);
    expect(attention.snapshot()).toEqual([view().id]);
    expect(attention.dismissals()).toEqual({ [view().id]: "5000" });
  });

  it("carries dismissals across a reload", () => {
    const first = new Attention();
    first.update([asked()], unwatched);
    first.dismiss(view().id);
    const second = new Attention();
    second.restoreDismissals(first.dismissals());
    expect(first.dismissals()).toEqual({ [view().id]: "5000" });
    expect(states(second.update([asked()], unwatched))).toEqual(["idle"]);
  });

  it("leaves it to Finished and Idle when typed questions are off", () => {
    const attention = new Attention();
    attention.update([view({ state: "working" })], unwatched);
    const update = attention.update([asked()], unwatched, { typedQuestions: false });
    expect(states(update)).toEqual(["done"]);
    expect(update.finished).toHaveLength(1);
    expect(update.waiting).toEqual([]);
  });
});
