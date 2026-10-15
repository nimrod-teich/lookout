import { spawn as nodeSpawn } from "node:child_process";
import { metersOf, type UsageSnapshot } from "./usage";

export interface RefreshOptions {
  /** The Claude Code binary. */
  binary: string;
  timeoutMs?: number;
  spawn?: typeof nodeSpawn;
  now?: () => number;
}

const REQUEST_ID = "lookout-usage";
/** The arguments that start the binary without a session, a transcript, or MCP servers. */
const ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

/**
 * Asks the Claude Code binary for the account's usage. The binary fetches it
 * with its own credentials and rewrites its cache; Lookout only reads the
 * answer. No model is called. Resolves undefined when the binary gives no
 * usable answer within the timeout.
 */
export function refreshUsage(options: RefreshOptions): Promise<UsageSnapshot | undefined> {
  const spawn = options.spawn ?? nodeSpawn;
  const now = options.now ?? Date.now;
  return new Promise((resolve) => {
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawn(options.binary, ARGS, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    let buffer = "";
    let settled = false;
    const finish = (snapshot: UsageSnapshot | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(snapshot);
    };
    const timer = setTimeout(() => finish(undefined), options.timeoutMs ?? 20_000);
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(undefined));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const snapshot = parseResponse(line, now());
        if (snapshot) finish(snapshot);
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
