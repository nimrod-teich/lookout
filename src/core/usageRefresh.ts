import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { signInEnv, type ClaudeDir } from "./agents/claude/paths";
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

/** What the binary answered to Lookout's request. */
export type Answer =
  | { kind: "numbers"; snapshot: UsageSnapshot }
  /** Plan limits do not apply to its sign-in: an API key, Bedrock or Vertex, or a token without the profile scope. */
  | { kind: "no plan limits" }
  /** Plan limits apply, but it has no numbers: its fetch failed and nothing it cached is recent enough. */
  | { kind: "no numbers" }
  | { kind: "error"; message: string };

/** How a refresh went. */
export interface RefreshResult {
  /** The binary's answer; none when it gave none. */
  answer?: Answer;
  /** The usage endpoint answered 429, and asks for this long without another request: its Retry-After, as Claude Code reads it. */
  retryAfterMs?: number;
  /** Why it brought no numbers, as far as the binary says: for the log. */
  failure?: string;
}

const REQUEST_ID = "lookout-usage";
/** The arguments that start the binary without a session, a transcript, or MCP servers. */
const ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
/** Where the binary writes its debug log, the only place it says how its fetch went. */
const DEBUG_FLAG = "--debug-file";
/** Binaries that refused the debug flag: run without it from then on. */
const noDebugFlag = new Set<string>();
/** How much of the binary's stderr is kept, from the end, for the log. */
const STDERR_TAIL = 400;

/**
 * The environment for the binary: the directory's own sign-in (see
 * `signInEnv`). Claude Code reads `CLAUDE_CONFIG_DIR` as written, and
 * without it uses `~/.claude` and `~/.claude.json`; a token or API key in
 * the environment would win over the directory's sign-in, so neither goes.
 */
export function refreshEnv(env: NodeJS.ProcessEnv, dir: ClaudeDir): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const [name, value] of Object.entries(signInEnv(dir))) {
    if (value === null) delete out[name];
    else out[name] = value;
  }
  return out;
}

/**
 * Asks the Claude Code binary for the account's usage. The binary fetches it
 * with its own credentials and rewrites its cache, which is what Lookout then
 * reads. No model is called. Resolves once the binary has exited (or had a
 * moment to), with its answer and what its debug log says about the fetch:
 * a 429 and how long to wait, or why it failed.
 */
export async function refreshUsage(options: RefreshOptions): Promise<RefreshResult> {
  if (noDebugFlag.has(options.binary)) return (await run(options, false)).result;
  const first = await run(options, true);
  if (!first.debugFlagRefused) return first.result;
  // A binary older than the flag: it exits at once, having asked nothing.
  noDebugFlag.add(options.binary);
  return (await run(options, false)).result;
}

function run(options: RefreshOptions, debug: boolean): Promise<{ result: RefreshResult; debugFlagRefused: boolean }> {
  const spawn = options.spawn ?? nodeSpawn;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let dir: string | undefined;
  if (debug) {
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-usage-"));
    } catch {
      // No debug log: the answer alone still counts.
    }
  }
  const debugFile = dir ? path.join(dir, "debug.log") : undefined;
  const args = debugFile ? [...ARGS, DEBUG_FLAG, debugFile] : ARGS;
  return new Promise((resolve) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawn(options.binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...(options.env ? { env: options.env } : {}) });
    } catch (err) {
      removeLater(dir);
      resolve({ result: { failure: `could not start the binary: ${message(err)}` }, debugFlagRefused: false });
      return;
    }
    let buffer = "";
    let stderr = "";
    let settled = false;
    let answer: Answer | undefined;
    let timedOut = false;
    let startError: string | undefined;
    let exitCode: number | null | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.kill();
      const log = debugFile ? readQuietly(debugFile) : "";
      removeLater(dir);
      const found = readDebugLog(log);
      const debugFlagRefused = answer === undefined && stderr.includes(`unknown option '${DEBUG_FLAG}'`);
      const result: RefreshResult = { ...(answer ? { answer } : {}), ...(found.retryAfterMs !== undefined ? { retryAfterMs: found.retryAfterMs } : {}) };
      const failure = found.failure ?? (answer?.kind === "error" ? `it answered with an error: ${answer.message}` : answer ? undefined : processFailure(startError, timedOut, timeoutMs, exitCode, stderr));
      if (failure !== undefined) result.failure = failure;
      resolve({ result, debugFlagRefused });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, timeoutMs);
    child.on("error", (err) => {
      startError = err.message;
      finish();
    });
    child.on("close", (code) => {
      exitCode = code;
      finish();
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const parsed = answer ? undefined : parseResponse(line, now());
        if (!parsed) continue;
        // Answered: let it exit on its own, so its cache is written, but not for long.
        answer = parsed;
        grace = setTimeout(finish, options.exitGraceMs ?? 5_000);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.write(JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "get_usage", skip_behaviors: true } }) + "\n");
    child.stdin?.end();
  });
}

/** Why a binary that gave no answer gave none. */
function processFailure(startError: string | undefined, timedOut: boolean, timeoutMs: number, exitCode: number | null | undefined, stderr: string): string {
  if (startError !== undefined) return `could not start the binary: ${startError}`;
  if (timedOut) return `no answer within ${timeoutMs / 1000} s`;
  const said = stderr.trim().replace(/\s+/g, " ");
  return `it exited with code ${exitCode ?? "none"} and no answer${said ? `: ${said}` : ""}`;
}

/** The answer in a `control_response` line, if it is the answer to our request. */
export function parseResponse(line: string, fetchedAt: number): Answer | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const response = (entry as { type?: unknown; response?: Record<string, unknown> })?.response;
  if ((entry as { type?: unknown }).type !== "control_response" || typeof response !== "object" || response === null) return undefined;
  if (response.request_id !== REQUEST_ID) return undefined;
  if (response.subtype !== "success") return { kind: "error", message: typeof response.error === "string" ? response.error : "no message" };
  const payload = response.response as Record<string, unknown> | undefined;
  if (payload?.rate_limits_available === false) return { kind: "no plan limits" };
  const meters = metersOf(payload?.rate_limits);
  return meters.length ? { kind: "numbers", snapshot: { fetchedAt, meters } } : { kind: "no numbers" };
}

/** What the binary's debug log says about its usage fetch. */
export interface DebugFindings {
  /** The endpoint answered 429; the binary holds off this long, from the response's Retry-After (5 minutes without one, an hour at most). */
  retryAfterMs?: number;
  /** Why the fetch failed, in the binary's words. */
  failure?: string;
}

/** Claude Code's log line when the endpoint refuses: `fetchUtilization: 429 remembered for this bearer; not asking again for 300s`. */
const REMEMBERED = /fetchUtilization: (\d{3}) remembered for this bearer; not asking again for (\d+)s/g;
const FAILED = /Failed to load usage data: (.+)/g;

/** Reads the lines of Claude Code's debug log that say how its usage fetch went; a log without them says nothing. */
export function readDebugLog(log: string): DebugFindings {
  const findings: DebugFindings = {};
  for (const [, status, seconds] of log.matchAll(REMEMBERED)) {
    if (status === "429") findings.retryAfterMs = Number(seconds) * 1000;
    else findings.failure = `the usage endpoint answered ${status}`;
  }
  for (const [, why] of log.matchAll(FAILED)) findings.failure = why!.trim();
  return findings;
}

function readQuietly(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Removes the debug log's folder; on Windows a binary just stopped can hold it a moment longer. */
function removeLater(dir: string | undefined): void {
  if (dir) fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {});
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
