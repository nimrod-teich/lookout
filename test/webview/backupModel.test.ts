import { describe, expect, it } from "vitest";
import { SECTIONS } from "../../src/core/transfer/types";
import { count, countText, defaultChoice, effectiveSections, holdsConversations, MAX_PASSPHRASE, PAGE_SECTIONS, passphraseProblem, plainWarning, readChoice, repoName, SECTION_INFO, TRANSCRIPT_PARTS } from "../../src/webview/backupModel";
import type { SectionRow } from "../../src/webview/backupProtocol";

const rows: SectionRow[] = [
  { id: "transcripts", count: 3, bytes: 4500 },
  { id: "history", count: 1, bytes: 4000 },
  { id: "vault", count: 0, bytes: 0 },
  { id: "notes", count: 3, bytes: 90, detail: "3 notes on 2 sessions" },
];

describe("the sections", () => {
  it("lists every section once: the transcripts' parts inside the transcripts, the rest on their own", () => {
    expect([...PAGE_SECTIONS, ...TRANSCRIPT_PARTS].sort()).toEqual([...SECTIONS].sort());
    for (const id of SECTIONS) expect(SECTION_INFO[id].title, id).not.toBe("");
  });

  it("starts with everything in, fast and encrypted", () => {
    expect(defaultChoice()).toEqual({ sections: [...SECTIONS], skipRepos: [], level: "fast", encrypt: true });
  });

  it("takes the subagents and tool outputs only with the transcripts", () => {
    expect(effectiveSections({ sections: ["toolResults", "transcripts", "notes"] })).toEqual(["notes", "transcripts", "toolResults"]);
    expect(effectiveSections({ sections: ["subagents", "toolResults", "notes"] })).toEqual(["notes"]);
  });

  it("says a count in words, with its detail when it has one", () => {
    expect(count(1, "session")).toBe("1 session");
    expect(count(1204, "session")).toBe("1,204 sessions");
    expect(count(2, "repository", "repositories")).toBe("2 repositories");
    expect(countText({ id: "transcripts", count: 1204, bytes: 1 })).toBe("1,204 sessions");
    expect(countText({ id: "vault", count: 1, bytes: 1 })).toBe("1 kept transcript");
    expect(countText({ id: "notes", count: 3, bytes: 1, detail: "3 notes on 2 sessions" })).toBe("3 notes on 2 sessions");
    expect(countText({ id: "state", count: 2, bytes: 1 })).toBe("");
    expect(countText({ id: "transcripts", count: 0, bytes: 0 })).toBe("");
  });

  it("names a repository by its folder", () => {
    expect(repoName("/home/dev/src/api")).toBe("api");
    expect(repoName("C:\\src\\web\\")).toBe("web");
    expect(repoName("docs")).toBe("docs");
  });
});

describe("the passphrase", () => {
  const all = defaultChoice();

  it("warns of what Don't encrypt leaves in the clear: the conversations when one goes in, else what the file holds", () => {
    const conversations = "The file then holds your conversations in the clear: anyone with a copy of it can read them.";
    const rest = "The file is then in the clear: anyone with a copy of it can read what it holds.";
    expect(plainWarning(all, rows)).toBe(conversations);
    expect(plainWarning({ sections: ["history"] }, rows)).toBe(conversations);
    // The vault holds conversations, but none here.
    expect(holdsConversations({ sections: ["vault", "notes"] }, rows)).toBe(false);
    expect(plainWarning({ sections: ["vault", "notes"] }, rows)).toBe(rest);
    expect(plainWarning({ sections: ["notes", "state", "tabs"] }, rows)).toBe(rest);
    // Subagents without their transcripts do not go in.
    expect(holdsConversations({ sections: ["subagents", "notes"] }, [...rows, { id: "subagents", count: 2, bytes: 1 }])).toBe(false);
  });

  it("is wanted whatever goes in, unless Don't encrypt is ticked, and says what stands between the fields and a save", () => {
    const fields = { encrypt: true, passphrase: "", confirm: "" };
    expect(passphraseProblem(fields)).toBe("Type a passphrase, or tick Don't encrypt.");
    expect(passphraseProblem({ ...fields, encrypt: false })).toBeUndefined();
    expect(passphraseProblem({ ...fields, encrypt: false, passphrase: "tide" })).toBeUndefined();
    expect(passphraseProblem({ ...fields, passphrase: "tide" })).toBe("Type the passphrase again to confirm it.");
    expect(passphraseProblem({ ...fields, passphrase: "tide", confirm: "tidy" })).toBe("The two passphrases differ.");
    expect(passphraseProblem({ ...fields, confirm: "tide" })).toBe("The two passphrases differ.");
    expect(passphraseProblem({ ...fields, passphrase: "tide", confirm: "tide" })).toBeUndefined();
    const long = "x".repeat(MAX_PASSPHRASE + 1);
    expect(passphraseProblem({ ...fields, passphrase: long, confirm: long })).toBe(`The passphrase is longer than ${MAX_PASSPHRASE} characters.`);
  });
});

describe("readChoice", () => {
  it("keeps what a choice may hold, in order, and drops the rest", () => {
    expect(readChoice({ sections: ["notes", "bogus", "state", 4], days: 30, skipRepos: ["/a", 3, "/a", "/b"], level: "smaller", encrypt: false, passphrase: "nope" })).toEqual({
      sections: ["state", "notes"],
      days: 30,
      skipRepos: ["/a", "/b"],
      level: "smaller",
      encrypt: false,
    });
  });

  it("falls back to every age, the fast level and encryption", () => {
    expect(readChoice({ days: 14, level: "best", encrypt: "no" })).toEqual({ sections: [], skipRepos: [], level: "fast", encrypt: true });
    expect(readChoice(null)).toBeUndefined();
    expect(readChoice("all")).toBeUndefined();
  });
});
