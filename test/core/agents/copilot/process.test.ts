import { describe, expect, it } from "vitest";
import { resumeIdOf } from "../../../../src/core/agents/copilot/process";

const ID = "6b9a4611-c20f-4706-89db-70409176bed6";

describe("resumeIdOf", () => {
  it("reads the session copilot --resume names, in each spelling", () => {
    expect(resumeIdOf(["copilot", "--resume", ID])).toBe(ID);
    expect(resumeIdOf(["/x/copilot", `--resume=${ID.toUpperCase()}`])).toBe(ID);
    expect(resumeIdOf(["copilot", "-r", ID, "-i", "go on"])).toBe(ID);
  });

  it("has none for a fresh session, --continue, or a resume by picker", () => {
    expect(resumeIdOf(["copilot", "-i", "Run the tests"])).toBeUndefined();
    expect(resumeIdOf(["copilot", "--continue"])).toBeUndefined();
    expect(resumeIdOf(["copilot", "--resume"])).toBeUndefined();
  });
});
