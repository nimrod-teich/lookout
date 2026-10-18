import { describe, expect, it } from "vitest";
import type { Command } from "../../src/core/osNotify";
import { OsNotifier, runCommand, type NotifierHost } from "../../src/vscode/osNotifier";
import { fakeLog, settle } from "./helpers";

const message = { title: "Fix the build", body: "Needs you: Permission · Bash: npm test" };

function host(overrides: Partial<NotifierHost> & { installed?: string[]; files?: string[]; failing?: string[] } = {}) {
  const ran: Command[] = [];
  const timeouts: number[] = [];
  const installed = new Set(overrides.installed ?? []);
  const failing = new Set(overrides.failing ?? []);
  const fake: NotifierHost = {
    run: async (command, timeoutMs) => {
      ran.push(command);
      timeouts.push(timeoutMs);
      const ok = command.args[0] === "--version" ? installed.has(command.file) : !failing.has(command.file);
      return { ok, failure: ok ? undefined : "exit 1", ms: 5 };
    },
    exists: (file) => (overrides.files ?? []).includes(file),
    pathEnv: overrides.pathEnv,
    systemRoot: overrides.systemRoot,
  };
  return { fake, ran, timeouts };
}

async function sent(notifier: OsNotifier, sound = false): Promise<void> {
  notifier.send(message, sound);
  await settle();
  await new Promise((r) => setTimeout(r, 0));
  await settle();
}

describe("OsNotifier", () => {
  it("finds notify-send and a player once, then shows each notification with a sound when asked", async () => {
    const { fake, ran } = host({ installed: ["notify-send", "canberra-gtk-play"] });
    const notifier = new OsNotifier("linux", fakeLog(), fake);
    await sent(notifier, true);
    await sent(notifier, false);
    expect(ran.map((c) => [c.file, c.args[0]])).toEqual([
      ["notify-send", "--version"],
      ["paplay", "--version"],
      ["canberra-gtk-play", "--version"],
      ["notify-send", "--app-name=Lookout"],
      ["canberra-gtk-play", "--id=message-new-instant"],
      ["notify-send", "--app-name=Lookout"],
    ]);
  });

  it("stays quiet on a Linux desktop without notify-send, and on a remote with no desktop", async () => {
    const log = fakeLog();
    const linux = host();
    await sent(new OsNotifier("linux", log, linux.fake));
    expect(linux.ran.map((c) => c.args[0])).toEqual(["--version", "--version", "--version"]);
    const remote = host({ installed: ["notify-send"] });
    await sent(new OsNotifier(undefined, log, remote.fake));
    expect(remote.ran).toEqual([]);
    expect(log.errors).toEqual([]);
  });

  it("goes through Windows PowerShell from WSL while interop is on", async () => {
    const powershell = "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe";
    const wsl = host({ files: ["/proc/sys/fs/binfmt_misc/WSLInterop", powershell], pathEnv: "/usr/bin:/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0" });
    await sent(new OsNotifier("wsl", fakeLog(), wsl.fake));
    expect(wsl.ran.map((c) => [c.file, c.args.slice(0, 3)])).toEqual([[powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand"]]]);
    // PowerShell starts slowly from WSL; it gets longer than the other notifiers.
    expect(wsl.timeouts).toEqual([5000]);
    const off = host({ files: [powershell], pathEnv: "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0" });
    await sent(new OsNotifier("wsl", fakeLog(), off.fake));
    expect(off.ran).toEqual([]);
  });

  it("uses the PowerShell in %SystemRoot% on Windows, and logs how each notification went", async () => {
    const powershell = "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const infos: string[] = [];
    const log = fakeLog();
    log.info = (line) => void infos.push(line);
    const windows = host({ files: [powershell], systemRoot: "D:\\Win", failing: [powershell] });
    await sent(new OsNotifier("windows", log, windows.fake));
    expect(windows.ran.map((c) => c.file)).toEqual([powershell]);
    expect(infos).toEqual(["OS notifications: windows via D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", 'OS notification "Fix the build": powershell.exe failed (exit 1 after 5 ms)']);
  });
});

describe("runCommand", () => {
  it("reports a clean exit, a failure, a missing program, and stops one that runs too long", async () => {
    expect(await runCommand({ file: process.execPath, args: ["-e", "process.exit(0)"] }, 5000)).toMatchObject({ ok: true, failure: undefined });
    expect(await runCommand({ file: process.execPath, args: ["-e", "process.exit(3)"] }, 5000)).toMatchObject({ ok: false, failure: "exit 3" });
    expect(await runCommand({ file: "lookout-no-such-program", args: [] }, 5000)).toMatchObject({ ok: false, failure: "could not start" });
    const slow = await runCommand({ file: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] }, 300);
    expect(slow).toMatchObject({ ok: false, failure: "timed out" });
    expect(slow.ms).toBeLessThan(5000);
  });
});
