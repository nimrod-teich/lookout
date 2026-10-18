import { describe, expect, it } from "vitest";
import { factsOf } from "../../../../src/core/agents/codex/history";
import { EDITED, fixtureFile, fixtureLines, IDLE } from "./fixtures";

describe("the facts of a Codex rollout line", () => {
  it("are what you wrote and what Codex replied, without the context Codex adds", () => {
    const facts = fixtureLines(fixtureFile(IDLE)).map(factsOf).filter((f) => f?.message);
    expect(facts.map((f) => [f!.message!.role, f!.message!.text])).toEqual([
      ["you", "What is 2+2? Answer with one word and do not run any commands."],
      ["agent", "Four"],
    ]);
    expect(facts[0]!.message!.at).toBe(Date.parse("2026-10-18T12:03:43.486Z"));
  });

  it("keep Codex's progress notes, and the files its commands read and its patches changed", () => {
    const facts = fixtureLines(fixtureFile(EDITED)).map(factsOf).filter(Boolean);
    expect(facts.filter((f) => f!.message?.role === "agent").map((f) => f!.message!.text)).toEqual([
      "I’ll append `hello` to `notes.md`, then show the file with `cat`.",
      "Appended `hello`. `cat notes.md` shows:\n\n```text\n# notes\n\nfirst line\nhello\n```",
      "I’ll use `apply_patch` to add `world` to `notes.md`.",
      "Added `world` to `notes.md` using `apply_patch`.",
    ]);
    expect(facts.flatMap((f) => f!.paths ?? [])).toEqual(["/work/f/notes.md"]);
    // A read Codex parsed names its file too.
    expect(factsOf(JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", parsed_cmd: [{ type: "read", cmd: "cat README.md", name: "README.md", path: "README.md" }] } } }))).toEqual({ paths: ["README.md"] });
  });

  it("skip everything else unparsed", () => {
    expect(factsOf('{"type":"event_msg","payload":{"type":"token_count"}}')).toBeUndefined();
    expect(factsOf('{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"x"}]}}')).toBeUndefined();
    expect(factsOf("{broken")).toBeUndefined();
  });
});
