import { powershellArgs, type Command, type Desktop } from "./osNotify";

/** What tells this VS Code window apart on the desktop. */
export interface WindowIdentity {
  /** The name of its folder or workspace, as its title shows it. */
  title: string;
  /** The application's name, at the end of every VS Code window's title, e.g. "Visual Studio Code". */
  app: string;
  /** Pid of the application's main process, on macOS, to address it and no other. */
  appPid?: number;
}

/**
 * A way to bring the window forward: a program to run, or one whose output
 * lists the windows and a second that raises the one picked from the list.
 */
export type RaiseStep = { run: Command } | { list: Command; pick: (output: string) => Command | undefined };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** POSIX extended expressions (xdotool): a backslash before each special character. */
function escapeExtended(text: string): string {
  return text.replace(/[\\.[()*+?{}|^$]/g, "\\$&");
}

/**
 * A VS Code window's title holds its folder's name as one part of it: at the
 * start, after a "] " ("[Extension Development Host] app"), or after " - ",
 * and followed by " - "; and it ends with " - " and the application's name.
 * So "api" matches "index.ts - api - Visual Studio Code", but neither
 * "index.ts - api-gateway - Visual Studio Code" nor a browser's "api - GitHub".
 */
export function titlePattern(identity: Pick<WindowIdentity, "title" | "app">, escape: (text: string) => string = escapeRegExp): string {
  return `(^|] | - )${escape(identity.title)} - (.* - )?${escape(identity.app)}$`;
}

/** Whether a window title is this window's. */
export function isWindowTitle(windowTitle: string, identity: Pick<WindowIdentity, "title" | "app">): boolean {
  return new RegExp(titlePattern(identity)).test(windowTitle);
}

/** From `wmctrl -l` (id, desktop, host, title per line), the command that raises this window. */
export function wmctrlPick(output: string, identity: Pick<WindowIdentity, "title" | "app">): Command | undefined {
  for (const line of output.split("\n")) {
    const match = /^(0x[0-9a-f]+)\s+\S+\s+\S+\s(.*)$/i.exec(line.trimEnd());
    if (match && isWindowTitle(match[2]!, identity)) return { file: "wmctrl", args: ["-i", "-a", match[1]!] };
  }
  return undefined;
}

function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Windows PowerShell that brings this window forward: it walks the visible
 * top-level windows (every VS Code window belongs to one process) for the
 * one whose title is this window's, by the rule of `titlePattern`. The texts
 * reach it base64 encoded. Windows refuses a foreground change from a process
 * the user is not working in unless a key was just pressed, so it taps Alt
 * first, unless the window is already in front. Exit 0: in front; 1:
 * refused; 2: no such window.
 */
export function raiseScript(identity: WindowIdentity): string {
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    `$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(identity.title)}'))`,
    `$app = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(identity.app)}'))`,
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "using System.Text.RegularExpressions;",
    "public static class LookoutRaise {",
    "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
    "  public static IntPtr Find(string title, string app) {",
    '    var rule = new Regex("(^|] | - )" + Regex.Escape(title) + " - (.* - )?" + Regex.Escape(app) + "$");',
    "    IntPtr found = IntPtr.Zero;",
    "    EnumWindows(delegate (IntPtr h, IntPtr l) {",
    "      if (!IsWindowVisible(h)) return true;",
    "      var text = new StringBuilder(1024);",
    "      GetWindowText(h, text, text.Capacity);",
    "      if (rule.IsMatch(text.ToString())) { found = h; return false; }",
    "      return true;",
    "    }, IntPtr.Zero);",
    "    return found;",
    "  }",
    "}",
    "'@",
    "$h = [LookoutRaise]::Find($title, $app)",
    "if ($h -eq [IntPtr]::Zero) { exit 2 }",
    "if ([LookoutRaise]::IsIconic($h)) { [void][LookoutRaise]::ShowWindowAsync($h, 9) }",
    "if ([LookoutRaise]::GetForegroundWindow() -eq $h) { exit 0 }",
    "[LookoutRaise]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)",
    "[LookoutRaise]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)",
    "if ([LookoutRaise]::SetForegroundWindow($h)) { exit 0 } else { exit 1 }",
  ].join("\n");
}

/**
 * The ways to bring this VS Code window to the front of the desktop, to try
 * in order until one works. They are what is left when VS Code's own focus
 * command did not do it. `powershell` is the path of powershell.exe, for
 * Windows and WSL.
 */
export function raiseSteps(desktop: Desktop, identity: WindowIdentity, options: { powershell?: string } = {}): RaiseStep[] {
  if (identity.title.trim() === "") return [];
  switch (desktop) {
    case "linux":
      // X11, and windows that run through XWayland; no other window's title has this shape.
      return [
        { run: { file: "xdotool", args: ["search", "--onlyvisible", "--name", titlePattern(identity, escapeExtended), "windowactivate"] } },
        { list: { file: "wmctrl", args: ["-l"] }, pick: (output) => wmctrlPick(output, identity) },
      ];
    case "macos": {
      // The application's own process, by pid when it is known: never whichever happens to be in front.
      const process = identity.appPid !== undefined ? `(first process whose unix id is ${identity.appPid})` : `(first process whose name is "Code")`;
      return [
        {
          run: {
            file: "osascript",
            args: [
              "-e",
              `tell application "System Events" to set frontmost of ${process} to true`,
              "-e",
              `tell application "System Events" to perform action "AXRaise" of (first window of ${process} whose name contains ${appleScriptString(`${identity.title} - `)} and name ends with ${appleScriptString(` - ${identity.app}`)})`,
            ],
          },
        },
      ];
    }
    case "windows":
    case "wsl":
      return options.powershell ? [{ run: { file: options.powershell, args: powershellArgs(raiseScript(identity)) } }] : [];
  }
}
