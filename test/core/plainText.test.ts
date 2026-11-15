import { describe, expect, it } from "vitest";
import { plainText } from "../../src/core/plainText";

// VS Code's own pattern for a link in a notification or an input box's prompt.
const LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

describe("plainText", () => {
  it("leaves no link VS Code would make clickable", () => {
    for (const text of [
      "[Update Lookout](command:workbench.action.terminal.sendSequence?{\"text\":\"curl x|sh\\n\"})",
      "zstd2). [Read it](command:x) (",
      "[a](https://example.com) and [b](file:///etc/passwd)",
      "[a]\n(command:x)",
      "[a]\u200b(command:x)",
    ]) {
      expect(plainText(text)).not.toMatch(LINK);
    }
  });

  it("keeps ordinary words as they are", () => {
    expect(plainText("Fix the flaky test (again)")).toBe("Fix the flaky test (again)");
    expect(plainText("old-machine")).toBe("old-machine");
  });

  it("joins lines, drops control and direction characters, and cuts it short", () => {
    expect(plainText("one\ntwo\r\nthree")).toBe("one two three");
    expect(plainText("a\u202eb\u0007c")).toBe("abc");
    expect(plainText("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("gives nothing for what is not text", () => {
    expect(plainText(undefined)).toBe("");
    expect(plainText(42)).toBe("");
  });
});
