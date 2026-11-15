// Where a restored file goes on this machine: the backup's paths mapped to
// this machine's folders, and every name the backup gives checked before it
// becomes part of a path. A backup comes from another machine, or from
// someone else, so nothing in it is trusted: a path is put together from
// pieces that passed a check, under a root this machine chose, and is
// refused when it would leave that root or pass through a link.
import * as fs from "node:fs";
import * as path from "node:path";
import { cutProjectDir, encodeProjectDir, PROJECT_DIR_MAX } from "../agents/claude/paths";
import type { PathMapping } from "./types";

/** A session id as Claude Code, Codex and Copilot write them. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Claude Code project folder's name. */
const FOLDER_NAME = /^[A-Za-z0-9._-]+$/;
/** The longest name a file system takes. */
const NAME_MAX = 255;
/** Names Windows gives to devices, whatever follows the first dot. */
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** A folder name a restore may make: letters, digits, `.`, `_` and `-`, and not `.` or `..`. */
export function isFolderName(value: unknown): value is string {
  return typeof value === "string" && FOLDER_NAME.test(value) && isSegment(value);
}

/**
 * One part of a relative path: something, not `.` or `..`, with no slash,
 * backslash, colon, NUL or other control character, short enough to be a
 * file's name, and one Windows takes as it is: not a device's name, not
 * ending in a dot or a space.
 */
export function isSegment(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && value.length <= NAME_MAX && !/[\\/:\p{Cc}]/u.test(value) && !DEVICE.test(value) && !/[. ]$/.test(value);
}

/** A backup's relative path (forward slashes) in its parts; none when it is empty, absolute, or any part is not one. */
export function segmentsOf(rel: unknown): string[] | undefined {
  if (typeof rel !== "string" || rel === "" || rel.length > 4096) return undefined;
  const parts = rel.split("/");
  return parts.every(isSegment) ? parts : undefined;
}

/** `parts` under `root`, when the result stays inside it. */
export function under(root: string, parts: readonly string[]): string | undefined {
  if (parts.length === 0 || !parts.every(isSegment)) return undefined;
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  return inside(base, target) ? target : undefined;
}

/** `target` is `root` itself or below it. */
export function inside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** How a machine's paths are written: Windows takes either slash and ignores case, macOS ignores case. */
interface Flavour {
  separator: RegExp;
  fold: boolean;
}

function flavourOf(platform: NodeJS.Platform): Flavour {
  if (platform === "win32") return { separator: /[\\/]+/, fold: true };
  return { separator: /\/+/, fold: platform === "darwin" };
}

/** A path's parts as its machine writes them, its root left out. */
function partsOf(p: string, flavour: Flavour): string[] {
  return p.split(flavour.separator).filter((part) => part !== "");
}

/** `from`'s parts start `p`'s parts. */
function startsWithParts(p: readonly string[], from: readonly string[], fold: boolean): boolean {
  if (from.length > p.length) return false;
  return from.every((part, i) => (fold ? part.toLowerCase() === p[i]!.toLowerCase() : part === p[i]));
}

/**
 * A path of the source machine as it is on this one: the mapping whose
 * `from` is the longest one that holds it gives the folder, and the rest
 * follows. A path no mapping holds is as it was. Undefined for one that is
 * not absolute, or has a `.`, `..` or NUL in it: the backup is not trusted.
 */
export function mapPath(p: unknown, mapping: readonly PathMapping[], platform: NodeJS.Platform): string | undefined {
  if (typeof p !== "string" || p === "" || p.length > 4096 || p.includes("\0")) return undefined;
  const flavour = flavourOf(platform);
  const parts = partsOf(p, flavour);
  if (parts.some((part) => part === "." || part === "..")) return undefined;
  if (!(platform === "win32" ? path.win32.isAbsolute(p) : p.startsWith("/"))) return undefined;
  let best: { to: string; length: number } | undefined;
  for (const entry of mapping) {
    if (typeof entry.from !== "string" || entry.from === "" || typeof entry.to !== "string" || entry.to === "") continue;
    const from = partsOf(entry.from, flavour);
    if (!startsWithParts(parts, from, flavour.fold)) continue;
    if (!best || from.length > best.length) best = { to: entry.to, length: from.length };
  }
  if (!best) return p;
  const rest = parts.slice(best.length);
  return rest.length ? path.join(best.to, ...rest) : path.normalize(best.to);
}

/**
 * A path of the source machine as it is on this one, only when a mapping
 * holds it and every part after the mapping's `from` is one a restore may
 * name: for a path a later click acts on, such as a folder to open or a
 * worktree to put back, so the backup never chooses where that happens.
 * The parts are split at either slash whenever either machine is Windows.
 */
export function mapCovered(p: unknown, mapping: readonly PathMapping[], platform: NodeJS.Platform, here: NodeJS.Platform = process.platform): string | undefined {
  if (typeof p !== "string" || p === "" || p.length > 4096 || p.includes("\0")) return undefined;
  if (!(platform === "win32" ? path.win32.isAbsolute(p) : p.startsWith("/"))) return undefined;
  const flavour: Flavour = { separator: platform === "win32" || here === "win32" ? /[\\/]+/ : /\/+/, fold: flavourOf(platform).fold };
  const parts = partsOf(p, flavour);
  let best: { to: string; length: number } | undefined;
  for (const entry of mapping) {
    if (typeof entry.from !== "string" || entry.from === "" || typeof entry.to !== "string" || entry.to === "") continue;
    const from = partsOf(entry.from, flavour);
    if (from.length === 0 || !startsWithParts(parts, from, flavour.fold)) continue;
    if (!best || from.length > best.length) best = { to: entry.to, length: from.length };
  }
  if (!best) return undefined;
  const rest = parts.slice(best.length);
  if (!rest.every(isSegment)) return undefined;
  return rest.length ? path.join(best.to, ...rest) : path.normalize(best.to);
}

/** A path as the history store keys the paths tool calls worked on (lowercased, forward slashes), mapped the same way. */
export function mapPathKey(key: string, mapping: readonly PathMapping[]): string {
  const keyOf = (p: string) => p.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
  let best: { from: string; to: string } | undefined;
  for (const entry of mapping) {
    const from = keyOf(entry.from);
    if (from === "" || !(key === from || key.startsWith(`${from}/`))) continue;
    if (!best || from.length > best.from.length) best = { from, to: keyOf(entry.to) };
  }
  return best ? best.to + key.slice(best.from.length) : key;
}

/** A cut project folder's name: its first 200 characters, then `-` and a hash of the whole path. */
const CUT_FOLDER = new RegExp(`^([A-Za-z0-9._-]{${PROJECT_DIR_MAX}})(-[0-9a-z]+)$`, "i");

/**
 * A Claude Code project folder's name as it is on this machine, for a file
 * whose session's place is not known: the start the longest mapping's
 * `from` gives the name becomes what its `to` gives, the start compared
 * without case for a Windows machine's drive letters. Of a cut name only
 * the start maps, and the name is cut again with its hash after it; a name
 * the mapping makes longer than Claude Code's longest is cut with a hash of
 * the name, the path it stands for not being known. Claude Code finds
 * either by its start. Undefined for a name that is not a folder's.
 */
export function mapFolderName(folder: string, mapping: readonly PathMapping[], platform: NodeJS.Platform = "linux"): string | undefined {
  if (!isFolderName(folder)) return undefined;
  const fold = platform === "win32";
  const cut = folder.length > PROJECT_DIR_MAX ? CUT_FOLDER.exec(folder) : null;
  const start = cut ? cut[1]! : folder;
  let best: { from: string; to: string } | undefined;
  for (const entry of mapping) {
    if (typeof entry.from !== "string" || entry.from === "" || typeof entry.to !== "string" || entry.to === "") continue;
    const from = sanitized(entry.from.replace(/[\\/]+$/, ""));
    if (from === "" || from.length > start.length) continue;
    const head = start.slice(0, from.length);
    if (!(fold ? head.toLowerCase() === from.toLowerCase() : head === from)) continue;
    if (start.length > from.length && start[from.length] !== "-") continue;
    if (!best || from.length > best.from.length) best = { from, to: sanitized(path.normalize(entry.to).replace(/[\\/]+$/, "")) };
  }
  if (!best) return folder;
  const whole = best.to + start.slice(best.from.length);
  const name = cut ? `${whole.slice(0, PROJECT_DIR_MAX)}${cut[2]}` : cutProjectDir(whole, whole);
  return isFolderName(name) ? name : undefined;
}

/** A path's characters as Claude Code names a folder after them, the name not cut. */
function sanitized(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The folder Claude Code keeps a session's transcripts in, for the folder it works in on this machine. */
export function projectFolder(cwd: string): string | undefined {
  const name = encodeProjectDir(cwd);
  return isFolderName(name) ? name : undefined;
}

/** How a path under a root is on disk. */
export type Lay = "missing" | "file" | "unsafe";

/**
 * What is at `parts` under `root` now: nothing, a plain file, or something
 * a restore must not write through: a link, a folder, or a link or a file
 * among the folders on the way.
 */
export function layOf(root: string, parts: readonly string[]): Lay {
  let at = path.resolve(root);
  for (let i = 0; i < parts.length; i++) {
    at = path.join(at, parts[i]!);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(at);
    } catch {
      return "missing";
    }
    const last = i === parts.length - 1;
    if (st.isSymbolicLink()) return "unsafe";
    if (last ? !st.isFile() : !st.isDirectory()) return "unsafe";
  }
  return "file";
}

/**
 * Makes the folders `parts` under `root`, one at a time, and says whether
 * every one is a real folder: a link or a file on the way is refused, and
 * nothing is made past it.
 */
export async function makeFolders(root: string, parts: readonly string[]): Promise<boolean> {
  await fs.promises.mkdir(root, { recursive: true });
  let at = path.resolve(root);
  for (const part of parts) {
    at = path.join(at, part);
    try {
      await fs.promises.mkdir(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const st = await fs.promises.lstat(at);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}
