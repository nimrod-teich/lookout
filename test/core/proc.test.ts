import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  createProcessTable,
  LinuxProcessFinder,
  parseProcStat,
  parsePsProcessList,
  parseWindowsProcessList,
  SnapshotProcessTable,
  type ProcessInfo,
} from "../../src/core/proc";
import { FakeProc } from "./helpers";

describe("parseProcStat", () => {
  it("reads ppid and start time past a comm with spaces and parentheses", () => {
    const line = "42 (my (odd) name) S 7 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 1000 10 18446744073709551615";
    expect(parseProcStat(line)).toEqual({ ppid: 7, startTicks: "987654" });
  });

  it("rejects text that is not a stat line", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("42 (x) S")).toBeNull();
  });
});

describe("parseWindowsProcessList", () => {
  it("reads pid, parent and creation time, tolerating CRLF and noise", () => {
    const table = parseWindowsProcessList("0,0,0\r\n4,0,134352694335107920\r\n13828,13820,134352736508730940\r\n\r\nGet-CimInstance : something failed\r\n");
    expect([...table.keys()]).toEqual([0, 4, 13828]);
    expect(table.get(0)).toEqual({ ppid: 0, startedMs: undefined });
    expect(table.get(13828)?.ppid).toBe(13820);
    // FILETIME 134352736508730940 is 2026-09-30T20:27:30.873Z (checked with [DateTime]::FromFileTimeUtc).
    expect(new Date(table.get(13828)!.startedMs!).toISOString()).toBe("2026-09-30T20:27:30.873Z");
  });
});

describe("parsePsProcessList", () => {
  it("reads pid, parent and start time", () => {
    const table = parsePsProcessList("    1     0 Thu Oct  1 08:00:00 2026\n  345     1 Thu Oct  1 12:34:56 2026\ngarbage\n");
    expect(table.get(345)).toEqual({ ppid: 1, startedMs: Date.UTC(2026, 9, 1, 12, 34, 56) });
    expect(table.size).toBe(2);
  });
});

describe("ancestorsOf", () => {
  it("lists parents nearest first and stops at the root", () => {
    const proc = new FakeProc();
    proc.procs.set(30, { ppid: 20 }).set(20, { ppid: 10 }).set(10, { ppid: 0 });
    expect(ancestorsOf(proc, 30)).toEqual([20, 10]);
  });

  it("stops where the parent is unknown and never loops", () => {
    const proc = new FakeProc();
    proc.procs.set(30, { ppid: 20 }).set(20, {});
    expect(ancestorsOf(proc, 30)).toEqual([20]);
    proc.procs.set(1, { ppid: 2 }).set(2, { ppid: 1 });
    expect(ancestorsOf(proc, 1)).toEqual([2, 1]);
    expect(ancestorsOf(proc, 999)).toEqual([]);
  });
});

describe("SnapshotProcessTable", () => {
  function setup() {
    let now = 100_000;
    let lists = 0;
    const rows = new Map<number, ProcessInfo>([[7, { ppid: 3, startedMs: 5 }]]);
    const alive = new Set([7, 8]);
    const table = new SnapshotProcessTable(
      {
        list: async () => {
          lists++;
          return "";
        },
        parse: () => new Map(rows),
      },
      (pid) => alive.has(pid),
      () => now,
    );
    let updates = 0;
    table.onDidUpdate = () => updates++;
    return { table, rows, alive, advance: (ms: number) => (now += ms), lists: () => lists, updates: () => updates };
  }

  it("reports a dead pid without listing processes", () => {
    const t = setup();
    expect(t.table.get(99)).toBeNull();
    expect(t.lists()).toBe(0);
  });

  it("returns empty details first, then the listed ones, and announces the update", async () => {
    const t = setup();
    expect(t.table.get(7)).toEqual({});
    await t.table.refresh();
    expect(t.table.get(7)).toEqual({ ppid: 3, startedMs: 5 });
    expect([t.lists(), t.updates()]).toEqual([1, 1]);
  });

  it("does not list processes again within the minimum interval", async () => {
    const t = setup();
    t.table.get(7);
    await t.table.refresh();
    // Alive but absent from the list: asks again, at most once per interval.
    t.table.get(8);
    t.table.get(8);
    await t.table.refresh();
    expect(t.lists()).toBe(1);
    t.advance(4_000);
    t.table.get(8);
    await t.table.refresh();
    expect(t.lists()).toBe(2);
  });

  it("reads the list again once it is old, because a pid can be reused", async () => {
    const t = setup();
    t.table.get(7);
    await t.table.refresh();
    t.advance(61_000);
    t.rows.set(7, { ppid: 44, startedMs: 9 });
    expect(t.table.get(7)).toEqual({ ppid: 3, startedMs: 5 });
    await t.table.refresh();
    expect(t.table.get(7)).toEqual({ ppid: 44, startedMs: 9 });
  });

  it("keeps working when the process list cannot be read", async () => {
    const table = new SnapshotProcessTable({ list: () => Promise.reject(new Error("no powershell")), parse: () => new Map() }, () => true);
    expect(table.get(7)).toEqual({});
    await table.refresh();
    expect(table.get(7)).toEqual({});
  });
});

describe("the process table of this platform", () => {
  it("knows this process, its parent, and that a far-off pid does not exist", async () => {
    const table = createProcessTable();
    table.get(process.pid);
    if (table instanceof SnapshotProcessTable) await table.refresh();
    const info = table.get(process.pid);
    expect(info?.ppid).toBe(process.ppid);
    if (info?.startedMs !== undefined) {
      expect(info.startedMs).toBeLessThanOrEqual(Date.now());
      expect(info.startedMs).toBeGreaterThan(Date.now() - 3_600_000);
    }
    expect(ancestorsOf(table, process.pid)[0]).toBe(process.ppid);
    expect(table.get(2_147_483_000)).toBeNull();
  }, 30_000);
});

// The Linux finder reads a /proc tree; Windows resolves the fake cwd symlink to a drive path.
describe.skipIf(process.platform === "win32")("LinuxProcessFinder", () => {
  /** A fake /proc with one process: its command line names the program, its thread name does not. */
  function fakeProc(comm: string, program: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-proc-"));
    fs.writeFileSync(path.join(root, "stat"), "cpu 1 2 3 4\nbtime 1700000000\n");
    const dir = path.join(root, "4242");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "comm"), comm + "\n");
    fs.writeFileSync(path.join(dir, "cmdline"), [program, "--allow-all-tools", ""].join("\0"));
    fs.writeFileSync(path.join(dir, "stat"), "4242 (" + comm + ") S 100 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 500 0 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25");
    fs.symlinkSync("/work/infra", path.join(dir, "cwd"));
    return root;
  }

  it("finds a program whose main thread is renamed, by its command line", () => {
    const root = fakeProc("MainThread", "/opt/copilot-linux-x64/copilot");
    const found = new LinuxProcessFinder("copilot", root, () => 1_000).find();
    expect(found).toEqual([{ pid: 4242, ppid: 100, args: ["/opt/copilot-linux-x64/copilot", "--allow-all-tools"], cwd: "/work/infra", startedMs: 1700000000000 + 500 * 10 }]);
  });

  it("skips a process whose command line names another program", () => {
    const root = fakeProc("copilot", "/usr/bin/node");
    expect(new LinuxProcessFinder("copilot", root, () => 1_000).find()).toEqual([]);
  });
});
