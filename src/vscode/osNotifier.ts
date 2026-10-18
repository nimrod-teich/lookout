import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OsMessage } from "../core/notifyGate";
import { notifyCommands, type Command, type Desktop, type LinuxPlayer } from "../core/osNotify";
import type { Log } from "./log";

/** A notifier program gets this long before it is stopped; nothing waits on it. */
const COMMAND_TIMEOUT_MS = 2000;
/** Windows PowerShell starts slower: 0.7 to 1.2 s from WSL, now and then past 2 s on a busy machine. */
const POWERSHELL_TIMEOUT_MS = 5000;

/** How a program ended: cleanly, or why not. */
export interface RunResult {
  ok: boolean;
  /** "exit 1", "timed out", "could not start". */
  failure?: string;
  ms: number;
}

/** Runs a program without a shell, stopping it after `timeoutMs`. Never throws. */
export type Runner = (command: Command, timeoutMs: number) => Promise<RunResult>;

export const runCommand: Runner = (command, timeoutMs) =>
  new Promise((resolve) => {
    const started = Date.now();
    const done = (failure?: string) => resolve({ ok: failure === undefined, failure, ms: Date.now() - started });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.file, command.args, { stdio: "ignore", windowsHide: true });
    } catch {
      done("could not start");
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done("timed out");
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      done("could not start");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0 ? undefined : `exit ${code ?? "by signal"}`);
    });
  });

export interface NotifierHost {
  run: Runner;
  exists(file: string): boolean;
  /** The PATH to look for powershell.exe on, under WSL. */
  pathEnv: string | undefined;
  /** %SystemRoot% on Windows. */
  systemRoot: string | undefined;
}

const defaultHost: NotifierHost = {
  run: runCommand,
  exists: (file) => fs.existsSync(file),
  pathEnv: process.env.PATH,
  systemRoot: process.env.SystemRoot,
};

/** What the desktop offers, found once. */
interface Tools {
  ok: boolean;
  player?: LinuxPlayer;
  powershell?: string;
}

/**
 * Shows notifications on the user's desktop with the programs it already
 * has: notify-send, osascript, or Windows PowerShell (also from WSL). Finds
 * them once; a desktop without them, or a remote without a desktop, gets
 * nothing and the in-window notification stays the only one.
 */
export class OsNotifier {
  private tools: Promise<Tools> | undefined;

  constructor(
    private readonly desktop: Desktop | undefined,
    private readonly log: Log,
    private readonly host: NotifierHost = defaultHost,
  ) {}

  send(message: OsMessage, sound: boolean): void {
    const desktop = this.desktop;
    if (!desktop) return;
    void this.find().then(async (tools) => {
      if (!tools.ok) return;
      for (const command of notifyCommands(desktop, message, { sound, player: tools.player, powershell: tools.powershell })) {
        const result = await this.host.run(command, tools.powershell === command.file ? POWERSHELL_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
        const what = `OS notification "${message.title}": ${path.win32.basename(command.file)}`;
        this.log.info(result.ok ? `${what} done in ${result.ms} ms` : `${what} failed (${result.failure} after ${result.ms} ms)`);
      }
    });
  }

  private find(): Promise<Tools> {
    this.tools ??= this.detect().then((tools) => {
      this.log.info(tools.ok ? `OS notifications: ${this.desktop}${tools.powershell ? ` via ${tools.powershell}` : ""}${tools.player ? `, sound via ${tools.player}` : ""}` : `OS notifications: nothing to show them with on ${this.desktop}`);
      return tools;
    });
    return this.tools;
  }

  private async detect(): Promise<Tools> {
    const probe = async (file: string) => (await this.host.run({ file, args: ["--version"] }, COMMAND_TIMEOUT_MS)).ok;
    switch (this.desktop) {
      case "linux": {
        const ok = await probe("notify-send");
        const player = (await probe("paplay")) ? "paplay" : (await probe("canberra-gtk-play")) ? "canberra-gtk-play" : undefined;
        return { ok, player };
      }
      case "macos":
        return { ok: this.host.exists("/usr/bin/osascript") };
      case "windows": {
        const powershell = path.win32.join(this.host.systemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        return { ok: this.host.exists(powershell), powershell };
      }
      case "wsl": {
        // Windows programs run from WSL only while interop is on.
        const interop = this.host.exists("/proc/sys/fs/binfmt_misc/WSLInterop") || this.host.exists("/proc/sys/fs/binfmt_misc/WSLInterop-late");
        const onPath = (this.host.pathEnv ?? "").split(":").map((dir) => path.posix.join(dir, "powershell.exe")).find((file) => this.host.exists(file));
        const powershell = onPath ?? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
        return { ok: interop && this.host.exists(powershell), powershell };
      }
      default:
        return { ok: false };
    }
  }
}
