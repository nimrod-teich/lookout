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
  /** A process's children, with their command lines; Linux only. */
  children?(pid: number): { pid: number; args: string; startedMs?: number }[];
  /** Where a process writes its output, when that is a file: its size, and whether the file was deleted; Linux only. */
  output?(pid: number): { size: number; deleted: boolean } | undefined;
  /** CPU time a process and every process under it have used, in clock ticks; Linux only. */
  cpuTicks?(pid: number): number | undefined;
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

/** Process starts kept at most: the oldest are forgotten past this. */
const STARTS_KEPT = 4096;

/**
 * Process start times from `/proc`, epoch ms. `/proc/<pid>/stat` gives a
 * process's start in clock ticks after boot (100 a second), and `/proc/stat`
 * the boot time, which moves whenever the clock is set: WSL 2 pauses its
 * virtual machine while Windows sleeps, then sets the clock forward by as
 * long, and the boot time with it. A start reached from a later boot time is
 * off by that much, so each process's start is fixed the first time it is
 * seen, with the boot time of that moment.
 */
export class ProcStarts {
  private readonly fixed = new Map<string, number | undefined>();

  constructor(private readonly root: string = "/proc") {}

  /** The start of process `pid`, which started `ticks` clock ticks after boot. */
  of(pid: number, ticks: number): number | undefined {
    const key = `${pid}:${ticks}`;
    if (!this.fixed.has(key)) {
      const boot = this.bootMs();
      this.fixed.set(key, boot !== undefined && Number.isFinite(ticks) ? boot + ticks * 10 : undefined);
      if (this.fixed.size > STARTS_KEPT) this.fixed.delete(this.fixed.keys().next().value!);
    }
    return this.fixed.get(key);
  }

  /** When the machine booted, epoch ms, as `/proc/stat` says now. */
  private bootMs(): number | undefined {
    try {
      const btime = /^btime (\d+)$/m.exec(fs.readFileSync(`${this.root}/stat`, "utf8"))?.[1];
      return btime === undefined ? undefined : Number(btime) * 1000;
    } catch {
      return undefined;
    }
  }
}

/** Linux: every lookup is one small synchronous read of `/proc` (`root`, for tests). */
export class LinuxProcessTable implements ProcessTable {
  private domain: string | undefined | null = null;
  private readonly starts: ProcStarts;

  constructor(private readonly root: string = "/proc") {
    this.starts = new ProcStarts(root);
  }

  get(pid: number): ProcessInfo | null {
    try {
      return parseProcStat(fs.readFileSync(`${this.root}/${pid}/stat`, "utf8"));
    } catch {
      return null;
    }
  }

  children(pid: number): { pid: number; args: string; startedMs?: number }[] {
    let ids: number[];
    try {
      ids = fs.readFileSync(`${this.root}/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
    } catch {
      return [];
    }
    const out: { pid: number; args: string; startedMs?: number }[] = [];
    for (const child of ids) {
      try {
        const startedMs = this.starts.of(child, Number(this.get(child)?.startTicks));
        out.push({ pid: child, args: fs.readFileSync(`${this.root}/${child}/cmdline`, "utf8").replace(/\0/g, " ").trim(), startedMs });
      } catch {
        // Gone meanwhile.
      }
    }
    return out;
  }

  output(pid: number): { size: number; deleted: boolean } | undefined {
    try {
      const target = fs.readlinkSync(`${this.root}/${pid}/fd/1`);
      if (!target.startsWith("/")) return undefined;
      return { size: fs.statSync(`${this.root}/${pid}/fd/1`).size, deleted: target.endsWith(" (deleted)") };
    } catch {
      return undefined;
    }
  }

  cpuTicks(pid: number, depth = 0): number | undefined {
    let total: number;
    try {
      const stat = fs.readFileSync(`${this.root}/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // utime and stime, fields 14 and 15, and cutime and cstime, 16 and 17: what its ended children used.
      total = Number(rest[11]) + Number(rest[12]) + Number(rest[13]) + Number(rest[14]);
    } catch {
      return undefined;
    }
    if (depth > 16) return total;
    let kids: string[] = [];
    try {
      kids = fs.readFileSync(`${this.root}/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    } catch {
      // No children list: the process alone.
    }
    for (const kid of kids) total += this.cpuTicks(Number(kid), depth + 1) ?? 0;
    return Number.isFinite(total) ? total : undefined;
  }

  pidDomain(): string | undefined {
    if (this.domain === null) {
      try {
        const machineId = fs.readFileSync("/etc/machine-id", "utf8").trim();
        this.domain = `linux:${machineId}:${fs.readlinkSync(`${this.root}/self/ns/pid`)}`;
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

/** As `run`, but a failure that still printed something gives what it printed: `lsof` fails when one of the processes it was asked about has ended. */
function runLoose(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
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

/** A process found by its program's name, with what is needed to tie it to a session. */
export interface NamedProcess {
  pid: number;
  ppid?: number;
  /** Its command line, the program first. Where the platform gives one string, split on whitespace outside quotes. */
  args: string[];
  /** Its current directory, where the platform tells it: Linux and macOS. */
  cwd?: string;
  /** Start time, epoch ms. */
  startedMs?: number;
}

/** The running processes of one program, by name: `codex` finds `codex` and `codex.exe`. */
export interface ProcessFinder {
  /** The processes as last read; on platforms that list them in the background, possibly a few seconds old. */
  find(): NamedProcess[];
  /**
   * The files one of them holds open, by path, where the platform tells it and
   * the finder was made to read them: Linux from `/proc`, macOS from `lsof`.
   * Undefined where it cannot be told.
   */
  heldFiles?(pid: number): string[] | undefined;
  /** Set by the owner to learn that a background read brought news. */
  onDidUpdate?: () => void;
}

/** The program's own name: the last path segment, without `.exe`. */
export function programName(path: string): string {
  return (path.split(/[\\/]/).at(-1) ?? path).replace(/\.exe$/i, "");
}

/** Splits a Windows command line into arguments: whitespace separates them, double quotes group them. */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** A process list on Linux is a look through `/proc`; it is read again at most this often. */
const LINUX_SCAN_MS = 1_000;

/** Linux: the processes whose `comm` is the name, read straight from `/proc`. */
export class LinuxProcessFinder implements ProcessFinder {
  private found: NamedProcess[] = [];
  private scannedAt = -Infinity;
  private readonly starts: ProcStarts;

  constructor(
    private readonly name: string,
    private readonly root: string = "/proc",
    private readonly now: () => number = Date.now,
  ) {
    this.starts = new ProcStarts(root);
  }

  find(): NamedProcess[] {
    if (this.now() - this.scannedAt < LINUX_SCAN_MS) return this.found;
    this.scannedAt = this.now();
    let entries: string[];
    try {
      entries = fs.readdirSync(this.root);
    } catch {
      return (this.found = []);
    }
    const found: NamedProcess[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const dir = `${this.root}/${entry}`;
      try {
        // The command line names the program; `comm` would be cheaper to check first, but it is cut at
        // 15 characters and a program may rename its main thread (Copilot CLI's reads "MainThread").
        const args = fs.readFileSync(`${dir}/cmdline`, "utf8").split("\0").filter((arg, i, all) => arg !== "" || i < all.length - 1);
        if (args.length === 0 || programName(args[0]!) !== this.name) continue;
        const stat = parseProcStat(fs.readFileSync(`${dir}/stat`, "utf8"));
        let cwd: string | undefined;
        try {
          cwd = fs.readlinkSync(`${dir}/cwd`);
        } catch {
          // Another user's process, or gone meanwhile.
        }
        found.push({ pid: Number(entry), ppid: stat?.ppid, args, cwd, startedMs: this.starts.of(Number(entry), Number(stat?.startTicks)) });
      } catch {
        // Gone meanwhile, or not ours to read.
      }
    }
    return (this.found = found);
  }

  /** The targets of the process's file descriptors in `/proc/<pid>/fd`. */
  heldFiles(pid: number): string[] | undefined {
    let fds: string[];
    try {
      fds = fs.readdirSync(`${this.root}/${pid}/fd`);
    } catch {
      return undefined;
    }
    const files: string[] = [];
    for (const fd of fds) {
      try {
        files.push(fs.readlinkSync(`${this.root}/${pid}/fd/${fd}`));
      } catch {
        // Closed meanwhile.
      }
    }
    return files;
  }

}

/** Parses `pid|ppid|creation FILETIME|command line` rows, the output of the Windows finder's command. */
export function parseWindowsNamedProcesses(text: string): NamedProcess[] {
  const found: NamedProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+)\|(\d+)\|(\d+)\|(.*)$/.exec(line.trim());
    if (!match) continue;
    const fileTime = Number(match[3]);
    found.push({ pid: Number(match[1]), ppid: Number(match[2]), args: splitCommandLine(match[4]!), startedMs: fileTime > 0 ? Math.round(fileTime / 10_000 - FILETIME_EPOCH_OFFSET_MS) : undefined });
  }
  return found;
}

/** Parses `ps -axww -o pid=,ppid=,lstart=,args=` rows, printed with `LC_ALL=C TZ=UTC`, keeping the processes of program `name`. */
export function parsePsNamedProcesses(text: string, name: string): NamedProcess[] {
  const found: NamedProcess[] = [];
  for (const line of text.split("\n")) {
    // lstart is five words: "Sun Oct 18 12:03:38 2026".
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[4]!.trim().split(/\s+/);
    if (programName(args[0] ?? "") !== name) continue;
    const startedMs = Date.parse(`${match[3]} UTC`);
    found.push({ pid: Number(match[1]), ppid: Number(match[2]), args, startedMs: Number.isFinite(startedMs) ? startedMs : undefined });
  }
  return found;
}

/** Parses `lsof -a -p <pid> -d cwd -Fn`: the line after `n` is the directory. */
export function parseLsofCwd(text: string): string | undefined {
  return /^n(.+)$/m.exec(text)?.[1];
}

/** Parses `lsof -p <pid>,<pid> -Fpn`: a `p` line names the process, the `n` lines after it the files it holds. */
export function parseLsofFiles(text: string): Map<number, string[]> {
  const files = new Map<number, string[]>();
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      current = Number.isInteger(pid) ? [] : undefined;
      if (current) files.set(pid, current);
    } else if (line.startsWith("n") && current) {
      current.push(line.slice(1));
    }
  }
  return files;
}

/**
 * macOS and Windows: the program's processes from a process list read in the
 * background, at most every 3 seconds; on macOS each new process's directory
 * once, from `lsof`. Windows does not tell another process's directory.
 */
export class SnapshotProcessFinder implements ProcessFinder {
  onDidUpdate?: () => void;
  private found: NamedProcess[] = [];
  private readAt = -Infinity;
  private pending: Promise<void> | undefined;
  /** Directories by pid and start time, read once. */
  private readonly cwds = new Map<string, string | undefined>();
  /** The files each process held at the last read, when the finder reads them. */
  private files = new Map<number, string[]>();

  constructor(
    private readonly list: () => Promise<NamedProcess[]>,
    private readonly cwdOf?: (pid: number) => Promise<string | undefined>,
    private readonly now: () => number = Date.now,
    private readonly filesOf?: (pids: number[]) => Promise<Map<number, string[]>>,
  ) {}

  find(): NamedProcess[] {
    if (this.now() - this.readAt >= MIN_REFRESH_INTERVAL_MS) void this.refresh();
    return this.found;
  }

  heldFiles(pid: number): string[] | undefined {
    return this.filesOf ? (this.files.get(pid) ?? []) : undefined;
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.readAt = this.now();
    this.pending = this.list()
      .then(async (found) => {
        const before = JSON.stringify(this.found);
        for (const process of found) {
          const key = `${process.pid}:${process.startedMs}`;
          if (this.cwdOf && !this.cwds.has(key)) this.cwds.set(key, await this.cwdOf(process.pid).catch(() => undefined));
          process.cwd = this.cwds.get(key);
        }
        const live = new Set(found.map((process) => `${process.pid}:${process.startedMs}`));
        for (const key of this.cwds.keys()) if (!live.has(key)) this.cwds.delete(key);
        const filesBefore = JSON.stringify([...this.files]);
        if (this.filesOf) this.files = found.length ? await this.filesOf(found.map((process) => process.pid)).catch(() => new Map<number, string[]>()) : new Map();
        this.found = found;
        if (JSON.stringify(found) !== before || JSON.stringify([...this.files]) !== filesBefore) this.onDidUpdate?.();
      })
      .catch(() => {
        // No list: the program's sessions are not found until one can be read.
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}

/**
 * The finder for one program on this platform. `files`: read which files its
 * processes hold open, where the platform tells it (not on Windows).
 */
export function createProcessFinder(name: string, platform: NodeJS.Platform = process.platform, options: { files?: boolean } = {}): ProcessFinder {
  if (platform === "linux") return new LinuxProcessFinder(name);
  if (platform === "win32") {
    const command = `Get-CimInstance Win32_Process -Filter "Name='${name}.exe'" | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }), $_.CommandLine }`;
    return new SnapshotProcessFinder(async () => parseWindowsNamedProcesses(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command])));
  }
  return new SnapshotProcessFinder(
    async () => parsePsNamedProcesses(await run("ps", ["-axww", "-o", "pid=,ppid=,lstart=,args="], { ...process.env, LC_ALL: "C", TZ: "UTC" }), name),
    async (pid) => parseLsofCwd(await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])),
    Date.now,
    options.files ? async (pids) => parseLsofFiles(await runLoose("lsof", ["-p", pids.join(","), "-Fpn"])) : undefined,
  );
}
