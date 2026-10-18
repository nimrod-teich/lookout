// Codex's limits as Lookout's usage meters, labelled as Codex's /status labels them.
import type { UsageMeter } from "../../usage";
import type { RateWindow } from "./rollout";

const MINUTE = 60_000;

/**
 * A window's key and label. The 5-hour and the weekly windows take the keys
 * Lookout gives Claude's, so the same alerts (70% and 90% of the 5 hours,
 * 90% of the week) and the same status bar rules apply; the labels are
 * Codex's own: "5h limit", "Weekly limit".
 */
export function windowOf(minutes: number | undefined, fallback: "primary" | "secondary"): { key: string; label: string; windowMs?: number } {
  if (minutes === 300) return { key: "session", label: "5h limit", windowMs: 300 * MINUTE };
  if (minutes === 10_080) return { key: "weekly_all", label: "Weekly limit", windowMs: 10_080 * MINUTE };
  if (minutes === undefined) return { key: fallback, label: fallback === "primary" ? "Limit" : "Second limit" };
  const label = minutes % 1440 === 0 ? `${minutes / 1440}d limit` : minutes % 60 === 0 ? `${minutes / 60}h limit` : `${minutes}m limit`;
  return { key: `window:${minutes}`, label, windowMs: minutes * MINUTE };
}

/** The meters of a `rate_limits` reading, the primary window first. */
export function metersOf(limits: { primary?: RateWindow; secondary?: RateWindow }): UsageMeter[] {
  const meters: UsageMeter[] = [];
  for (const [which, window] of [["primary", limits.primary], ["secondary", limits.secondary]] as const) {
    if (!window) continue;
    meters.push({ ...windowOf(window.windowMinutes, which), percent: window.usedPercent, resetsAt: window.resetsAt });
  }
  return meters;
}
