import { describe, expect, it } from "vitest";
import { countStates, describeLocation, describeState, formatElapsed, formatTokens, formatUsd, shortModel } from "../../src/core/format";
import { view } from "../vscode/helpers";

describe("format", () => {
  it("formats elapsed time at each scale", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(12 * 60_000)).toBe("12m");
    expect(formatElapsed((3 * 60 + 5) * 60_000)).toBe("3h 05m");
    expect(formatElapsed(49 * 3_600_000)).toBe("2d");
  });

  it("describes state with how long it has lasted, and location", () => {
    const now = 12 * 60_000;
    expect(describeState(view({ state: "waiting", needs: "permission prompt" }), now)).toBe("Needs you for 12m: permission prompt");
    expect(describeState(view({ state: "waiting", since: undefined }), now)).toBe("Needs you: input");
    expect(describeState(view({ state: "working" }), now)).toBe("Working for 12m");
    expect(describeState(view({ state: "done", since: now - 3 * 60_000 }), now)).toBe("Finished 3m ago");
    expect(describeState(view({ state: "idle" }), now)).toBe("Idle for 12m");
    expect(describeState(view({ state: "unknown" }), now)).toBe("State unknown");
    expect(describeLocation(view({ worktree: "fix-x" }))).toBe("app · fix-x");
    expect(describeLocation(view())).toBe("app");
  });

  it("counts sessions per state", () => {
    expect(countStates([view({ state: "working" }), view({ state: "working" }), view({ state: "done" })])).toEqual({
      waiting: 0,
      done: 1,
      working: 2,
      unknown: 0,
      idle: 0,
    });
  });

  it("formats token counts and model names", () => {
    expect([formatTokens(850), formatTokens(189_585), formatTokens(1_250_000)]).toEqual(["850", "190k", "1.3M"]);
    expect(shortModel("claude-fable-5-1[1m]")).toBe("Fable 5.1");
    expect(shortModel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModel("gpt-6")).toBe("gpt-6");
  });

  it("formats money", () => {
    expect([formatUsd(0.004), formatUsd(0.42), formatUsd(9.99), formatUsd(117.47), formatUsd(1234)]).toEqual(["$0.00", "$0.42", "$9.99", "$117", "$1.2k"]);
  });
});
