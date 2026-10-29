import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PolledJson } from "./polledJson";

/** One usage limit: a window and how much of it is used. */
export interface UsageMeter {
  /** Id of the agent whose limit it is; set where the numbers are grouped per agent. */
  agent?: string;
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

/** What the cache says: numbers, nothing, or something Lookout won't show. */
export type UsageRead = { snapshot: UsageSnapshot } | { snapshot: undefined; why: "missing" | "unreadable" | "other account" };

const HOUR = 3_600_000;
/** Labelled as Claude Code's panel labels them. */
const WINDOWS: Record<string, { label: string; windowMs: number }> = {
  session: { label: "Session (5hr)", windowMs: 5 * HOUR },
  weekly_all: { label: "Weekly (7 day)", windowMs: 7 * 24 * HOUR },
  weekly_scoped: { label: "Weekly", windowMs: 7 * 24 * HOUR },
};
/**
 * Numbers older than this are shown as stale. A working automatic refresh
 * never lets them get this old, so only numbers nothing refreshes reach it:
 * refresh off, manual, disabled or failing.
 */
export const STALE_MS = 30 * 60_000;
/** The families whose weekly limit the cache can carry on its own, as `seven_day_<family>`. */
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];

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
      const label = kind === "weekly_scoped" && typeof model === "string" ? `Weekly ${model}` : (known?.label ?? kind);
      meters.push({ key: typeof model === "string" ? `${kind}:${model}` : kind, label, percent, resetsAt: when(limit.resets_at), windowMs: known?.windowMs });
    }
    if (meters.length) return meters;
  }
  const fields: [string, string, string | undefined][] = [
    ["five_hour", "session", undefined],
    ["seven_day", "weekly_all", undefined],
    ...MODEL_FAMILIES.map((family): [string, string, string] => [`seven_day_${family}`, "weekly_scoped", `${family[0]!.toUpperCase()}${family.slice(1)}`]),
  ];
  for (const [field, kind, model] of fields) {
    const raw = o[field];
    if (typeof raw !== "object" || raw === null) continue;
    const percent = num((raw as Record<string, unknown>).utilization);
    if (percent === undefined) continue;
    const window = WINDOWS[kind]!;
    meters.push({ key: model ? `${kind}:${model}` : kind, label: model ? `${window.label} ${model}` : window.label, percent, resetsAt: when((raw as Record<string, unknown>).resets_at), windowMs: window.windowMs });
  }
  return meters;
}

/** The usage Claude Code last cached in its config file, if it belongs to the signed-in account. */
export function parseUsageCache(config: unknown): UsageSnapshot | undefined {
  const read = readUsageCache(config);
  return read.snapshot;
}

/** The cached usage, or why there is none to show. Numbers for another account are never shown. */
export function readUsageCache(config: unknown): UsageRead {
  if (typeof config !== "object" || config === null) return { snapshot: undefined, why: "unreadable" };
  const o = config as Record<string, unknown>;
  const cached = o.cachedUsageUtilization as Record<string, unknown> | undefined;
  if (typeof cached !== "object" || cached === null) return { snapshot: undefined, why: "missing" };
  const fetchedAt = num(cached.fetchedAtMs);
  if (fetchedAt === undefined) return { snapshot: undefined, why: "unreadable" };
  const account = (o.oauthAccount as { accountUuid?: unknown } | undefined)?.accountUuid;
  if (typeof account === "string" && typeof cached.accountUuid === "string" && account !== cached.accountUuid) return { snapshot: undefined, why: "other account" };
  const meters = metersOf(cached.utilization);
  return meters.length ? { snapshot: { fetchedAt, meters } } : { snapshot: undefined, why: "unreadable" };
}

/** A window reset after the numbers were fetched: what they say about it is over. */
export function resetPassed(snapshot: UsageSnapshot, now: number): boolean {
  return snapshot.meters.some((meter) => meter.resetsAt !== undefined && meter.resetsAt > snapshot.fetchedAt && meter.resetsAt <= now);
}

/** Numbers too old to go by: older than half an hour, or from before a window reset. */
export function isStale(snapshot: UsageSnapshot, now: number): boolean {
  return now - snapshot.fetchedAt > STALE_MS || resetPassed(snapshot, now);
}

/** Claude Code keeps its config file next to the config directory, or inside it when the directory is overridden. */
export function usageCacheFile(configDir: string, home: string = os.homedir()): string {
  const standard = path.join(home, ".claude");
  return path.resolve(configDir) === path.resolve(standard) ? path.join(home, ".claude.json") : path.join(configDir, ".claude.json");
}

/**
 * Reads the cached usage, parsing the file only when it changed. A torn write
 * keeps the last numbers for a moment; a file that still does not parse once
 * it settled shows none.
 */
export class UsageCache {
  private readonly file: PolledJson<UsageRead>;

  constructor(file: string) {
    this.file = new PolledJson<UsageRead>(file, readUsageCache, { snapshot: undefined, why: "missing" }, { snapshot: undefined, why: "unreadable" });
  }

  read(): UsageSnapshot | undefined {
    return this.readWithReason().snapshot;
  }

  readWithReason(): UsageRead {
    return this.file.read();
  }
}

export type RefreshMode = "manual" | "auto" | "off";

/** In auto mode, numbers older than this are fetched again. */
export const AUTO_AFTER_MS = 10 * 60_000;

/** Whether the numbers want an automatic refresh: none to show, older than 10 minutes, or from before a reset. */
export function wantsRefresh(mode: RefreshMode, snapshot: UsageSnapshot | undefined, now: number): boolean {
  if (mode !== "auto") return false;
  return snapshot === undefined || now - snapshot.fetchedAt > AUTO_AFTER_MS || resetPassed(snapshot, now);
}

/** Claude Code's switch for network calls a session can do without, which fetching usage is. */
export const NONESSENTIAL_TRAFFIC = "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";

/** An environment variable that switches something on: set, and not empty, 0, false, no or off. */
export function envFlag(value: unknown): boolean {
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  return typeof value === "string" && value.trim() !== "" && !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/**
 * The `env` of Claude Code's settings file, `<config>/settings.json`: read,
 * never written, and parsed again only when the file changes, so it can be
 * asked before every refresh.
 */
export class ClaudeSettingsEnv {
  private signature = "";
  private env: Record<string, unknown> = {};

  constructor(private readonly file: string) {}

  get(name: string): unknown {
    let signature: string;
    try {
      const st = fs.statSync(this.file);
      signature = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      this.signature = "";
      this.env = {};
      return undefined;
    }
    if (signature !== this.signature) {
      this.signature = signature;
      try {
        const env = (JSON.parse(fs.readFileSync(this.file, "utf8")) as { env?: unknown }).env;
        this.env = typeof env === "object" && env !== null ? (env as Record<string, unknown>) : {};
      } catch {
        // Being rewritten, or not JSON: no variables until it parses.
        this.env = {};
        this.signature = "";
      }
    }
    return this.env[name];
  }
}
