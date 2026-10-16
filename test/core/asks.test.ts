import { describe, expect, it } from "vitest";
import { ASK_MAX, clip, questionIn, quoteAsk } from "../../src/core/asks";
import { plainText } from "../../src/core/markdown";

describe("quoteAsk", () => {
  it("strips Markdown, collapses whitespace, and clips at 160 characters", () => {
    expect(quoteAsk("Run **all** the `checks`\n\nin [the repo](https://example.com)?")).toBe("Run all the checks in the repo?");
    const long = quoteAsk("word ".repeat(80));
    expect(long).toHaveLength(ASK_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(clip("short")).toBe("short");
  });

  it("keeps list items apart", () => {
    expect(plainText("Pick one:\n\n- Red\n- Blue\n  - navy")).toBe("Pick one: Red; Blue; navy");
  });
});

describe("questionIn", () => {
  it("finds the question a reply ends with", () => {
    expect(questionIn("I fixed the build.\n\nWant me to open the PR?")).toBe("Want me to open the PR?");
    expect(questionIn("Done. **Should I also bump the version?**")).toBe("Done. Should I also bump the version?");
    expect(questionIn('Done; the flag is in.\n\nShall I ship it ("yes" or "no")?')).toBe('Shall I ship it ("yes" or "no")?');
    expect(questionIn("全部完成。要我打开 PR 吗？")).toBe("全部完成。要我打开 PR 吗？");
  });

  it("finds a request for a choice or a yes/no without a question mark", () => {
    expect(questionIn("I can keep the cache or drop it. Let me know which you prefer.")).toBe("I can keep the cache or drop it. Let me know which you prefer.");
    expect(questionIn("Delete the branch (y/n)")).toBe("Delete the branch (y/n)");
    expect(questionIn("Pick one of the two layouts below and I'll build it.")).toBe("Pick one of the two layouts below and I'll build it.");
    expect(questionIn("I picked one of the two layouts and built it.")).toBeUndefined();
    expect(questionIn("Please choose one: the fast path or the safe path.")).toBe("Please choose one: the fast path or the safe path.");
  });

  it("reads a list after a question as its options", () => {
    expect(questionIn("Which approach do you want?\n\n1. Keep the old parser\n2. Write a new one")).toBe("Which approach do you want?");
  });

  it("ignores replies that tell rather than ask, and questions buried earlier", () => {
    expect(questionIn("All 201 tests pass.")).toBeUndefined();
    expect(questionIn("Why did it fail? A stale cache. I cleared it and the run is green.")).toBeUndefined();
    expect(questionIn("Let me know if you need anything else.")).toBeUndefined();
    expect(questionIn("")).toBeUndefined();
  });

  it("does not count a question mark inside code", () => {
    expect(questionIn("The pattern is now:\n\n```ts\nconst x = a ?? b?\n```")).toBeUndefined();
    expect(questionIn("Ready to merge?\n\n```\nnpm test\n```")).toBe("Ready to merge?");
  });

  it("quotes the asking sentence, with the one before it when it is short", () => {
    expect(questionIn("Option A is faster. Option B is safer. Which one?")).toBe("Option B is safer. Which one?");
    expect(questionIn("The values diff is clean and the chart builds. Want me to open the PR now, or try it on staging first?")).toBe("Want me to open the PR now, or try it on staging first?");
  });

  it("quotes only the asking sentence of a long paragraph", () => {
    const reply = `${"The migration rewrote every row of the table and checked the counts against the old ones, twice, with no differences. ".repeat(2)}Do you want me to drop the old table now?`;
    expect(questionIn(reply)).toBe("Do you want me to drop the old table now?");
  });
});
