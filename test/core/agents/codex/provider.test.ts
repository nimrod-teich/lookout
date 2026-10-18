import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CodexProvider } from "../../../../src/core/agents/codex/provider";
import { quietFor } from "../../../../src/core/format";
import { buildView } from "../../../../src/core/model";
import type { AgentHostSessions } from "../../../../src/core/agentHost";
import type { NamedProcess, ProcessFinder } from "../../../../src/core/proc";
import { parseQuery } from "../../../../src/core/terms";
import { addPanelThreads, APPROVAL, ASKED_IN_REPLY, EDITED, homeFile, IDLE, lockOf, NOW, PANEL_APPROVAL, PANEL_IDLE, QUESTION, STARTED, tempCodexHome, WORKING } from "./fixtures";

class FakeFinder implements ProcessFinder {
  /** `held`: the files each process holds; none given, the platform tells none, as on Windows. */
  constructor(
    public processes: NamedProcess[] = [],
    public held?: Map<number, string[]>,
  ) {}
  find(): NamedProcess[] {
    return this.processes;
  }
  heldFiles(pid: number): string[] | undefined {
    return this.held ? (this.held.get(pid) ?? []) : undefined;
  }
}

/** The VS Code extension's app-server, a child of the window's extension host, in VS Code's own folder. */
function appServer(pid: number): NamedProcess {
  return { pid, ppid: 900, args: ["/ext/openai.chatgpt/bin/linux-x86_64/codex", "-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"], cwd: "/opt/vscode", startedMs: STARTED };
}

/** VS Code's id for a session of its Chat. */
const VSCODE_ID = "ef8da9c5-e92c-412e-a5ec-8030c1d4cdd1";

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

  it("lists the threads that are not running, resumable in the window's folders, and says how many are compressed", () => {
    const { home, provider } = setup([codex(13, "/work/c")]);
    fs.writeFileSync(`${home}/sessions/2026/10/18/rollout-2026-10-01T10-00-00-01a10000-0000-7000-8000-000000000000.jsonl.zst`, "zstd");
    provider.poll(NOW);
    const list = provider.past({ folders: ["/work/a"], all: true, limit: 500 }, new Set([WORKING]));
    expect(list.sessions.map((s) => s.id)).not.toContain(WORKING);
    expect(list.sessions.find((s) => s.id === IDLE)).toMatchObject({ agent: "codex", title: "Answer 2+2", cwd: "/work/a", resumable: true });
    expect(list.sessions.find((s) => s.id === APPROVAL)).toMatchObject({ resumable: false });
    expect(list.notes).toEqual(["1 older Codex session is compressed (.jsonl.zst) and not listed or searched."]);
  });

  it("resumes a thread with codex resume, in the folder it worked in", () => {
    const { provider } = setup([]);
    provider.past({ folders: [], all: true, limit: 500 }, new Set());
    expect(provider.resumeCommand(IDLE)).toEqual({ args: ["codex", "resume", IDLE], cwd: "/work/a" });
    expect(provider.resumeCommand("01a10000-0000-7000-8000-00000000dead")).toBeUndefined();
  });

  it("searches what was said in live and earlier threads, narrowed by the operators", () => {
    const { provider } = setup([codex(13, "/work/c")]);
    provider.poll(NOW);
    provider.past({ folders: [], all: true, limit: 500 }, new Set([WORKING]));
    const search = (q: string) => provider.search(parseQuery(q, NOW, 0), 3, 10_000).results.map((r) => [r.id, r.count]);
    expect(search("four")).toEqual([[IDLE, 1]]);
    // The live session first, then the earlier ones.
    const approval = search("approval").map(([id]) => id);
    expect(approval[0]).toBe(WORKING);
    expect(approval.slice(1).sort()).toEqual([APPROVAL, ASKED_IN_REPLY].sort());
    // The prompt and Codex's note both say it.
    expect(search("approval project:b")).toEqual([[APPROVAL, 2]]);
    expect(search("file:notes.md")).toEqual([[EDITED, 0]]);
    expect(search("hello file:notes.md").map(([id]) => id)).toEqual([EDITED]);
    expect(search("four since:2026-10-19")).toEqual([]);
    expect(search("four before:2026-10-19")).toEqual([[IDLE, 1]]);
    // Codex records no branch: an earlier thread is never picked by one.
    expect(search("four branch:main")).toEqual([]);
  });

  it("gives the conversation of a live or an earlier thread, oldest first", () => {
    const { provider } = setup([codex(11, "/work/a")]);
    provider.poll(NOW);
    expect(provider.history(IDLE)?.map((m) => [m.role, m.text])).toEqual([
      ["you", "What is 2+2? Answer with one word and do not run any commands."],
      ["agent", "Four"],
    ]);
    provider.past({ folders: [], all: true, limit: 500 }, new Set([IDLE]));
    expect(provider.history(EDITED)?.[0]).toMatchObject({ role: "you", text: "Append a line saying hello to notes.md, then show me the file with cat." });
    expect(provider.history("nope")).toBeUndefined();
  });

  it("gives each session's tokens and their API-equivalent price, said to be Lookout's sum at list prices", () => {
    const { provider } = setup([codex(11, "/work/a")]);
    const spend = provider.poll(NOW)[0]!.spend!;
    expect(spend).toMatchObject({ input: 2_740, cacheRead: 12_160, cacheWrite: 0, output: 5, estimated: true, partial: false });
    expect(spend.costUsd).toBeCloseTo(0.006746, 9);
    expect(spend.basis).toMatch(/API list prices/);
  });

  it("reads the account's limits from the live sessions' rollouts", () => {
    const { provider } = setup([codex(11, "/work/a")]);
    provider.poll(NOW);
    expect(provider.usage(NOW)).toEqual({
      fetchedAt: Date.parse("2026-10-18T12:03:45.201Z"),
      meters: [
        { key: "session", label: "5h limit", windowMs: 5 * 3_600_000, percent: 0, resetsAt: 1792343023000 },
        { key: "weekly_all", label: "Weekly limit", windowMs: 168 * 3_600_000, percent: 0, resetsAt: 1792929823000 },
      ],
    });
  });

  it("with no session running, reads them from the newest rollout of the last week, and has none without one", () => {
    const { home, provider } = setup([]);
    // The working session's rollout, written last, recorded its limits last at 12:06:29 (it was copied mid-turn).
    fs.utimesSync(homeFile(home, WORKING), NOW / 1000, NOW / 1000);
    expect(provider.usage(NOW)?.fetchedAt).toBe(Date.parse("2026-10-18T12:06:29.128Z"));
    expect(provider.usage(NOW + 8 * 86_400_000)).toBeUndefined();
  });
});

describe("CodexProvider, threads held by an app-server or an exec run", () => {
  it("reports each thread the extension's app-server holds as a session of its panel, with its state", () => {
    const home = tempCodexHome();
    addPanelThreads(home);
    const finder = new FakeFinder([appServer(40)], new Map([[40, [lockOf(home, PANEL_APPROVAL), "/dev/null", lockOf(home, PANEL_IDLE), homeFile(home, PANEL_IDLE)]]]));
    const sessions = new CodexProvider(home, finder).poll(NOW);
    expect(sessions.map((s) => [s.id, s.pid, s.panel, s.status]).sort()).toEqual([
      [PANEL_IDLE, 40, true, "idle"],
      [PANEL_APPROVAL, 40, true, "waiting"],
    ]);
    expect(sessions.find((s) => s.id === PANEL_APPROVAL)).toMatchObject({
      title: "Create approval marker",
      cwd: "/work/panel",
      reason: { kind: "permission", ask: "touch ~/lookout-panel-approval.txt", raw: "May I create ~/lookout-panel-approval.txt outside the writable workspace?" },
      evidence: { source: "rollout tail" },
    });
    expect(sessions.find((s) => s.id === PANEL_IDLE)).toMatchObject({ title: "Calculate 2+2", model: "gpt-6.1-sol" });
  });

  it("leaves the terminal sessions' daemon to the terminals, and keeps a thread a process holds from a terminal", () => {
    const home = tempCodexHome();
    const daemon: NamedProcess = { pid: 50, args: ["/home/u/.codex/packages/app-server-daemon/bin/codex", "app-server", "--listen", "unix://", "--managed-daemon"], startedMs: STARTED };
    // The daemon still holds the thread of a terminal that ended, and of one that runs: the terminal's match stands.
    const viaDaemon = new CodexProvider(home, new FakeFinder([daemon, codex(11, "/work/a", ["codex", "What is 2+2?"])], new Map([[50, [lockOf(home, IDLE), lockOf(home, APPROVAL)]]]))).poll(NOW);
    expect(viaDaemon.map((s) => [s.id, s.pid])).toEqual([[IDLE, 11]]);
    // An exec run holds it: the run is its session, and the terminal in the same folder does not take it.
    const exec: NamedProcess = { pid: 60, args: ["codex", "exec", "What is 2+2?"], cwd: "/work/a", startedMs: STARTED };
    const viaExec = new CodexProvider(home, new FakeFinder([exec, codex(11, "/work/a")], new Map([[60, [lockOf(home, IDLE)]]]))).poll(NOW);
    expect(viaExec.find((s) => s.pid === 60)).toMatchObject({ id: IDLE, panel: false, status: "idle" });
    expect(viaExec.find((s) => s.pid === 11)).toMatchObject({ empty: true });
  });

  it("where held files cannot be read, takes the extension's threads written in the last 10 minutes, and no terminal's", () => {
    const home = tempCodexHome(NOW - 60_000);
    addPanelThreads(home, NOW - 60_000);
    const recent = new CodexProvider(home, new FakeFinder([appServer(40)])).poll(NOW);
    expect(recent.map((s) => [s.id, s.pid, s.panel]).sort()).toEqual([
      [PANEL_IDLE, 40, true],
      [PANEL_APPROVAL, 40, true],
    ]);
    const stale = tempCodexHome(NOW - 60_000);
    addPanelThreads(stale, NOW - 20 * 60_000);
    expect(new CodexProvider(stale, new FakeFinder([appServer(40)])).poll(NOW)).toEqual([]);
  });

  it("gives a thread VS Code's own Chat runs VS Code's address for it, live and earlier, and none to the extension's", () => {
    const home = tempCodexHome();
    addPanelThreads(home);
    // VS Code's agent host runs Codex's app-server and says so in the thread's originator.
    const file = homeFile(home, PANEL_APPROVAL);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"originator":"codex_vscode"', '"originator":"vscode_agent_host"'));
    fs.utimesSync(file, (NOW - 60_000) / 1000, (NOW - 60_000) / 1000);
    const asked: string[] = [];
    const agentHost = {
      idOf: (id: string) => {
        asked.push(id);
        return id === PANEL_APPROVAL ? VSCODE_ID : undefined;
      },
    } as unknown as AgentHostSessions;
    const finder = new FakeFinder([appServer(40)], new Map([[40, [lockOf(home, PANEL_APPROVAL), lockOf(home, PANEL_IDLE)]]]));
    const provider = new CodexProvider(home, finder, agentHost);
    const live = new Map(provider.poll(NOW).map((s) => [s.id, s]));
    expect(live.get(PANEL_APPROVAL)).toMatchObject({ panel: true, status: "waiting", vscodeSession: `agent-host-codex:/${VSCODE_ID}` });
    expect(live.get(PANEL_IDLE)?.vscodeSession).toBeUndefined();
    // Only VS Code's own threads are looked up.
    expect(asked).not.toContain(PANEL_IDLE);
    const past = new Map(new CodexProvider(home, new FakeFinder(), agentHost).past({ folders: ["/work"], all: false, limit: 50 }, new Set()).sessions.map((s) => [s.id, s]));
    expect(past.get(PANEL_APPROVAL)).toMatchObject({ resumesIn: "panel", vscodeSession: `agent-host-codex:/${VSCODE_ID}` });
    expect(past.get(PANEL_IDLE)).toMatchObject({ resumesIn: "panel" });
    expect(past.get(PANEL_IDLE)?.vscodeSession).toBeUndefined();
  });

  it("resumes an earlier thread of the extension in its panel, and a terminal's with codex resume", () => {
    const home = tempCodexHome();
    addPanelThreads(home);
    const provider = new CodexProvider(home, new FakeFinder());
    const past = provider.past({ folders: ["/work"], all: false, limit: 50 }, new Set());
    const byId = new Map(past.sessions.map((s) => [s.id, s]));
    expect(byId.get(PANEL_IDLE)).toMatchObject({ title: "Calculate 2+2", resumesIn: "panel", resumable: true });
    expect(provider.resumeCommand(PANEL_IDLE)).toBeUndefined();
    expect(byId.get(IDLE)?.resumesIn).toBeUndefined();
    expect(provider.resumeCommand(IDLE)).toEqual({ args: ["codex", "resume", IDLE], cwd: "/work/a" });
  });
});
