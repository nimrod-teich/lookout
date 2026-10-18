import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinuxProcessFinder, parseLsofCwd, parseLsofFiles, parsePsNamedProcesses, parseWindowsNamedProcesses, programName, SnapshotProcessFinder, splitCommandLine } from "../../src/core/proc";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake `/proc` with the given processes. */
function fakeProc(processes: { pid: number; comm: string; args: string[]; cwd?: string; ppid?: number; ticks?: number }[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-proc-"));
  dirs.push(root);
  fs.writeFileSync(path.join(root, "stat"), "cpu  1 2 3\nbtime 1792300000\n");
  fs.mkdirSync(path.join(root, "self"));
  for (const p of processes) {
    const dir = path.join(root, String(p.pid));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "comm"), `${p.comm}\n`);
    fs.writeFileSync(path.join(dir, "cmdline"), `${p.args.join("\0")}\0`);
    const fields = ["S", String(p.ppid ?? 1), ...new Array(17).fill("0"), String(p.ticks ?? 500)];
    fs.writeFileSync(path.join(dir, "stat"), `${p.pid} (${p.comm}) ${fields.join(" ")} 0 0\n`);
    if (p.cwd) fs.symlinkSync(p.cwd, path.join(dir, "cwd"));
  }
  return root;
}

describe("finding a program's processes", () => {
  it("names a program by its last path segment, without .exe", () => {
    expect(["codex", "/home/u/.local/bin/codex", "C:\\Tools\\codex.exe", "codex.EXE", "/usr/bin/node"].map(programName)).toEqual(["codex", "codex", "codex", "codex", "node"]);
  });

  it("splits a Windows command line on whitespace outside quotes", () => {
    expect(splitCommandLine('"C:\\Program Files\\codex\\codex.exe" resume  01a1 "fix the build"')).toEqual(["C:\\Program Files\\codex\\codex.exe", "resume", "01a1", "fix the build"]);
    expect(splitCommandLine('codex.exe ""')).toEqual(["codex.exe", ""]);
  });

  it("reads Windows rows with their start time and command line, skipping noise", () => {
    expect(parseWindowsNamedProcesses('4120|880|134052694335107920|"C:\\bin\\codex.exe" resume abc\r\n\r\nGet-CimInstance : failed\r\n9|1|0|codex.exe')).toEqual([
      { pid: 4120, ppid: 880, args: ["C:\\bin\\codex.exe", "resume", "abc"], startedMs: Math.round(134052694335107920 / 10_000 - 11_644_473_600_000) },
      { pid: 9, ppid: 1, args: ["codex.exe"], startedMs: undefined },
    ]);
  });

  it("reads ps rows, keeping only the program's", () => {
    const text = ["  101     1 Sun Oct 18 12:03:38 2026 /Users/u/.local/bin/codex What is 2+2?", "  102   101 Sun Oct  4 09:00:00 2026 node /usr/lib/codex.js", " 103 1 Sun Oct 18 12:04:00 2026 codex resume 01a1"].join("\n");
    expect(parsePsNamedProcesses(text, "codex")).toEqual([
      { pid: 101, ppid: 1, args: ["/Users/u/.local/bin/codex", "What", "is", "2+2?"], startedMs: Date.parse("2026-10-18T12:03:38Z") },
      { pid: 103, ppid: 1, args: ["codex", "resume", "01a1"], startedMs: Date.parse("2026-10-18T12:04:00Z") },
    ]);
  });

  it("reads a process's directory from lsof", () => {
    expect(parseLsofCwd("p101\nfcwd\nn/work/app\n")).toBe("/work/app");
    expect(parseLsofCwd("")).toBeUndefined();
  });

  // The fake /proc links each process's directory, which Windows does not let a test do.
  it.skipIf(process.platform === "win32")("on Linux, finds the program's processes in /proc with their arguments, directory and start", () => {
    const root = fakeProc([
      { pid: 11, comm: "codex", args: ["codex", "What is 2+2?"], cwd: "/work/a", ppid: 7, ticks: 500 },
      { pid: 12, comm: "node", args: ["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"] },
      { pid: 13, comm: "codex", args: ["/opt/other/codexify"] },
    ]);
    const finder = new LinuxProcessFinder("codex", root, () => 1_000);
    expect(finder.find()).toEqual([{ pid: 11, ppid: 7, args: ["codex", "What is 2+2?"], cwd: "/work/a", startedMs: 1792300000 * 1000 + 5000 }]);
  });

  it.skipIf(process.platform === "win32")("on Linux, looks again at most once a second", () => {
    const root = fakeProc([{ pid: 11, comm: "codex", args: ["codex"] }]);
    let now = 0;
    const finder = new LinuxProcessFinder("codex", root, () => now);
    expect(finder.find()).toHaveLength(1);
    fs.rmSync(path.join(root, "11"), { recursive: true });
    expect(finder.find()).toHaveLength(1);
    now = 1_000;
    expect(finder.find()).toHaveLength(0);
  });

  it("elsewhere, reads the list in the background, each new process's directory once, and says when it changed", async () => {
    const list = vi.fn(async () => [{ pid: 5, args: ["codex"], startedMs: 1 }]);
    const cwdOf = vi.fn(async () => "/work/app");
    let now = 0;
    const finder = new SnapshotProcessFinder(list, cwdOf, () => now);
    const updated = vi.fn();
    finder.onDidUpdate = updated;
    expect(finder.find()).toEqual([]);
    await finder.refresh();
    expect(finder.find()).toEqual([{ pid: 5, args: ["codex"], startedMs: 1, cwd: "/work/app" }]);
    expect(updated).toHaveBeenCalledTimes(1);
    now = 3_000;
    finder.find();
    await finder.refresh();
    expect(cwdOf).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
  });

  it("reads the files processes hold from lsof, by process", () => {
    const text = "p40\nfcwd\nn/opt/vscode\nf27\nn/home/u/.codex/thread-writer-locks/01a1.lock\np41\nf3\nn/dev/null\n";
    expect(parseLsofFiles(text)).toEqual(new Map([[40, ["/opt/vscode", "/home/u/.codex/thread-writer-locks/01a1.lock"]], [41, ["/dev/null"]]]));
    expect(parseLsofFiles("")).toEqual(new Map());
  });

  it.skipIf(process.platform === "win32")("on Linux, reads the files a process holds from /proc/<pid>/fd", () => {
    const root = fakeProc([{ pid: 40, comm: "codex", args: ["codex", "app-server"] }]);
    fs.mkdirSync(path.join(root, "40", "fd"));
    fs.symlinkSync("/home/u/.codex/thread-writer-locks/01a1.lock", path.join(root, "40", "fd", "27"));
    fs.symlinkSync("/dev/null", path.join(root, "40", "fd", "0"));
    const finder = new LinuxProcessFinder("codex", root, () => 1_000);
    expect(finder.heldFiles(40)?.sort()).toEqual(["/dev/null", "/home/u/.codex/thread-writer-locks/01a1.lock"]);
    expect(finder.heldFiles(41)).toBeUndefined();
  });

  it("elsewhere, reads the files the processes hold with each list when asked to, and none when not", async () => {
    const list = vi.fn(async () => [{ pid: 40, args: ["codex", "app-server"], startedMs: 1 }]);
    const filesOf = vi.fn(async (pids: number[]) => new Map(pids.map((pid) => [pid, [`/held/${pid}`]])));
    const finder = new SnapshotProcessFinder(list, undefined, () => 0, filesOf);
    await finder.refresh();
    expect(finder.heldFiles(40)).toEqual(["/held/40"]);
    expect(finder.heldFiles(41)).toEqual([]);
    expect(filesOf).toHaveBeenCalledWith([40]);
    const blind = new SnapshotProcessFinder(list, undefined, () => 0);
    await blind.refresh();
    expect(blind.heldFiles(40)).toBeUndefined();
  });
});
