export type ClaudeStatus = "busy" | "waiting" | "idle" | "shell";

/** The contents of `<config>/sessions/<pid>.json`, one file per Claude Code process. */
export interface SessionFile {
  pid: number;
  sessionId: string;
  /** Directory the process was launched in. It does not follow `cd`. */
  cwd: string;
  startedAt?: number;
  kind?: string;
  entrypoint?: string;
  status?: ClaudeStatus;
  waitingFor?: string;
  needs?: string;
  statusUpdatedAt?: number;
  procStart?: string;
  pidDomain?: string;
  spare: boolean;
}

const STATUSES: readonly string[] = ["busy", "waiting", "idle", "shell"];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parses a session file. Returns null for anything that is not a usable
 * record: the files are rewritten in place, so a read can be torn.
 */
export function parseSessionFile(text: string): SessionFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const pid = num(o.pid);
  const sessionId = str(o.sessionId);
  const cwd = str(o.cwd);
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || !sessionId || !cwd) return null;
  const status = str(o.status);
  return {
    pid,
    sessionId,
    cwd,
    startedAt: num(o.startedAt),
    kind: str(o.kind),
    entrypoint: str(o.entrypoint),
    status: status !== undefined && STATUSES.includes(status) ? (status as ClaudeStatus) : undefined,
    waitingFor: str(o.waitingFor),
    needs: str(o.needs),
    statusUpdatedAt: num(o.statusUpdatedAt),
    procStart: str(o.procStart),
    pidDomain: str(o.pidDomain),
    spare: o.spare === true,
  };
}
