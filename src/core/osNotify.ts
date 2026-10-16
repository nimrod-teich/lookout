import type { OsMessage } from "./notifyGate";

/** Where an OS notification is shown: the desktop the extension host can reach. */
export type Desktop = "linux" | "macos" | "windows" | "wsl";

/** A program and its arguments, run without a shell. */
export interface Command {
  file: string;
  args: string[];
}

/** What can make a sound on a Linux desktop. */
export type LinuxPlayer = "paplay" | "canberra-gtk-play";

/**
 * The desktop that notifications from this extension host reach. A WSL
 * remote reaches the Windows desktop through `powershell.exe`; other remotes
 * (SSH, containers, Codespaces, tunnels) run where no desktop of the user's
 * is, so they get none.
 */
export function desktopOf(platform: string, remoteName: string | undefined, insideWsl: boolean): Desktop | undefined {
  if (remoteName === "wsl") return "wsl";
  if (remoteName !== undefined) return undefined;
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return insideWsl ? "wsl" : "linux";
  return undefined;
}

/** "Ctrl+Alt+Shift+J", or "⌃⌥⇧J" on a Mac: the key that jumps to the next session that needs you. */
export function jumpKeyLabel(desktop: Desktop | undefined): string {
  return desktop === "macos" ? "⌃⌥⇧J" : "Ctrl+Alt+Shift+J";
}

const LINUX_SOUND = "/usr/share/sounds/freedesktop/stereo/message.oga";
const MAC_SOUND = "/System/Library/Sounds/Glass.aiff";
/** Windows PowerShell's own app id: always registered, so its toasts are shown. */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

function appleScriptString(text: string): string {
  return `"${text.replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ")}"`;
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * A Windows PowerShell script that shows a toast. The texts arrive base64
 * encoded and are XML-escaped by PowerShell, so nothing in them can change
 * the script or the toast's markup.
 */
export function toastScript(message: OsMessage, sound: boolean): string {
  const audio = sound ? 'src="ms-winsoundevent:Notification.Default"' : 'silent="true"';
  const tag = message.tag?.replace(/[^\w-]/g, "").slice(0, 64);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(message.title)}'))`,
    `$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64(message.body)}'))`,
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
    "$text = (@($title) + ($body -split \"`n\")) | Select-Object -First 3 | ForEach-Object { '<text>' + [Security.SecurityElement]::Escape($_) + '</text>' }",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric">' + ($text -join '') + '</binding></visual><audio ${audio}/></toast>')`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    // A newer toast with the same tag takes the place of the older one in the notification list.
    ...(tag ? [`$toast.Tag = '${tag}'`, "$toast.Group = 'lookout'"] : []),
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
  ].join("\n");
}

/** Arguments that run a script in Windows PowerShell, passed encoded so no quoting applies. */
export function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

/**
 * The programs that show `message` on this desktop, and play a sound with it
 * when asked. `powershell` is the path of powershell.exe, for Windows and WSL.
 */
export function notifyCommands(desktop: Desktop, message: OsMessage, options: { sound: boolean; player?: LinuxPlayer; powershell?: string }): Command[] {
  switch (desktop) {
    case "linux": {
      const show: Command = { file: "notify-send", args: ["--app-name=Lookout", "--", message.title, message.body] };
      if (!options.sound || !options.player) return [show];
      return [show, options.player === "paplay" ? { file: "paplay", args: [LINUX_SOUND] } : { file: "canberra-gtk-play", args: ["--id=message-new-instant"] }];
    }
    case "macos": {
      const show: Command = { file: "osascript", args: ["-e", `display notification ${appleScriptString(message.body)} with title ${appleScriptString(message.title)}`] };
      return options.sound ? [show, { file: "afplay", args: [MAC_SOUND] }] : [show];
    }
    case "windows":
    case "wsl":
      return [{ file: options.powershell ?? "powershell.exe", args: powershellArgs(toastScript(message, options.sound)) }];
  }
}
