// How long Claude Code keeps a transcript before the sweep it runs at
// startup deletes it: `cleanupPeriodDays`, 30 by default, read from its
// settings files the way it reads them, the managed sources over the
// projects' local files over their shared files over the user's. And the one
// setting Lookout writes, on the user's say-so: a longer retention into the
// user file, with a copy of the file as it was kept beside it.
import * as fs from "node:fs";
import * as path from "node:path";

/** Claude Code's own default. */
export const DEFAULT_RETENTION_DAYS = 30;
export const RETENTION_KEY = "cleanupPeriodDays";

/**
 * Where a retention comes from: a settings file at that level, Claude Code's
 * default, or `unknown`: a settings file Lookout can read does not parse,
 * or sets the key to something Claude Code refuses, and Claude Code then
 * pauses its sweep rather than guess.
 */
export type RetentionLevel = "managed" | "local" | "project" | "user" | "default" | "unknown";

export interface Retention {
  /** Days a transcript lives after its last write; none while unknown. */
  days?: number;
  level: RetentionLevel;
  /** The file that sets it, or the file that cannot be read; none at the default. */
  file?: string;
}

/** What a settings file says of the retention. */
export type RetentionIn = { kind: "missing" } | { kind: "unreadable" } | { kind: "unset" } | { kind: "invalid"; value: unknown } | { kind: "set"; days: number };

/** The system directory where a managed settings file sits on this platform. */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/**
 * The managed settings files on disk, in the order Claude Code merges them,
 * a later file's value replacing an earlier one's: `managed-settings.json`,
 * then the drop-ins beside it A to Z. A policy from a device profile or the
 * registry is not a file, and is not seen here.
 */
export function managedSettingsFiles(platform: NodeJS.Platform = process.platform): string[] {
  const dir = managedSettingsDir(platform);
  // The system directory is written the platform's way, whatever platform this runs on.
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const files = [join(dir, "managed-settings.json")];
  try {
    const dropIns = fs
      .readdirSync(join(dir, "managed-settings.d"))
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort();
    for (const name of dropIns) files.push(join(dir, "managed-settings.d", name));
  } catch {
    // No drop-ins.
  }
  return files;
}

/** The copy of the server-managed settings Claude Code caches: `{}` when the organisation set none. */
export function remoteSettingsFile(configDir: string): string {
  return path.join(configDir, "remote-settings.json");
}

/** The user settings file of a config directory: the one file Lookout may write. */
export function userSettingsFile(configDir: string): string {
  return path.join(configDir, "settings.json");
}

/** The settings file read, parsed, as an object; or why not. */
function settingsIn(file: string): { kind: "missing" } | { kind: "unreadable" } | { kind: "object"; settings: Record<string, unknown> } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { kind: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "unreadable" };
  return { kind: "object", settings: parsed as Record<string, unknown> };
}

/** What a settings file says of the retention: whole days of one or more count, as Claude Code accepts; anything else set is invalid. */
export function retentionIn(file: string): RetentionIn {
  const read = settingsIn(file);
  if (read.kind !== "object") return read;
  if (!(RETENTION_KEY in read.settings)) return { kind: "unset" };
  const value = read.settings[RETENTION_KEY];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? { kind: "set", days: value } : { kind: "invalid", value };
}

/**
 * The root of the git repository a folder is in, when it is in one: the
 * main checkout's for a worktree. Claude Code reads a project's local
 * settings file there.
 */
export function repoRootOf(folder: string): string | undefined {
  let dir = path.resolve(folder);
  for (;;) {
    const git = path.join(dir, ".git");
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(git);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return dir;
    if (st?.isFile()) {
      // A worktree: `.git` names the main repository's worktree record.
      let text: string;
      try {
        text = fs.readFileSync(git, "utf8");
      } catch {
        return dir;
      }
      const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
      const main = gitdir ? /^(.*)[\\/]\.git[\\/]worktrees[\\/]/.exec(gitdir)?.[1] : undefined;
      return main ? path.resolve(dir, main) : dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The settings files Claude Code reads below the managed tier, each with its level, the first that sets the key winning. */
export function lowerSettingsFiles(configDir: string, folders: readonly string[]): { file: string; level: RetentionLevel }[] {
  const out: { file: string; level: RetentionLevel }[] = [];
  const seen = new Set<string>();
  const add = (file: string, level: RetentionLevel) => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push({ file, level });
  };
  for (const folder of folders) {
    // The local file at the repository's root first, as Claude Code applies it over one in the folder.
    const root = repoRootOf(folder);
    if (root && root !== path.resolve(folder)) add(path.join(root, ".claude", "settings.local.json"), "local");
    add(path.join(folder, ".claude", "settings.local.json"), "local");
  }
  for (const folder of folders) add(path.join(folder, ".claude", "settings.json"), "project");
  add(userSettingsFile(configDir), "user");
  return out;
}

/**
 * The retention the managed tier sets, if any. Claude Code takes the
 * highest-ranked managed source that delivers any policy and ignores the
 * rest: the server-managed settings it cached when they hold anything, else
 * the files, merged with a later file's value replacing an earlier one's.
 */
export function managedRetention(configDir: string, platform?: NodeJS.Platform): { file?: string; in: RetentionIn } {
  const remote = remoteSettingsFile(configDir);
  const cached = settingsIn(remote);
  if (cached.kind === "unreadable") return { file: remote, in: cached };
  if (cached.kind === "object" && Object.keys(cached.settings).length > 0) return { file: remote, in: retentionIn(remote) };
  let found: { file?: string; in: RetentionIn } = { in: { kind: "missing" } };
  for (const file of managedSettingsFiles(platform)) {
    const read = retentionIn(file);
    if (read.kind === "missing") continue;
    if (read.kind === "unreadable" || read.kind === "invalid") return { file, in: read };
    if (read.kind === "set") found = { file, in: read };
    else if (found.in.kind === "missing") found = { file, in: read };
  }
  return found;
}

/**
 * The retention in force for sessions of these folders: a managed value
 * first; else, when every file Lookout can read parses and sets nothing
 * amiss, the first file that sets it, else Claude Code's default; else
 * unknown, since Claude Code pauses the sweep over a file it cannot read or
 * a value it cannot use.
 */
export function readRetention(configDir: string, folders: readonly string[], platform?: NodeJS.Platform): Retention {
  const managed = managedRetention(configDir, platform);
  if (managed.in.kind === "set") return { days: managed.in.days, level: "managed", file: managed.file };
  if (managed.in.kind === "unreadable" || managed.in.kind === "invalid") return { level: "unknown", file: managed.file };
  let set: Retention | undefined;
  for (const { file, level } of lowerSettingsFiles(configDir, folders)) {
    const read = retentionIn(file);
    if (read.kind === "unreadable" || read.kind === "invalid") return { level: "unknown", file };
    if (read.kind === "set" && !set) set = { days: read.days, level, file };
  }
  return set ?? { days: DEFAULT_RETENTION_DAYS, level: "default" };
}

/**
 * How a write of the retention went: the file written (`target` when the
 * settings file is a link to it), with the copy kept of it as it was; or
 * why it was refused, with nothing changed.
 */
export type RetentionWrite = { ok: true; file: string; target?: string; backup?: string } | { ok: false; file: string; why: string };

/** The text's own indentation and line ending, to write it back as it was. */
function styleOf(text: string): { indent: string; eol: string } {
  return { indent: /\r?\n([ \t]+)"/.exec(text)?.[1] ?? "  ", eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

/**
 * Writes `cleanupPeriodDays` into the user settings file, every other key
 * kept in the file's own indentation and line ending, with a copy of the
 * file as it was beside it. A link is written through, to the file it
 * names, with that file's permissions; a file that does not parse, is
 * hard-linked elsewhere, or changes while it is being written is left
 * alone, so nothing of the user's is lost to a rewrite.
 */
export function writeRetention(configDir: string, days: number, now: number = Date.now()): RetentionWrite {
  const file = userSettingsFile(configDir);
  let target = file;
  let st: fs.Stats | undefined;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) target = fs.realpathSync(file);
    st = fs.statSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, file, why: "could not be read" };
    st = undefined;
  }
  let settings: Record<string, unknown> = {};
  let style = { indent: "  ", eol: "\n" };
  let backup: string | undefined;
  if (st) {
    if (!st.isFile()) return { ok: false, file, why: "is not a file" };
    if (st.nlink > 1) return { ok: false, file, why: "is hard-linked elsewhere, and a rewrite would part the two" };
    let before: string;
    try {
      before = fs.readFileSync(target, "utf8");
    } catch {
      return { ok: false, file, why: "could not be read" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(before);
    } catch {
      return { ok: false, file, why: "does not parse as JSON" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, file, why: "does not hold a settings object" };
    settings = parsed as Record<string, unknown>;
    style = styleOf(before);
    backup = `${target}.${new Date(now).toISOString().replace(/[:.]/g, "-")}.before-lookout`;
    try {
      fs.copyFileSync(target, backup);
    } catch {
      return { ok: false, file, why: "could not be copied aside" };
    }
  }
  settings[RETENTION_KEY] = days;
  const temp = `${target}.${process.pid}.lookout.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // The file's own permissions, so a 600 holding tokens stays a 600.
    fs.writeFileSync(temp, `${JSON.stringify(settings, null, style.indent).replace(/\n/g, style.eol)}${style.eol}`, st ? { mode: st.mode & 0o777 } : {});
    // Claude Code writes the file too: one that changed since it was read is not written over.
    if (st && fs.statSync(target).mtimeMs !== st.mtimeMs) {
      fs.rmSync(temp, { force: true });
      return { ok: false, file, why: "changed while Lookout was about to write it; try again" };
    }
    // Moved into place whole: Claude Code, which watches the file, never reads half of it.
    fs.renameSync(temp, target);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing to take back.
    }
    return { ok: false, file, why: "could not be written" };
  }
  const out: RetentionWrite = { ok: true, file };
  if (target !== file) out.target = target;
  if (backup) out.backup = backup;
  return out;
}
