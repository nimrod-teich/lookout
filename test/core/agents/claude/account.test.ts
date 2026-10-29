import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { accountFile, accountNames, describeDirs, emailKey, parseAccount } from "../../../../src/core/agents/claude/account";
import type { ClaudeDir } from "../../../../src/core/agents/claude/paths";
import { tempConfigDir } from "../../helpers";

const OAUTH = {
  accountUuid: "acc-1",
  emailAddress: "someone@example.com",
  displayName: "Someone",
  organizationName: "Someone's Organization",
  organizationUuid: "org-1",
  billingType: "stripe_subscription",
  seatTier: null,
  hasExtraUsageEnabled: false,
};

describe("parseAccount", () => {
  it("reads who the directory is signed in as", () => {
    expect(parseAccount({ oauthAccount: OAUTH, cachedUsageUtilization: {} })).toStrictEqual({
      uuid: "acc-1",
      email: "someone@example.com",
      displayName: "Someone",
      organizationName: "Someone's Organization",
      organizationUuid: "org-1",
      billingType: "stripe_subscription",
    });
    expect(parseAccount({ oauthAccount: { accountUuid: "acc-2", seatTier: "max_20x" } })).toStrictEqual({ uuid: "acc-2", seatTier: "max_20x" });
  });

  it("finds no account without an account id", () => {
    expect(parseAccount({})).toBeUndefined();
    expect(parseAccount({ oauthAccount: null })).toBeUndefined();
    expect(parseAccount({ oauthAccount: { emailAddress: "someone@example.com" } })).toBeUndefined();
    expect(parseAccount({ oauthAccount: { accountUuid: "" } })).toBeUndefined();
    expect(parseAccount("nope")).toBeUndefined();
    expect(parseAccount(null)).toBeUndefined();
  });
});

describe("accountFile", () => {
  it("reads the account when the file changes, and keeps it through a torn write", () => {
    const file = path.join(tempConfigDir(), ".claude.json");
    const account = accountFile(file);
    expect(account.read()).toBeUndefined();

    fs.writeFileSync(file, JSON.stringify({ oauthAccount: OAUTH }));
    expect(account.read()?.uuid).toBe("acc-1");

    fs.writeFileSync(file, '{"oauthAccount": {"accountUuid": "acc-');
    expect(account.read()?.uuid).toBe("acc-1");

    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { ...OAUTH, accountUuid: "acc-2" } }));
    expect(account.read()?.uuid).toBe("acc-2");

    // Signed out: the file stays, the account goes.
    fs.writeFileSync(file, JSON.stringify({ numStartups: 3 }));
    expect(account.read()).toBeUndefined();

    // Still broken once it settled: no account, rather than the last one.
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: OAUTH }));
    expect(account.read()?.uuid).toBe("acc-1");
    fs.writeFileSync(file, "{ not json");
    const settled = new Date(Date.now() - 10_000);
    fs.utimesSync(file, settled, settled);
    expect(account.read()).toBeUndefined();

    fs.rmSync(file);
    expect(account.read()).toBeUndefined();
  });
});

describe("describeDirs", () => {
  const dir = (label: string, at: string): ClaudeDir => ({ dir: at, resolved: at, label, isDefault: label === "default" });
  const work = dir("default", "/home/u/.claude");
  const personal = dir("personal", "/home/u/.claude-personal");
  const spare = dir("spare", "/home/u/.claude-spare");

  it("says nothing more while one directory is watched", () => {
    expect(describeDirs([work], [{ uuid: "acc-1" }])).toEqual([]);
  });

  it("names each directory, and those with no sign-in or a shared one, by label only", () => {
    const lines = describeDirs([work, personal, spare], [{ uuid: "acc-1", email: "work@example.com" }, undefined, { uuid: "acc-1", email: "work@example.com" }]);
    expect(lines).toEqual([
      "Watching Claude Code in 3 directories: default (/home/u/.claude), personal (/home/u/.claude-personal), spare (/home/u/.claude-spare)",
      "Claude Code directory personal has no sign-in yet",
      "Claude Code directories default and spare are signed in to the same account",
    ]);
    expect(lines.join("\n")).not.toContain("@");
    expect(describeDirs([work, personal], [{ uuid: "acc-1" }, { uuid: "acc-2" }])).toHaveLength(1);
  });
});

describe("account names", () => {
  it("keys an address by a hash, the same whatever its case, never the address", () => {
    expect(emailKey("You@Work.example ")).toBe(emailKey("you@work.example"));
    expect(emailKey("you@work.example")).not.toBe(emailKey("you@home.example"));
    expect(emailKey("you@work.example")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reads the setting's names by address, trimmed, with dashes for spaces, and drops the rest", () => {
    const names = accountNames({ "You@Work.example": " my work ", "you@home.example": "home", "x@y.example": "  ", " ": "blank", "z@y.example": 3 });
    expect([...names.entries()]).toEqual([
      [emailKey("you@work.example"), "my-work"],
      [emailKey("you@home.example"), "home"],
    ]);
    expect(accountNames(undefined).size).toBe(0);
    expect(accountNames(["you@work.example"]).size).toBe(0);
  });
});
