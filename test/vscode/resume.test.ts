import { beforeEach, describe, expect, it } from "vitest";
import { resumeInTerminal, shellArg } from "../../src/vscode/resume";
import { stub } from "./stub-vscode";

describe("resuming a session in a terminal", () => {
  beforeEach(() => stub.reset());

  it("opens a terminal named after the agent and the session, in its folder, and runs the agent's resume there", () => {
    resumeInTerminal("codex", "Answer 2+2", { args: ["codex", "resume", "01a14ee5-6f70-7b02-a9cb-7ad01294b026"], cwd: "/work/a" });
    expect(stub.ops).toEqual([
      ["terminal:Codex: Answer 2+2", "create", { name: "Codex: Answer 2+2", cwd: "/work/a" }],
      ["terminal:Codex: Answer 2+2", "sendText", { text: "codex resume 01a14ee5-6f70-7b02-a9cb-7ad01294b026", addNewLine: true }],
      ["terminal:Codex: Answer 2+2", "show", false],
    ]);
  });

  it("quotes an argument a shell would read otherwise", () => {
    expect(["codex", "resume", "01a1-ff", "it's done; rm -rf /", "a b"].map(shellArg)).toEqual(["codex", "resume", "01a1-ff", "'it'\\''s done; rm -rf /'", "'a b'"]);
  });
});
