import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CopilotProvider } from "../../../../src/core/agents/copilot/provider";
import type { NamedProcess, ProcessFinder } from "../../../../src/core/proc";
import { parseQuery } from "../../../../src/core/terms";
import { FakeProc } from "../../helpers";
import { ANSWERED, ASKING, events, FIXTURES, lines, NOW, STARTED, tempCopilotHome, writeOpen } from "./fixtures";

function finder(pids: number[]): ProcessFinder {
  return { find: (): NamedProcess[] => pids.map((pid) => ({ pid, args: ["copilot"], startedMs: STARTED })) };
}

function setup(pids: number[], working?: Record<string, boolean>) {
  const home = tempCopilotHome(working);
  return { home, provider: new CopilotProvider(home, finder(pids), new FakeProc(), () => NOW) };
}

describe("CopilotProvider", () => {
  it("is Copilot", () => {
    const { provider } = setup([]);
    expect([provider.id, provider.label]).toEqual(["copilot", "Copilot"]);
  });

  it("lists the sessions whose lock names a running copilot process, idle or waiting on an approval", () => {
    const { provider } = setup([4001, 4002], { [ANSWERED]: false, [ASKING]: true });
    const byId = new Map(provider.poll(NOW).map((s) => [s.id, s]));
    expect(byId.get(ANSWERED)).toMatchObject({ agent: "copilot", pid: 4001, status: "idle", title: "Answer Simple Math Question", cwd: "/work/a", panel: false, model: "mai-code-1.1-flash", evidence: { source: "session file" } });
    expect(byId.get(ASKING)).toMatchObject({
      pid: 4002,
      status: "waiting",
      reason: { kind: "permission", ask: "touch approval-test.txt", raw: "Create approval-test.txt" },
      since: Date.parse("2026-10-18T13:12:43.613Z"),
      evidence: { source: "transcript", note: "an approval Copilot asked for has no answer yet" },
      contextWindow: 272_000,
    });
    expect(byId.get(ASKING)!.spend).toMatchObject({ costUsd: undefined, basis: expect.stringMatching(/premium requests/) });
  });

  it("works while Copilot's flag says so, on the tool it runs", () => {
    const { home, provider } = setup([4002], { [ASKING]: true });
    fs.writeFileSync(events(home, ASKING), lines(events(home, ASKING)).slice(0, 17).join("\n") + "\n");
    expect(provider.poll(NOW)[0]).toMatchObject({ status: "working", activity: "bash · touch approval-test.txt", since: Date.parse("2026-10-18T13:12:41.148Z") });
  });

  it("without a flag, reads working or idle from the events, and says so", () => {
    const { home, provider } = setup([4001]);
    expect(provider.poll(NOW)[0]).toMatchObject({ status: "idle", evidence: { source: "transcript", note: "Copilot's open-sessions file has no entry for it" } });
    fs.appendFileSync(events(home, ANSWERED), JSON.stringify({ type: "user.message", data: { content: "And 3+3?" }, timestamp: "2026-10-18T13:15:00.000Z" }) + "\n");
    expect(provider.poll(NOW)[0]?.status).toBe("working");
  });

  it("leaves out a session whose process ended, one Copilot runs for an editor, and lists one with nothing sent as empty", () => {
    const { home, provider } = setup([4001], { [ANSWERED]: false });
    expect(provider.poll(NOW).map((s) => s.id)).toEqual([ANSWERED]);
    fs.writeFileSync(path.join(home, "session-state", ANSWERED, "workspace.yaml"), "id: x\ncwd: /work/a\nclient_name: vscode\n");
    expect(provider.poll(NOW)).toEqual([]);
    const fresh = path.join(home, "session-state", "aaaaaaaa-0000-4000-8000-000000000000");
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, "workspace.yaml"), "id: aaaaaaaa-0000-4000-8000-000000000000\ncwd: /work/c\nclient_name: github/cli\n");
    fs.writeFileSync(path.join(fresh, "events.jsonl"), lines(events(home, ANSWERED))[0] + "\n");
    fs.writeFileSync(path.join(fresh, "inuse.4001.lock"), "4001");
    writeOpen(home, { "aaaaaaaa-0000-4000-8000-000000000000": false });
    expect(provider.poll(NOW)).toEqual([expect.objectContaining({ id: "aaaaaaaa-0000-4000-8000-000000000000", status: "idle", empty: true })]);
  });

  it("lists the sessions that are not running, resumable with copilot --resume in the window's folders", () => {
    const { provider } = setup([4001], { [ANSWERED]: false });
    provider.poll(NOW);
    const list = provider.past({ folders: ["/work/b"], all: true, limit: 500 }, new Set([ANSWERED]));
    expect(list.sessions).toEqual([{ agent: "copilot", id: ASKING, cwd: "/work/b", title: "Run Shell Command to Create File", resumable: true, modifiedAt: expect.any(Number) }]);
    expect(provider.resumeCommand(ASKING)).toEqual({ args: ["copilot", "--resume", ASKING], cwd: "/work/b" });
    expect(provider.past({ folders: ["/work/x"], all: false, limit: 500 }, new Set()).sessions).toEqual([]);
  });

  it("searches live and earlier sessions, file: by the paths Copilot's tools named, and gives their conversation", () => {
    const { home, provider } = setup([4001], { [ANSWERED]: false });
    fs.copyFileSync(path.join(FIXTURES, "extra", "edited.jsonl"), events(home, ASKING));
    provider.poll(NOW);
    provider.past({ folders: [], all: true, limit: 500 }, new Set());
    const search = (q: string) => provider.search(parseQuery(q, NOW, 0), 3, 10_000).results.map((r) => [r.id, r.count]);
    expect(search("four")).toEqual([[ANSWERED, 1]]);
    expect(search("file:notes.md")).toEqual([[ASKING, 0]]);
    expect(search("created project:b")).toEqual([[ASKING, 2]]);
    expect(provider.history(ANSWERED)?.map((m) => m.role)).toEqual(["you", "agent"]);
  });

  it("watches the session folders and the open-sessions file", () => {
    const { provider } = setup([]);
    const watcher = provider.watch(() => {});
    expect(watcher).toBeDefined();
    watcher?.dispose();
  });

  it("ties a resumed session to the process that resumes it before Copilot writes its lock", () => {
    const { home } = setup([]);
    fs.rmSync(path.join(home, "session-state", ASKING, "inuse.4002.lock"));
    const resuming: ProcessFinder = { find: () => [{ pid: 4100, args: ["copilot", "--resume", ASKING], startedMs: STARTED }] };
    const provider = new CopilotProvider(home, resuming, new FakeProc(), () => NOW);
    expect(provider.poll(NOW)).toEqual([expect.objectContaining({ id: ASKING, pid: 4100 })]);
  });
});
