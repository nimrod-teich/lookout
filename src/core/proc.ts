import { execFile } from "node:child_process";
import * as fs from "node:fs";

export interface ProcessInfo {
  ppid?: number;
  /** Start time in clock ticks since boot (`/proc/<pid>/stat` field 22). Linux only. */
  startTicks?: string;
  /** Start time as epoch ms. */
  startedMs?: number;
}

export interface ProcessTable {
  /**
   * null when the process does not exist. The details are empty while the
   * platform's process list has not been read yet; `onDidUpdate` fires when
   * they arrive.
   */
  get(pid: number): ProcessInfo | null;
  /** This host's pid namespace in the `pidDomain` format of Claude Code session files. */
  pidDomain(): string | undefined;
  /** Set by the owner to learn that details that were missing are now known. */
  onDidUpdate?: () => void;
}

/** Parent pids of a process, nearest first, as far as they are known. */
export function ancestorsOf(table: ProcessTable, pid: number, limit = 32): number[] {
  const out: number[] = [];
  let current = pid;
  while (out.length < limit) {
    const ppid = table.get(current)?.ppid;
    if (ppid === undefined || ppid <= 0 || ppid === current || out.includes(ppid)) break;
    out.push(ppid);
    current = ppid;
  }
  return out;
}

/** Splits a `/proc/<pid>/stat` line. The comm field may contain spaces and parentheses. */
export function parseProcStat(text: string): ProcessInfo | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const rest = text.slice(close + 2).split(" ");
  const ppid = Number(rest[1]);
  const startTicks = rest[19];
  if (!Number.isInteger(ppid) || !startTicks) return null;
  return { ppid, startTicks };
}

/** Linux: every lookup is one small synchronous read of `/proc`. */
class LinuxProcessTable implements ProcessTable {
  private domain: string | undefined | null = null;

  get(pid: number): ProcessInfo | null {
    try {
      return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return null;
    }
  }

  pidDomain(): string | undefined {
    if (this.domain === null) {
      try {
        const machineId = fs.readFileSync("/etc/machine-id", "utf8").trim();
        this.domain = `linux:${machineId}:${fs.readlinkSync("/proc/self/ns/pid")}`;
      } catch {
        this.domain = undefined;
      }
    }
    return this.domain;
  }
}

const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;

/** Parses `pid,ppid,creation FILETIME` rows, the output of `WINDOWS_COMMAND`. */
export function parseWindowsProcessList(text: string): Map<number, ProcessInfo> {
  const table = new Map<number, ProcessInfo>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+),(\d+),(\d+)$/.exec(line.trim());
    if (!match) continue;
    const fileTime = Number(match[3]);
    table.set(Number(match[1]), {
      ppid: Number(match[2]),
      startedMs: fileTime > 0 ? Math.round(fileTime / 10_000 - FILETIME_EPOCH_OFFSET_MS) : undefined,
    });
  }
  return table;
}

/** Parses `ps -axo pid=,ppid=,lstart=` rows, printed with `LC_ALL=C TZ=UTC`. */
export function parsePsProcessList(text: string): Map<number, ProcessInfo> {
  const table = new Map<number, ProcessInfo>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const startedMs = Date.parse(`${match[3]} UTC`);
    table.set(Number(match[1]), { ppid: Number(match[2]), startedMs: Number.isFinite(startedMs) ? startedMs : undefined });
  }
  return table;
}

export interface ProcessListSource {
  /** Prints the platform's process list. */
  list(): Promise<string>;
  parse(text: string): Map<number, ProcessInfo>;
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

const WINDOWS_COMMAND =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }";

export const WINDOWS_SOURCE: ProcessListSource = {
  list: () => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_COMMAND]),
  parse: parseWindowsProcessList,
};

export const PS_SOURCE: ProcessListSource = {
  list: () => run("ps", ["-axo", "pid=,ppid=,lstart="], { ...process.env, LC_ALL: "C", TZ: "UTC" }),
  parse: parsePsProcessList,
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Listing processes starts a program; don't do it more often than this. */
const MIN_REFRESH_INTERVAL_MS = 3_000;
/** A pid can be reused; details older than this are read again. */
const MAX_SNAPSHOT_AGE_MS = 60_000;

/**
 * Platforms without `/proc`: liveness is a cheap signal-0 probe, and the
 * details come from a process list that is read in the background and cached.
 */
export class SnapshotProcessTable implements ProcessTable {
  onDidUpdate?: () => void;
  private snapshot = new Map<number, ProcessInfo>();
  private readAt = 0;
  private lastAttemptAt = 0;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly source: ProcessListSource,
    private readonly alive: (pid: number) => boolean = isAlive,
    private readonly now: () => number = Date.now,
  ) {}

  get(pid: number): ProcessInfo | null {
    if (!this.alive(pid)) return null;
    const info = this.snapshot.get(pid);
    if (!info || this.now() - this.readAt > MAX_SNAPSHOT_AGE_MS) void this.refresh();
    return info ?? {};
  }

  pidDomain(): string | undefined {
    return undefined;
  }

  /** Reads the process list unless a read is running or one ran moments ago. */
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.now() - this.lastAttemptAt < MIN_REFRESH_INTERVAL_MS) return Promise.resolve();
    this.lastAttemptAt = this.now();
    this.pending = this.source
      .list()
      .then((text) => {
        this.snapshot = this.source.parse(text);
        this.readAt = this.now();
        this.onDidUpdate?.();
      })
      .catch(() => {
        // The list is unavailable; sessions stay listed without location details.
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}

export function createProcessTable(platform: NodeJS.Platform = process.platform): ProcessTable {
  if (platform === "linux") return new LinuxProcessTable();
  return new SnapshotProcessTable(platform === "win32" ? WINDOWS_SOURCE : PS_SOURCE);
}
