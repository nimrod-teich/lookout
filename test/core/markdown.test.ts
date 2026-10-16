import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../../src/core/markdown";

describe("parseInline", () => {
  it("reads code, bold, italics and links, and leaves the rest as text", () => {
    expect(parseInline("Run `npm test` **now**, _please_, see [docs](https://example.com/x) *ok*")).toEqual([
      { type: "text", text: "Run " },
      { type: "code", text: "npm test" },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "text", text: "now" }] },
      { type: "text", text: ", " },
      { type: "em", children: [{ type: "text", text: "please" }] },
      { type: "text", text: ", see " },
      { type: "link", text: "docs", href: "https://example.com/x" },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "ok" }] },
    ]);
  });

  it("keeps underscores inside words, stray stars, and code with backticks", () => {
    expect(parseInline("snake_case_name and 2 * 3 and ``a ` b``")).toEqual([
      { type: "text", text: "snake_case_name and 2 * 3 and " },
      { type: "code", text: "a ` b" },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("reads headings, paragraphs with their line breaks, rules and quotes", () => {
    const blocks = parseMarkdown("## Plan\n\nFirst line\nsecond line\n\n---\n> quoted\n> more\n");
    expect(blocks).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", text: "Plan" }] },
      { type: "paragraph", children: [{ type: "text", text: "First line\nsecond line" }] },
      { type: "rule" },
      { type: "quote", children: [{ type: "text", text: "quoted\nmore" }] },
    ]);
  });

  it("reads fenced code whole, with its language, and never formats inside it", () => {
    const blocks = parseMarkdown("Before\n```json\n{ \"hooks\": { \"Stop\": \"**x**\" } }\n\n```\nAfter");
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "Before" }] },
      { type: "code", lang: "json", text: '{ "hooks": { "Stop": "**x**" } }\n' },
      { type: "paragraph", children: [{ type: "text", text: "After" }] },
    ]);
    // An unclosed fence runs to the end.
    expect(parseMarkdown("```\nlet x = 1")).toEqual([{ type: "code", lang: "", text: "let x = 1" }]);
  });

  it("reads bullet and numbered lists, nesting deeper items and continuation lines", () => {
    const blocks = parseMarkdown("1. **First** step\n2. Second\n   - sub a\n   - sub b\n   continued\n3. Third\n\n- loose\n* bullets");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: true,
        items: [
          { children: [{ type: "strong", children: [{ type: "text", text: "First" }] }, { type: "text", text: " step" }] },
          {
            children: [{ type: "text", text: "Second" }],
            sub: {
              type: "list",
              ordered: false,
              items: [{ children: [{ type: "text", text: "sub a" }] }, { children: [{ type: "text", text: "sub b" }, { type: "text", text: "\n" }, { type: "text", text: "continued" }] }],
            },
          },
          { children: [{ type: "text", text: "Third" }] },
        ],
      },
      { type: "list", ordered: false, items: [{ children: [{ type: "text", text: "loose" }] }, { children: [{ type: "text", text: "bullets" }] }] },
    ]);
  });

  it("treats a lone line of plain text as one paragraph", () => {
    expect(parseMarkdown("is there a way to see which tab is working?")).toEqual([{ type: "paragraph", children: [{ type: "text", text: "is there a way to see which tab is working?" }] }]);
    expect(parseMarkdown("")).toEqual([]);
  });
});
