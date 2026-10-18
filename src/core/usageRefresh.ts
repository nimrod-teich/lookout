import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import { metersOf, type UsageSnapshot } from "./usage";

export interface RefreshOptions {
  /** The Claude Code binary. */
  binary: string;
  /** Its environment: the config directory the numbers are read from, so it fetches for that account and rewrites that cache. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** How long it may take to exit after answering, to finish writing its cache. */
  exitGraceMs?: number;
  spawn?: typeof nodeSpawn;
  now?: () => number;
}

const REQUEST_ID = "lookout-usage";
/** The arguments that start the binary without a session, a transcript, or MCP servers. */
const ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

/** The environment for the binary: Claude Code reads `CLAUDE_CONFIG_DIR`, and without it uses `~/.claude` and `~/.claude.json`. */
export function refreshEnv(env: NodeJS.ProcessEnv, configDir: string, standardDir: string): NodeJS.ProcessEnv {
  const out = { ...env };
  if (path.resolve(configDir) === path.resolve(standardDir)) delete out.CLAUDE_CONFIG_DIR;
  else out.CLAUDE_CONFIG_DIR = configDir;
  return out;
}

/**
 * Asks the Claude Code binary for the account's usage. The binary fetches it
 * with its own credentials and rewrites its cache, which is what Lookout then
 * reads. No model is called. Resolves with the answer once the binary has
 * exited (or had a moment to), or undefined when it gives no usable answer
 * within the timeout.
 */
export function refreshUsage(options: RefreshOptions): Promise<UsageSnapshot | undefined> {
  const spawn = options.spawn ?? nodeSpawn;
  const now = options.now ?? Date.now;
  return new Promise((resolve) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawn(options.binary, ARGS, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, ...(options.env ? { env: options.env } : {}) });
    } catch {
      resolve(undefined);
      return;
    }
    let buffer = "";
    let settled = false;
    let answer: UsageSnapshot | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.kill();
      resolve(answer);
    };
    const timer = setTimeout(finish, options.timeoutMs ?? 20_000);
    child.on("error", finish);
    child.on("close", finish);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const snapshot = answer ? undefined : parseResponse(line, now());
        if (!snapshot) continue;
        // Answered: let it exit on its own, so its cache is written, but not for long.
        answer = snapshot;
        grace = setTimeout(finish, options.exitGraceMs ?? 5_000);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.write(JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "get_usage", skip_behaviors: true } }) + "\n");
    child.stdin?.end();
  });
}

/** The usage in a `control_response` line, if it is the answer to our request. */
export function parseResponse(line: string, fetchedAt: number): UsageSnapshot | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const response = (entry as { type?: unknown; response?: Record<string, unknown> })?.response;
  if ((entry as { type?: unknown }).type !== "control_response" || typeof response !== "object" || response === null) return undefined;
  if (response.request_id !== REQUEST_ID || response.subtype !== "success") return undefined;
  const payload = response.response as Record<string, unknown> | undefined;
  const meters = metersOf(payload?.rate_limits);
  return meters.length ? { fetchedAt, meters } : undefined;
}
