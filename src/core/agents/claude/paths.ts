import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ConfigDirSources {
  /** Lookout's own setting. */
  setting?: string;
  /** `CLAUDE_CONFIG_DIR` the Claude Code extension passes to its sessions. */
  claudeExtensionEnv?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function expandHome(p: string, home: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p;
}

/** The Claude Code config directory, `~/.claude` unless something overrides it. */
export function resolveConfigDir(sources: ConfigDirSources = {}): string {
  const home = sources.home ?? os.homedir();
  const env = sources.env ?? process.env;
  const chosen = sources.setting?.trim() || sources.claudeExtensionEnv?.trim() || env.CLAUDE_CONFIG_DIR?.trim();
  return chosen ? path.resolve(expandHome(chosen, home)) : path.join(home, ".claude");
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
