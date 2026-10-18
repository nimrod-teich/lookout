import { describe, expect, it } from "vitest";
import { desktopOf, jumpKeyLabel, notifyCommands, powershellArgs, toastScript } from "../../src/core/osNotify";

const message = { title: 'Fix "the" <build> & ship', body: "Needs you: Permission · Bash: rm -rf './tmp' $(whoami)\nLookout · Ctrl+Alt+Shift+J in VS Code jumps to the next one that needs you" };

function decoded(args: string[]): string {
  expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  return Buffer.from(args[3]!, "base64").toString("utf16le");
}

describe("desktopOf", () => {
  it("reaches the desktop the extension host can reach, and none from other remotes", () => {
    expect(desktopOf("linux", undefined, false)).toBe("linux");
    expect(desktopOf("linux", undefined, true)).toBe("wsl");
    expect(desktopOf("linux", "wsl", true)).toBe("wsl");
    expect(desktopOf("darwin", undefined, false)).toBe("macos");
    expect(desktopOf("win32", undefined, false)).toBe("windows");
    for (const remote of ["ssh-remote", "dev-container", "attached-container", "codespaces", "tunnel"]) expect(desktopOf("linux", remote, false)).toBeUndefined();
    expect(desktopOf("freebsd", undefined, false)).toBeUndefined();
  });

  it("names the jump key the way the desktop writes it", () => {
    expect(jumpKeyLabel("macos")).toBe("⌃⌥⇧J");
    expect(jumpKeyLabel("wsl")).toBe("Ctrl+Alt+Shift+J");
    expect(jumpKeyLabel(undefined)).toBe("Ctrl+Alt+Shift+J");
  });
});

describe("notifyCommands", () => {
  it("uses notify-send on Linux, with the texts after --, and a sound only when a player is there", () => {
    expect(notifyCommands("linux", message, { sound: false })).toEqual([{ file: "notify-send", args: ["--app-name=Lookout", "--", message.title, message.body] }]);
    expect(notifyCommands("linux", message, { sound: true })).toHaveLength(1);
    expect(notifyCommands("linux", message, { sound: true, player: "paplay" })[1]).toEqual({ file: "paplay", args: ["/usr/share/sounds/freedesktop/stereo/message.oga"] });
    expect(notifyCommands("linux", message, { sound: true, player: "canberra-gtk-play" })[1]).toEqual({ file: "canberra-gtk-play", args: ["--id=message-new-instant"] });
  });

  it("uses osascript on a Mac, quoting the texts as AppleScript strings, and afplay for the sound", () => {
    const [show, sound] = notifyCommands("macos", message, { sound: true });
    expect(show).toEqual({
      file: "osascript",
      args: ["-e", `display notification "Needs you: Permission · Bash: rm -rf './tmp' $(whoami) Lookout · Ctrl+Alt+Shift+J in VS Code jumps to the next one that needs you" with title "Fix \\"the\\" <build> & ship"`],
    });
    expect(sound).toEqual({ file: "afplay", args: ["/System/Library/Sounds/Glass.aiff"] });
    expect(notifyCommands("macos", { title: "a\\b", body: "c" }, { sound: false })[0]!.args[1]).toBe('display notification "c" with title "a\\\\b"');
  });

  it("shows a Windows toast through PowerShell, on Windows and from WSL, with the texts only in base64", () => {
    const [toast] = notifyCommands("wsl", message, { sound: false, powershell: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" });
    expect(toast!.file).toBe("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    const script = decoded(toast!.args);
    expect(script).toContain(Buffer.from(message.title, "utf8").toString("base64"));
    expect(script).toContain(Buffer.from(message.body, "utf8").toString("base64"));
    expect(script).not.toContain("whoami");
    expect(script).not.toContain('"the"');
    expect(script).toContain('<audio silent="true"/>');
    expect(script).toContain("[Security.SecurityElement]::Escape");
    expect(decoded(notifyCommands("windows", message, { sound: true })[0]!.args)).toContain('<audio src="ms-winsoundevent:Notification.Default"/>');
    expect(notifyCommands("windows", message, { sound: true })[0]!.file).toBe("powershell.exe");
  });

  it("tags a toast so a newer one about the same session replaces it, with nothing but word characters", () => {
    expect(toastScript({ title: "t", body: "b", tag: "00000000-0000-4000-8000-000000000001" }, false)).toContain("$toast.Tag = '00000000-0000-4000-8000-000000000001'\n$toast.Group = 'lookout'");
    expect(toastScript({ title: "t", body: "b", tag: "x'; Remove-Item C:\\ #" }, false)).toContain("$toast.Tag = 'xRemove-ItemC'");
    expect(toastScript({ title: "t", body: "b" }, false)).not.toContain("$toast.Tag");
  });

  it("encodes the script for -EncodedCommand as UTF-16", () => {
    expect(powershellArgs("exit 0")).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand", "ZQB4AGkAdAAgADAA"]);
    expect(toastScript({ title: "t", body: "b" }, false).split("\n")[0]).toBe("$ErrorActionPreference = 'Stop'");
  });
});
