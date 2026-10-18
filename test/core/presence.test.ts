import { describe, expect, it } from "vitest";
import { Presence } from "../../src/core/presence";

describe("Presence", () => {
  it("puts the user in any terminal while nothing is known", () => {
    const presence = new Presence();
    expect([presence.inTerminal(71), presence.inTerminal(72)]).toEqual([true, true]);
  });

  it("follows the latest sighting, and ignores one older than it", () => {
    const presence = new Presence();
    presence.saw(71, 1_000);
    expect([presence.inTerminal(71), presence.inTerminal(72)]).toEqual([true, false]);
    presence.saw("elsewhere", 2_000);
    expect(presence.inTerminal(71)).toBe(false);
    presence.saw(71, 1_500);
    expect(presence.inTerminal(71)).toBe(false);
    presence.saw(71, 2_000);
    expect(presence.inTerminal(71)).toBe(true);
  });
});
