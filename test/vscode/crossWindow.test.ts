import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JumpMailbox } from "../../src/core/jumpMailbox";
import type { Command } from "../../src/core/osNotify";
import type { SessionView } from "../../src/core/types";
import { CrossWindowJumps, raiseWindow, type CrossWindowHost } from "../../src/vscode/crossWindow";
import type { Log } from "../../src/vscode/log";
import { view } from "./helpers";
import { stub } from "./stub-vscode";

const SELF = 100;
const OTHER = 200;
const WAIT = { timeout: 5_000, interval: 20 };

const log: Log = { info: () => {}, errorOnce: () => {}, dispose: () => {} } as unknown as Log;

let dir: string;
let jumps: CrossWindowJumps[];

function window(overrides: Partial<CrossWindowHost> = {}): CrossWindowJumps {
  const host: CrossWindowHost = { pid: SELF, dir, find: () => undefined, reveal: async () => true, raise: async () => true, log, ...overrides };
  const jumps_ = new CrossWindowJumps(host);
  jumps.push(jumps_);
  return jumps_;
}

beforeEach(() => {
  stub.reset();
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lookout-xw-")), "windows");
  jumps = [];
});

afterEach(() => {
  for (const j of jumps) j.dispose();
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe("CrossWindowJumps, answering", () => {
  it("brings the session asked for to the front, comes forward itself, and says so", async () => {
    const session = view({ id: "s1", host: "terminal", terminalPid: 70, title: "Wire the cache" });
    const revealed: SessionView[] = [];
    window({ find: (id) => (id === "s1" ? session : undefined), reveal: async (v) => (revealed.push(v), true), raise: async () => true });
    new JumpMailbox(dir).send(SELF, { sessionId: "s1", fromPid: OTHER }, Date.now());
    const replies = new JumpMailbox(dir);
    let answer: unknown;
    await vi.waitFor(() => {
      answer ??= replies.takeReplies(OTHER, Date.now())[0];
      expect(answer).toMatchObject({ sessionId: "s1", fromPid: SELF, found: true, raised: true });
    }, WAIT);
    expect(revealed).toEqual([session]);
  });

  it("does not act on a request too old to be waited on", async () => {
    const reveal = vi.fn(async () => true);
    window({ find: () => view({ id: "s1", host: "terminal", terminalPid: 70 }), reveal });
    const mail = new JumpMailbox(dir);
    mail.send(SELF, { sessionId: "s1", fromPid: OTHER }, Date.now() - 2_500);
    await vi.waitFor(() => expect(fs.readdirSync(dir).filter((name) => name.startsWith("jump-"))).toEqual([]), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reveal).not.toHaveBeenCalled();
    expect(mail.takeReplies(OTHER, Date.now())).toEqual([]);
  });

  it("answers that a session it does not host is not here, without bringing anything forward", async () => {
    const raise = vi.fn(async () => true);
    window({ find: (id) => (id === "s2" ? view({ id: "s2", host: "window", windowPid: 300 }) : undefined), raise });
    const mail = new JumpMailbox(dir);
    mail.send(SELF, { sessionId: "gone", fromPid: OTHER }, Date.now());
    mail.send(SELF, { sessionId: "s2", fromPid: OTHER }, Date.now());
    const answers: unknown[] = [];
    await vi.waitFor(() => {
      answers.push(...mail.takeReplies(OTHER, Date.now()));
      expect(answers).toHaveLength(2);
    }, WAIT);
    expect(answers).toMatchObject([{ sessionId: "gone", found: false, raised: false }, { sessionId: "s2", found: false, raised: false }]);
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("CrossWindowJumps, seen", () => {
  it("tells each window that hosts sessions the user marked seen here, in one note per window", () => {
    const jumps_ = window();
    jumps_.markSeen([view({ id: "s1", host: "window", windowPid: OTHER }), view({ id: "s2", host: "window", windowPid: 300 }), view({ id: "s3", host: "window", windowPid: OTHER }), view({ id: "s4", host: "window" })]);
    const mail = new JumpMailbox(dir);
    expect(mail.takeSeen(OTHER, Date.now())).toEqual([expect.objectContaining({ ids: ["s1", "s3"], fromPid: SELF })]);
    expect(mail.takeSeen(300, Date.now())).toEqual([expect.objectContaining({ ids: ["s2"], fromPid: SELF })]);
  });

  it("hands the sessions another window marked seen to this window, which keeps their marks", async () => {
    const seen: (readonly string[])[] = [];
    window({ seen: (ids) => seen.push(ids) });
    new JumpMailbox(dir).sendSeen(SELF, { ids: ["s1"], fromPid: OTHER }, Date.now());
    await vi.waitFor(() => expect(seen).toEqual([["s1"]]), WAIT);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("seen-"))).toEqual([]);
  });
});

describe("CrossWindowJumps, asking", () => {
  /** Plays the other window: takes its requests and answers them. */
  function answerAs(pid: number, answer: { found: boolean; raised: boolean }): () => void {
    const mail = new JumpMailbox(dir);
    const timer = setInterval(() => {
      for (const request of mail.takeRequests(pid, Date.now())) mail.reply(request.fromPid, { sessionId: request.sessionId, fromPid: pid, ...answer }, Date.now());
    }, 50);
    return () => clearInterval(timer);
  }

  it("sends the jump to the window that hosts the session, and reports how it went", async () => {
    const jumps_ = window();
    const target = view({ id: "s1", host: "window", windowPid: OTHER, windowLabel: "api" });
    let stop = answerAs(OTHER, { found: true, raised: true });
    expect(await jumps_.request(target)).toBe("raised");
    stop();
    stop = answerAs(OTHER, { found: true, raised: false });
    expect(await jumps_.request(target)).toBe("opened");
    stop();
    stop = answerAs(OTHER, { found: false, raised: false });
    expect(await jumps_.request(target)).toBe("not found");
    stop();
  });

  it("gives up after six seconds without an answer, and takes its request back so the other window does not act on it after all", async () => {
    const jumps_ = window();
    const started = Date.now();
    expect(await jumps_.request(view({ id: "s1", host: "window", windowPid: OTHER }))).toBe("no answer");
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_900);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("jump-"))).toEqual([]);
    expect(await jumps_.request(view({ id: "s1", host: "window" }))).toBe("not sent");
  }, 15_000);

  it("waits for the same answer when asked again meanwhile, and sends one request", async () => {
    const jumps_ = window();
    const mail = new JumpMailbox(dir);
    let requests = 0;
    const timer = setInterval(() => {
      for (const request of mail.takeRequests(OTHER, Date.now())) {
        requests++;
        // A slow window: it answers after a second.
        setTimeout(() => mail.reply(request.fromPid, { sessionId: request.sessionId, fromPid: OTHER, found: true, raised: true }, Date.now()), 1_000);
      }
    }, 50);
    try {
      const target = view({ id: "s1", host: "window", windowPid: OTHER });
      const first = jumps_.request(target);
      const second = jumps_.request(target);
      expect(second).toBe(first);
      expect(await first).toBe("raised");
      expect(requests).toBe(1);
    } finally {
      clearInterval(timer);
    }
  });
});

describe("raiseWindow", () => {
  const app = { title: "app", app: "Visual Studio Code" };
  const none = { run: vi.fn(), capture: vi.fn() };

  it("is done when VS Code's own focus command brings the window forward", async () => {
    stub.focused = false;
    stub.commands.set("workbench.action.focusWindow", () => {
      stub.focused = true;
      stub.focusChange.fire();
    });
    expect(await raiseWindow("linux", app, log, 3_000, none)).toBe(true);
    expect(none.run).not.toHaveBeenCalled();
  });

  it("then tries the desktop's tools, a listed window by its id, and says whether the window came forward", async () => {
    stub.focused = false;
    stub.commands.set("workbench.action.focusWindow", () => undefined);
    const tried: string[] = [];
    const failing = {
      run: async (command: Command) => (tried.push(command.args.join(" ")), { ok: false, failure: "exit 1", ms: 1 }),
      capture: async () => ({ ok: true, ms: 1, output: "0x03a00007  0 box index.ts - app - Visual Studio Code\n" }),
    };
    expect(await raiseWindow("linux", app, log, 3_000, failing)).toBe(false);
    expect(tried).toEqual(["search --onlyvisible --name (^|] | - )app - (.* - )?Visual Studio Code$ windowactivate", "-i -a 0x03a00007"]);
    const working = {
      run: async () => {
        setTimeout(() => {
          stub.focused = true;
          stub.focusChange.fire();
        }, 10);
        return { ok: true, ms: 1 };
      },
      capture: none.capture,
    };
    expect(await raiseWindow("linux", app, log, 3_000, working)).toBe(true);
  });

  it("keeps to its budget, however slow the tools", async () => {
    stub.focused = false;
    stub.commands.set("workbench.action.focusWindow", () => undefined);
    const timeouts: number[] = [];
    const slow = {
      run: async (_command: Command, timeoutMs: number) => {
        timeouts.push(timeoutMs);
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        return { ok: false, failure: "timed out", ms: timeoutMs };
      },
      capture: async (_command: Command, timeoutMs: number) => {
        timeouts.push(timeoutMs);
        return { ok: false, failure: "timed out", ms: timeoutMs, output: "" };
      },
    };
    const started = Date.now();
    expect(await raiseWindow("linux", app, log, 1_500, slow)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_800);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(1_500);
  });

  it("does nothing when the window is already in front", async () => {
    stub.focused = true;
    expect(await raiseWindow("wsl", app, log, 3_000, none)).toBe(true);
    expect(stub.ops.some(([target, command]) => target === "commands" && command === "workbench.action.focusWindow")).toBe(false);
  });
});
