import { describe, expect, it } from "vitest";
import { NotifyGate, SUMMARY_FROM, type Notice } from "../../src/core/notifyGate";

const HINT = "Lookout · Ctrl+Alt+Shift+J";
const notice = (id: string, kind: Notice["kind"] = "waiting"): Notice => ({ id, kind, title: `Session ${id}`, body: `Needs you: Permission · Bash: npm test` });

describe("NotifyGate", () => {
  it("sends one notification per session and kind per cooldown", () => {
    const gate = new NotifyGate(30_000);
    expect(gate.decide(notice("a"), ["Session a"], HINT, 0)).toEqual({ title: "Session a", body: `Needs you: Permission · Bash: npm test\n${HINT}`, tag: "a" });
    expect(gate.decide(notice("a"), ["Session a"], HINT, 29_999)).toBeUndefined();
    expect(gate.decide(notice("a", "finished"), [], HINT, 1_000)).toMatchObject({ title: "Session a" });
    expect(gate.decide(notice("b"), ["Session a", "Session b"], HINT, 2_000)).toMatchObject({ title: "Session b" });
    expect(gate.decide(notice("a"), ["Session a"], HINT, 30_000)).toMatchObject({ title: "Session a" });
  });

  it("sums up while three or more sessions need the user, once per cooldown", () => {
    expect(SUMMARY_FROM).toBe(3);
    const gate = new NotifyGate(30_000);
    const three = ["Migrate billing", "Close tickets", "Cache the specs"];
    expect(gate.decide(notice("a"), three, HINT, 0)).toEqual({ title: "3 sessions need you", body: `Migrate billing, Close tickets, Cache the specs\n${HINT}`, tag: "summary" });
    expect(gate.decide(notice("b"), [...three, "Fourth"], HINT, 1_000)).toBeUndefined();
    expect(gate.decide(notice("c", "finished"), three, HINT, 2_000)).toBeUndefined();
    // Each session counted in a summary is not announced alone either, until its cooldown ends.
    expect(gate.decide(notice("b"), ["Session b"], HINT, 3_000)).toBeUndefined();
    expect(gate.decide(notice("d"), three, HINT, 31_000)).toMatchObject({ title: "3 sessions need you" });
  });

  it("lets everything through with no cooldown", () => {
    const gate = new NotifyGate(30_000);
    gate.setCooldown(0);
    expect(gate.decide(notice("a"), [], HINT, 0)).toBeDefined();
    expect(gate.decide(notice("a"), [], HINT, 0)).toBeDefined();
    gate.setCooldown(-5);
    expect(gate.decide(notice("a"), [], HINT, 1)).toBeDefined();
  });
});
