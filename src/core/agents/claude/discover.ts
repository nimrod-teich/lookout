import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Claude Code's config file inside a directory it was given in `CLAUDE_CONFIG_DIR`. */
const CONFIG_FILE = ".claude.json";

const VARIABLE = "CLAUDE_CONFIG_DIR";

/** A config directory Claude Code has run in: one with its config file. `~/.claude` keeps it beside, in `~/.claude.json`. */
export function isConfigDir(dir: string, home: string = os.homedir()): boolean {
  const file = path.resolve(dir) === path.resolve(home, ".claude") ? path.join(home, CONFIG_FILE) : path.join(dir, CONFIG_FILE);
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `~/.claude`, and the folders in the home directory named `.claude-<something>` or `.claude_<something>`, that are config directories. */
export function homeConfigDirs(home: string = os.homedir()): string[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = names
    .filter((entry) => entry.isDirectory() && /^\.claude[-_]./i.test(entry.name))
    .map((entry) => path.join(home, entry.name))
    .sort();
  return [path.join(home, ".claude"), ...dirs].filter((dir) => isConfigDir(dir, home));
}

/** `CLAUDE_CONFIG_DIR` in a `/proc/<pid>/environ`: variables split by NULs. */
export function configDirInEnviron(environ: string): string | undefined {
  const prefix = `${VARIABLE}=`;
  const entry = environ.split("\0").find((variable) => variable.startsWith(prefix));
  const value = entry?.slice(prefix.length);
  return value ? value : undefined;
}

/**
 * The `CLAUDE_CONFIG_DIR`s in the output of macOS's `ps -E`, which prints each
 * process's environment after its arguments, separated by spaces: a value
 * runs to the next space, so a path with a space in it is lost.
 */
export function configDirsInPs(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/g)) out.push(match[1]!);
  return out;
}

/** Every process's `CLAUDE_CONFIG_DIR` that this user can read, from `/proc`. */
export async function linuxProcessDirs(root = "/proc"): Promise<string[]> {
  let pids: string[];
  try {
    pids = (await fs.promises.readdir(root)).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const found = await Promise.all(
    pids.map((pid) =>
      fs.promises.readFile(path.join(root, pid, "environ"), "utf8").then(
        configDirInEnviron,
        // Another user's process, or one that has ended.
        () => undefined,
      ),
    ),
  );
  return found.filter((dir): dir is string => dir !== undefined);
}

/** Every process's `CLAUDE_CONFIG_DIR` that `ps` shows: its own user's processes' environments only. */
export function macProcessDirs(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-axwwE", "-o", "command="], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (err, stdout) =>
      resolve(err && !stdout ? [] : configDirsInPs(stdout)),
    );
  });
}

export interface DiscoverSources {
  home?: string;
  /** Where processes' `CLAUDE_CONFIG_DIR`s come from; by default the platform's process list, none on Windows. */
  processDirs?: () => Promise<string[]>;
}

function platformProcessDirs(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform === "linux") return linuxProcessDirs();
  if (platform === "darwin") return macProcessDirs();
  return Promise.resolve([]);
}

/**
 * The config directories Claude Code runs in on this machine: those running
 * processes were given in `CLAUDE_CONFIG_DIR`, spelled as they were given it,
 * which names the directory's stored sign-in, then `~/.claude` and the home
 * directory's `.claude-*` folders. Only directories with Claude Code's config
 * file count, and each once, by its first spelling.
 */
export async function discoverConfigDirs(sources: DiscoverSources = {}): Promise<string[]> {
  const home = sources.home ?? os.homedir();
  const running = await (sources.processDirs ?? platformProcessDirs)().catch(() => []);
  return keepConfigDirs([...running.filter((dir) => path.isAbsolute(dir)), ...homeConfigDirs(home)], home);
}

/** The config directories among `dirs`, each once, by its first spelling. */
export function keepConfigDirs(dirs: readonly string[], home: string = os.homedir()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const key = path.resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isConfigDir(dir, home)) out.push(dir);
  }
  return out;
}
