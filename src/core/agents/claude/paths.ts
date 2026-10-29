import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ConfigDirSources {
  /** Lookout's own setting. */
  setting?: string;
  /** `CLAUDE_CONFIG_DIR` the Claude Code extension passes to its sessions. */
  claudeExtensionEnv?: string;
  /** `lookout.claudeConfigDirs`: more directories, each a path or `label=path`. */
  extra?: unknown;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

/** A Claude Code config directory Lookout watches: one sign-in, so one account. */
export interface ClaudeDir {
  /**
   * As Claude Code is given it in `CLAUDE_CONFIG_DIR`: `~` expanded, otherwise
   * as written. Claude Code names the directory's stored sign-in after this
   * exact spelling, so it is never normalized.
   */
  dir: string;
  /** The absolute path. */
  resolved: string;
  /** Its short name, unique among the directories watched. */
  label: string;
  /** `~/.claude`, which Claude Code uses when `CLAUDE_CONFIG_DIR` is not set. */
  isDefault: boolean;
}

/** The label of the directory Claude Code uses by default. */
export const DEFAULT_LABEL = "default";

/** `label=path`: a label of letters, digits, `.`, `_` or `-`, so a path with an `=` further on stays a path. */
const LABELLED = /^([\p{L}\p{N}_.-]+)=(.+)$/u;

function expandHome(p: string, home: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p;
}

/** A path as Claude Code is to be given it: `~` expanded; a relative one made absolute. */
function written(p: string, home: string): string {
  const expanded = expandHome(p, home);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

function isDefaultDir(resolved: string, home: string): boolean {
  return resolved === path.resolve(home, ".claude");
}

/** What tells two spellings of one directory apart from two directories: links followed, case ignored where the file system ignores it. */
function identity(resolved: string, platform: NodeJS.Platform): string {
  let real = resolved;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    // Not there yet: Claude Code makes it on its first run.
  }
  return platform === "darwin" || platform === "win32" ? real.toLowerCase() : real;
}

/** A directory's label when none is given: its name less a leading `.claude-` or `.claude_`; the default directory's is `default`. */
export function labelOf(dir: string, home: string = os.homedir()): string {
  const resolved = path.resolve(dir);
  if (isDefaultDir(resolved, home)) return DEFAULT_LABEL;
  const name = path
    .basename(resolved)
    .replace(/^\./, "")
    .replace(/^claude[-_]/i, "")
    .replace(/\s+/g, "-");
  return name || "claude";
}

/** The primary directory as written: the setting, the Claude Code extension's `CLAUDE_CONFIG_DIR`, the environment's, or `~/.claude`. */
function primaryDir(sources: ConfigDirSources, home: string): string {
  const env = sources.env ?? process.env;
  const chosen = sources.setting?.trim() || sources.claudeExtensionEnv?.trim() || env.CLAUDE_CONFIG_DIR?.trim();
  return chosen ? written(chosen, home) : path.join(home, ".claude");
}

interface Entry {
  dir: string;
  label?: string;
  identity: string;
}

/**
 * Every config directory to watch: the primary first, then the listed ones in
 * their order. A listed one that is another spelling of a directory already
 * there only gives it its label, if it had none. Labels are unique: a name
 * given with `label=` first, then the ones made from directory names, with
 * `-2`, `-3` after a name already taken.
 */
export function resolveConfigDirs(sources: ConfigDirSources = {}): ClaudeDir[] {
  const home = sources.home ?? os.homedir();
  const platform = sources.platform ?? process.platform;
  const entries: Entry[] = [];
  const add = (dir: string, label: string | undefined): void => {
    const id = identity(path.resolve(dir), platform);
    const same = entries.find((entry) => entry.identity === id);
    if (!same) entries.push({ dir, label, identity: id });
    else if (same.label === undefined) same.label = label;
  };
  add(primaryDir(sources, home), undefined);
  for (const raw of Array.isArray(sources.extra) ? sources.extra : []) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const match = LABELLED.exec(raw.trim());
    const [label, dir] = match ? [match[1], match[2]!.trim()] : [undefined, raw.trim()];
    if (dir) add(written(dir, home), label);
  }
  const taken = new Set<string>();
  const given = entries.map((entry) => (entry.label !== undefined && !taken.has(entry.label) ? (taken.add(entry.label), entry.label) : undefined));
  return entries.map((entry, i) => {
    const resolved = path.resolve(entry.dir);
    return { dir: entry.dir, resolved, label: given[i] ?? unique(labelOf(resolved, home), taken), isDefault: isDefaultDir(resolved, home) };
  });
}

function unique(label: string, taken: Set<string>): string {
  let name = label;
  for (let n = 2; taken.has(name); n++) name = `${label}-${n}`;
  taken.add(name);
  return name;
}

/**
 * The environment that runs Claude Code on a directory's own sign-in: the
 * directory in `CLAUDE_CONFIG_DIR` as written, the variable removed for the
 * default one, and no token or API key in the environment to override it.
 * Null removes a variable.
 */
export function signInEnv(dir: ClaudeDir): Record<string, string | null> {
  return { CLAUDE_CONFIG_DIR: dir.isDefault ? null : dir.dir, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null };
}

/** The same directories, spelled the same, with the same labels: nothing to start over for. */
export function sameDirs(a: readonly ClaudeDir[], b: readonly ClaudeDir[]): boolean {
  return a.length === b.length && a.every((dir, i) => dir.dir === b[i]?.dir && dir.label === b[i]?.label);
}

export function sessionsDir(configDir: string): string {
  return path.join(configDir, "sessions");
}

/** Claude Code names a project's transcript directory after its cwd. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Finds a session's transcript. It normally sits under the launch directory's
 * project folder; a session resumed from elsewhere keeps its original folder.
 */
export function findTranscript(configDir: string, cwd: string, sessionId: string): string | undefined {
  const projects = path.join(configDir, "projects");
  const fileName = `${sessionId}.jsonl`;
  const direct = path.join(projects, encodeProjectDir(cwd), fileName);
  if (fs.existsSync(direct)) return direct;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
