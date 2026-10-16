import { describe, expect, it } from "vitest";
import { isWindowTitle, raiseScript, raiseSteps, wmctrlPick, type RaiseStep } from "../../src/core/raise";

const identity = { title: 'web "app" (v2.1)', app: "Visual Studio Code" };
const api = { title: "api", app: "Visual Studio Code" };

function decodePowershell(args: readonly string[]): string {
  return Buffer.from(args.at(-1)!, "base64").toString("utf16le");
}

const run = (step: RaiseStep | undefined) => (step && "run" in step ? step.run : undefined);

describe("isWindowTitle", () => {
  it("knows a VS Code window by its folder's part of the title, and not by a folder whose name only starts the same", () => {
    expect(isWindowTitle("index.ts - api - Visual Studio Code", api)).toBe(true);
    expect(isWindowTitle("● index.ts - api - Work - Visual Studio Code", api)).toBe(true);
    expect(isWindowTitle("api - Visual Studio Code", api)).toBe(true);
    expect(isWindowTitle("[Extension Development Host] api - Visual Studio Code", api)).toBe(true);
    expect(isWindowTitle("index.ts - api-gateway - Visual Studio Code", api)).toBe(false);
    expect(isWindowTitle("api - GitHub - Mozilla Firefox", api)).toBe(false);
    expect(isWindowTitle("my-api - Visual Studio Code", api)).toBe(false);
    expect(isWindowTitle('x - web "app" (v2.1) - Visual Studio Code', identity)).toBe(true);
    expect(isWindowTitle("x - web app v2.1 - Visual Studio Code", identity)).toBe(false);
  });
});

describe("raiseSteps", () => {
  it("raises an X11 window whose title is this window's, with xdotool, then wmctrl from its list", () => {
    const [xdotool, wmctrl] = raiseSteps("linux", identity);
    expect(run(xdotool)).toEqual({ file: "xdotool", args: ["search", "--onlyvisible", "--name", '(^|] | - )web "app" \\(v2\\.1\\) - (.* - )?Visual Studio Code$', "windowactivate"] });
    expect(wmctrl && "list" in wmctrl ? wmctrl.list : undefined).toEqual({ file: "wmctrl", args: ["-l"] });
    const listing = ["0x01e00003  0 box Mozilla Firefox", '0x03a00007  0 box index.ts - web "app" (v2.1) - Visual Studio Code', "0x03a0000c  0 box other - Visual Studio Code"].join("\n");
    expect(wmctrl && "pick" in wmctrl ? wmctrl.pick(listing) : undefined).toEqual({ file: "wmctrl", args: ["-i", "-a", "0x03a00007"] });
  });

  it("picks nothing from a wmctrl list without this window", () => {
    expect(wmctrlPick("0x03a00007  0 box index.ts - api-gateway - Visual Studio Code\n", api)).toBeUndefined();
    expect(wmctrlPick("", api)).toBeUndefined();
  });

  it("raises a window of VS Code's own process on a Mac, by pid when it is known", () => {
    const [osascript] = raiseSteps("macos", { ...identity, appPid: 4321 });
    expect(run(osascript)).toEqual({
      file: "osascript",
      args: [
        "-e",
        'tell application "System Events" to set frontmost of (first process whose unix id is 4321) to true',
        "-e",
        'tell application "System Events" to perform action "AXRaise" of (first window of (first process whose unix id is 4321) whose name contains "web \\"app\\" (v2.1) - " and name ends with " - Visual Studio Code")',
      ],
    });
    expect(run(raiseSteps("macos", identity)[0])?.args[1]).toContain('(first process whose name is "Code")');
  });

  it("walks the top-level windows with Windows PowerShell, on Windows and from WSL, the texts only in base64", () => {
    for (const desktop of ["windows", "wsl"] as const) {
      const command = run(raiseSteps(desktop, identity, { powershell: "powershell.exe" })[0]);
      expect(command?.file).toBe("powershell.exe");
      expect(command?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      const script = decodePowershell(command!.args);
      expect(script).toBe(raiseScript(identity));
      expect(script).not.toContain("web");
      expect(script).toContain(Buffer.from(identity.title).toString("base64"));
      expect(script).toContain('new Regex("(^|] | - )" + Regex.Escape(title) + " - (.* - )?" + Regex.Escape(app) + "$")');
      // Already in front: no Alt tap, which would open the menu bar.
      expect(script.indexOf("GetForegroundWindow() -eq $h")).toBeLessThan(script.indexOf("keybd_event(0x12, 0, 0"));
    }
  });

  it("has nothing to try for a window without a name, or without PowerShell", () => {
    expect(raiseSteps("linux", { title: " ", app: "Visual Studio Code" })).toEqual([]);
    expect(raiseSteps("wsl", identity)).toEqual([]);
  });
});
