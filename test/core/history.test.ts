import { describe, expect, it } from "vitest";
import { HISTORY_WINDOW_MS, StateHistory } from "../../src/core/history";
import { view } from "../vscode/helpers";

const MIN = 60_000;

describe("StateHistory", () => {
  it("starts a session's history at the state it is in, dated by its own since", () => {
    const history = new StateHistory();
    history.record([view({ state: "working", since: 100 * MIN })], 102 * MIN);
    expect(history.of(view().id)).toEqual([{ state: "working", at: 100 * MIN }]);
    expect(history.of("unknown")).toEqual([]);
  });

  it("adds a point on every change, dated when the change was seen", () => {
    const history = new StateHistory();
    history.record([view({ state: "working" })], 10 * MIN);
    history.record([view({ state: "working" })], 11 * MIN);
    history.record([view({ state: "waiting" })], 12 * MIN);
    history.record([view({ state: "idle" })], 13 * MIN);
    expect(history.of(view().id).map((p) => [p.state, p.at / MIN])).toEqual([
      ["working", 0],
      ["waiting", 12],
      ["idle", 13],
    ]);
  });

  it("keeps the window plus the point that says what the session did at its start", () => {
    const history = new StateHistory();
    const start = 1_000 * MIN;
    history.record([view({ state: "idle", since: start })], start);
    history.record([view({ state: "working" })], start + 10 * MIN);
    history.record([view({ state: "idle" })], start + 20 * MIN);
    history.record([view({ state: "working" })], start + 90 * MIN);
    const now = start + 95 * MIN;
    history.record([view({ state: "working" })], now);
    const points = history.of(view().id);
    expect(points.map((p) => [p.state, (p.at - start) / MIN])).toEqual([
      ["idle", 20],
      ["working", 90],
    ]);
    expect(points[0]!.at).toBeLessThan(now - HISTORY_WINDOW_MS);
  });

  it("forgets a session that ended", () => {
    const history = new StateHistory();
    history.record([view({ state: "working" })], MIN);
    history.record([], 2 * MIN);
    expect(history.of(view().id)).toEqual([]);
    history.record([view({ state: "idle" })], 3 * MIN);
    expect(history.of(view().id)).toEqual([{ state: "idle", at: 0 }]);
  });
});
