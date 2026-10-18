import { describe, expect, it } from "vitest";
import { lockedThread } from "../../../../src/core/agents/codex/paths";
import { invocationOf, serverOf } from "../../../../src/core/agents/codex/process";

const ID = "01a14ee6-c111-70e2-9f36-f32a6f1197e4";

describe("which codex processes serve threads", () => {
  it("tells an editor's app-server, the terminal sessions' daemon and an exec run apart", () => {
    expect(serverOf(["/ext/openai.chatgpt/bin/linux-x86_64/codex", "-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"])).toBe("app-server");
    expect(serverOf(["/home/u/.codex/packages/app-server-daemon/bin/codex", "app-server", "--listen", "unix://", "--managed-daemon"])).toBe("daemon");
    expect(serverOf(["codex", "app-server", "daemon", "pid-update-loop"])).toBe("daemon");
    expect(serverOf(["codex", "exec", "summarise the changes"])).toBe("exec");
    expect(serverOf(["codex", "-m", "gpt-6.1-sol", "e", "fix it"])).toBe("exec");
    expect(serverOf(["codex"])).toBeUndefined();
    expect(serverOf(["codex", "resume", ID])).toBeUndefined();
    expect(serverOf(["codex", "--help"])).toBeUndefined();
  });

  it("reads the thread a held file locks", () => {
    expect(lockedThread(`/home/u/.codex/thread-writer-locks/${ID}.lock`)).toBe(ID);
    expect(lockedThread(`C:\\Users\\u\\.codex\\thread-writer-locks\\${ID.toUpperCase()}.lock`)).toBe(ID);
    expect(lockedThread(`/home/u/.codex/sessions/2026/10/18/rollout-2026-10-18T15-05-07-${ID}.jsonl`)).toBeUndefined();
    expect(lockedThread("/home/u/.codex/thread-writer-locks/.coordination.lock")).toBeUndefined();
  });
});

describe("which codex processes are sessions", () => {
  it("counts the interactive program, with or without a prompt and options", () => {
    expect(invocationOf(["codex"])).toEqual({ session: true, cd: undefined });
    expect(invocationOf(["/home/u/.local/bin/codex", "What is 2+2?"]).session).toBe(true);
    expect(invocationOf(["codex", "--sandbox", "read-only", "-a", "on-request", "Run the tests"]).session).toBe(true);
    expect(invocationOf(["codex", "-m", "exec", "fix it"]).session).toBe(true);
    expect(invocationOf(["codex", "-C", "/work/api", "fix it"])).toEqual({ session: true, cd: "/work/api" });
    expect(invocationOf(["codex", "--cd=/work/web"])).toEqual({ session: true, cd: "/work/web" });
  });

  it("names the thread `codex resume <id>` continues, and counts a fork or a resume by picker as a session", () => {
    expect(invocationOf(["codex", "resume", ID])).toEqual({ session: true, resumeId: ID, cd: undefined });
    expect(invocationOf(["codex", "resume", ID.toUpperCase(), "go on"]).resumeId).toBe(ID);
    expect(invocationOf(["codex", "resume", "--last"])).toEqual({ session: true, resumeId: undefined, cd: undefined });
    expect(invocationOf(["codex", "resume", "my-session-name"]).resumeId).toBeUndefined();
    expect(invocationOf(["codex", "fork", ID])).toEqual({ session: true, resumeId: undefined, cd: undefined });
  });

  it("leaves out the app server, the daemon, one-shot commands and tooling", () => {
    expect(invocationOf(["codex", "-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"]).session).toBe(false);
    expect(invocationOf(["codex", "app-server", "--listen", "unix://", "--managed-daemon"]).session).toBe(false);
    expect(invocationOf(["codex", "app-server", "daemon", "pid-update-loop"]).session).toBe(false);
    for (const sub of ["exec", "e", "review", "login", "mcp", "mcp-server", "agents", "doctor", "cloud", "apply"]) expect(invocationOf(["codex", sub, "x"]).session, sub).toBe(false);
    expect(invocationOf(["codex", "--version"]).session).toBe(false);
  });
});
