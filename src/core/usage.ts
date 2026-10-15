import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** One usage limit: a window and how much of it is used. */
export interface UsageMeter {
  key: string;
  label: string;
  percent: number;
  /** Epoch ms when the window resets. */
  resetsAt?: number;
  /** Length of the window, for showing how far along it is. */
  windowMs?: number;
}

export interface UsageSnapshot {
  /** Epoch ms when the numbers were fetched from Anthropic. */
  fetchedAt: number;
  meters: UsageMeter[];
}

const HOUR = 3_600_000;
const WINDOWS: Record<string, { label: string; windowMs: number }> = {
  session: { label: "5h", windowMs: 5 * HOUR },
  weekly_all: { label: "Week", windowMs: 7 * 24 * HOUR },
  weekly_scoped: { label: "Week", windowMs: 7 * 24 * HOUR },
};
/** Older than this, the numbers are shown as stale. */
export const STALE_MS = HOUR;
/** A file modified this recently is parsed again on every read: a coarse clock can give two rewrites one mtime. */
const SETTLE_MS = 2_000;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function when(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Normalizes Anthropic's rate-limit object, as Claude Code caches it under
 * `cachedUsageUtilization.utilization` and returns it from `get_usage`.
 */
export function metersOf(limits: unknown): UsageMeter[] {
  if (typeof limits !== "object" || limits === null) return [];
  const o = limits as Record<string, unknown>;
  const meters: UsageMeter[] = [];
  if (Array.isArray(o.limits)) {
    for (const raw of o.limits) {
      if (typeof raw !== "object" || raw === null) continue;
      const limit = raw as Record<string, unknown>;
      const kind = typeof limit.kind === "string" ? limit.kind : "limit";
      const percent = num(limit.percent);
      if (percent === undefined) continue;
      const model = (limit.scope as { model?: { display_name?: unknown } } | undefined)?.model?.display_name;
      const known = WINDOWS[kind];
      const label = kind === "weekly_scoped" && typeof model === "string" ? `Week · ${model}` : (known?.label ?? kind);
      meters.push({ key: typeof model === "string" ? `${kind}:${model}` : kind, label, percent, resetsAt: when(limit.resets_at), windowMs: known?.windowMs });
    }
    if (meters.length) return meters;
  }
  for (const [field, kind] of [
    ["five_hour", "session"],
    ["seven_day", "weekly_all"],
  ] as const) {
    const raw = o[field];
    if (typeof raw !== "object" || raw === null) continue;
    const percent = num((raw as Record<string, unknown>).utilization);
    if (percent === undefined) continue;
    meters.push({ key: kind, label: WINDOWS[kind]!.label, percent, resetsAt: when((raw as Record<string, unknown>).resets_at), windowMs: WINDOWS[kind]!.windowMs });
  }
  return meters;
}

/** The usage Claude Code last cached in its config file, if it belongs to the signed-in account. */
export function parseUsageCache(config: unknown): UsageSnapshot | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const o = config as Record<string, unknown>;
  const cached = o.cachedUsageUtilization as Record<string, unknown> | undefined;
  if (typeof cached !== "object" || cached === null) return undefined;
  const fetchedAt = num(cached.fetchedAtMs);
  if (fetchedAt === undefined) return undefined;
  const account = (o.oauthAccount as { accountUuid?: unknown } | undefined)?.accountUuid;
  if (typeof account === "string" && typeof cached.accountUuid === "string" && account !== cached.accountUuid) return undefined;
  const meters = metersOf(cached.utilization);
  return meters.length ? { fetchedAt, meters } : undefined;
}

export function isStale(snapshot: UsageSnapshot, now: number): boolean {
  return now - snapshot.fetchedAt > STALE_MS;
}

/** Claude Code keeps its config file next to the config directory, or inside it when the directory is overridden. */
export function usageCacheFile(configDir: string, home: string = os.homedir()): string {
  const standard = path.join(home, ".claude");
  return path.resolve(configDir) === path.resolve(standard) ? path.join(home, ".claude.json") : path.join(configDir, ".claude.json");
}

/** Reads the cached usage, parsing the file only when it changed. It is replaced by rename, so it is polled, not watched. */
export class UsageCache {
  private signature = "";
  private snapshot: UsageSnapshot | undefined;

  constructor(private readonly file: string) {}

  read(): UsageSnapshot | undefined {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.signature = "";
      return (this.snapshot = undefined);
    }
    const signature = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (signature === this.signature && Date.now() - st.mtimeMs > SETTLE_MS) return this.snapshot;
    try {
      this.snapshot = parseUsageCache(JSON.parse(fs.readFileSync(this.file, "utf8")));
      this.signature = signature;
    } catch {
      // Mid-write or malformed; keep what we had and try again next time.
    }
    return this.snapshot;
  }
}

export type RefreshMode = "manual" | "auto" | "off";

/** In auto mode, numbers older than this are fetched again. */
const AUTO_AFTER_MS = 10 * 60_000;
/** But never more often than this, whatever the outcome. */
const MIN_ATTEMPT_GAP_MS = 5 * 60_000;

/** Whether an automatic refresh is due. */
export function shouldAutoRefresh(mode: RefreshMode, snapshot: UsageSnapshot | undefined, lastAttempt: number, now: number): boolean {
  if (mode !== "auto") return false;
  if (now - lastAttempt < MIN_ATTEMPT_GAP_MS) return false;
  return snapshot === undefined || now - snapshot.fetchedAt > AUTO_AFTER_MS;
}
