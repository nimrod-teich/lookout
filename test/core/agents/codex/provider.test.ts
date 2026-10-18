import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CodexProvider } from "../../../../src/core/agents/codex/provider";
import { quietFor } from "../../../../src/core/format";
import { buildView } from "../../../../src/core/model";
import type { NamedProcess, ProcessFinder } from "../../../../src/core/proc";
import { APPROVAL, ASKED_IN_REPLY, homeFile, IDLE, NOW, QUESTION, STARTED, tempCodexHome, WORKING } from "./fixtures";

class FakeFinder implements ProcessFinder {
  constructor(public processes: NamedProcess[] = []) {}
  find(): NamedProcess[] {
    return this.processes;
  }
}

function codex(pid: number, cwd: string, args: string[] = ["codex"], startedMs = STARTED): NamedProcess {
  return { pid, args, cwd, startedMs };
}

function setup(processes: NamedProcess[], writtenAt?: number) {
  const home = tempCodexHome(writtenAt);
  const finder = new FakeFinder(processes);
  return { home, finder, provider: new CodexProvider(home, finder) };
}

describe("CodexProvider", () => {
  it("is Codex", () => {
    const { provider } = setup([]);
    expect([provider.id, provider.label]).toEqual(["codex", "Codex"]);
  });

  it("reports each live session's state from the tail of its rollout", () => {
    const { provider } = setup([
      codex(11, "/work/a", ["codex", "What is 2+2?"]),
      codex(12, "/work/b", ["codex", "--sandbox", "read-only", "Run the shell command"]),
      codex(13, "/work/c"),
      codex(14, "/work/e"),
      codex(15, "/work/d"),
    ]);
    const byPid = new Map(provider.poll(NOW).map((s) => [s.pid, s]));
    expect(byPid.get(11)).toMatchObject({ agent: "codex", id: IDLE, status: "idle", title: "Answer 2+2", cwd: "/work/a", panel: false, model: "gpt-6.1-sol", contextWindow: 475_000 });
    expect(byPid.get(12)).toMatchObject({
      id: APPROVAL,
      status: "waiting",
      title: "Request approval for touch",
      reason: { kind: "permission", ask: "touch approval-test.txt", raw: "May I create approval-test.txt in the current directory?" },
      since: Date.parse("2026-10-18T12:05:13.540Z"),
      evidence: { source: "rollout tail", note: "a command that asked to leave the sandbox has no result yet" },
    });
    expect(byPid.get(13)).toMatchObject({ id: WORKING, status: "working", activity: "exec · sleep 25 && echo ok", since: Date.parse("2026-10-18T12:20:50.196Z") });
    expect(byPid.get(14)).toMatchObject({ id: QUESTION, status: "waiting", reason: { kind: "question", ask: "Which colour do you prefer, red or blue?", options: ["Red", "Blue"] } });
    expect(byPid.get(15)).toMatchObject({ id: ASKED_IN_REPLY, status: "idle", title: "Add hello line to README.md" });
    for (const session of byPid.values()) expect(session.evidence?.at).toBe(NOW - 60_000);
    expect(byPid.get(13)!.pulse!.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("says a working session went quiet once its rollout has been silent for 10 minutes", () => {
    // The turn started at 12:20:50 and the rollout was last written at 12:21.
    const writtenAt = Date.parse("2026-10-18T12:21:00.000Z");
    const { provider } = setup([codex(13, "/work/c")], writtenAt);
    const later = writtenAt + 14 * 60_000;
    const [session] = provider.poll(later);
    const view = buildView(session!, [], { hostPid: 1, terminalPids: new Set(), windows: new Map() });
    expect(view).toMatchObject({ state: "working", lastWriteAt: writtenAt });
    expect(quietFor(view, later)).toBe(14 * 60_000);
    expect(quietFor(view, writtenAt + 5 * 60_000)).toBeUndefined();
  });

  it("titles a session by its first prompt, cut to 60 characters, until Codex names the thread", () => {
    const { home, provider } = setup([codex(11, "/work/a")]);
    fs.writeFileSync(`${home}/session_index.jsonl`, "");
    expect(provider.poll(NOW)[0]?.title).toBe("What is 2+2? Answer with one word and do not run any comman…");
  });

  it("asks you a question when the last reply ends on one", () => {
    const { home, provider } = setup([codex(11, "/work/a")]);
    const at = "2026-10-18T12:25:00.000Z";
    fs.appendFileSync(
      homeFile(home, IDLE),
      [
        { timestamp: at, type: "event_msg", payload: { type: "task_started" } },
        { timestamp: at, type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "Done. Want me to open the PR?" }], phase: "final_answer" } } },
        { timestamp: at, type: "event_msg", payload: { type: "task_complete" } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    expect(provider.poll(NOW)[0]).toMatchObject({ status: "idle", question: { text: "Done. Want me to open the PR?" } });
  });

  it("follows a session as its rollout grows", () => {
    const { home, provider } = setup([codex(13, "/work/c")]);
    expect(provider.poll(NOW)[0]?.status).toBe("working");
    fs.appendFileSync(homeFile(home, WORKING), `${JSON.stringify({ timestamp: "2026-10-18T12:21:20.000Z", type: "event_msg", payload: { type: "task_complete" } })}\n`);
    expect(provider.poll(NOW)[0]).toMatchObject({ status: "idle", since: Date.parse("2026-10-18T12:21:20.000Z") });
  });

  it("lists a session with nothing sent yet as empty, and leaves out codex processes that are not sessions", () => {
    const { provider } = setup([codex(21, "/work/nothing-here"), codex(22, "/work/a", ["codex", "app-server", "--managed-daemon"]), codex(23, "/work/b", ["codex", "exec", "hi"])]);
    const sessions = provider.poll(NOW);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ pid: 21, status: "idle", empty: true, evidence: { source: "process", note: "nothing sent yet" } });
  });

  it("finds a resumed thread wherever it is filed", () => {
    const { home, provider } = setup([codex(31, "/somewhere/else", ["codex", "resume", APPROVAL], NOW - 60_000)]);
    // Written before the process started: only the id ties them.
    fs.utimesSync(homeFile(home, APPROVAL), (NOW - 120_000) / 1000, (NOW - 120_000) / 1000);
    expect(provider.poll(NOW)[0]).toMatchObject({ id: APPROVAL, status: "waiting" });
  });

  it("returns nothing, and reads nothing, when no codex runs", () => {
    const { provider } = setup([]);
    expect(provider.poll(NOW)).toEqual([]);
  });

  it("watches the sessions folder", () => {
    const { provider } = setup([]);
    const watcher = provider.watch(() => {});
    expect(watcher).toBeDefined();
    watcher?.dispose();
  });
});
