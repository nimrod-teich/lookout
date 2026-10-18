// Usage as the UI shows it: one group per agent, and the one bar the status
// bar has room for. No node imports: the board bundles it too.
import { AGENTS, agentByKey, agentInfo } from "./agents/catalog";
import type { UsageMeter } from "./usage";

/** One agent's limits. */
export interface UsageGroup {
  /** Id of the agent the numbers belong to. */
  agent: string;
  /** Epoch ms the numbers were fetched; none when there are none to show. */
  fetchedAt?: number;
  /** Old, and nothing will bring them up to date. */
  stale: boolean;
  meters: UsageMeter[];
  /** Lookout can have the agent fetch fresh numbers. */
  canRefresh?: boolean;
}

/** Which agent's bar the status bar shows: `auto`, or an agent's key (`claude`, `codex`, `copilot`). */
export type UsageAgentSetting = string;

/**
 * An agent's meter for the status bar's bar: its session window (`session`,
 * the 5-hour one), else its shortest window, else its first. The rest stay
 * in the hover.
 */
export function barMeter(meters: readonly UsageMeter[]): UsageMeter | undefined {
  const session = meters.find((meter) => meter.key === "session");
  if (session) return session;
  const timed = meters.filter((meter) => meter.windowMs !== undefined);
  if (timed.length) return timed.reduce((a, b) => (b.windowMs! < a.windowMs! ? b : a));
  return meters[0];
}

/** Catalog order, then the agents it does not list. */
function order(agent: string): number {
  const index = AGENTS.findIndex((info) => info.id === agent);
  return index < 0 ? AGENTS.length : index;
}

/**
 * The group whose bar the status bar shows. A pinned agent's, when it has
 * numbers; otherwise the window under the most pressure: the highest share
 * used among the agents' bars, fresh numbers before stale ones, catalog
 * order on a tie.
 */
export function pickBar(groups: readonly UsageGroup[], setting: UsageAgentSetting = "auto"): { group: UsageGroup; meter: UsageMeter } | undefined {
  const bars = groups.flatMap((group) => {
    const meter = barMeter(group.meters);
    return meter ? [{ group, meter }] : [];
  });
  const pinned = setting === "auto" ? undefined : agentByKey(setting);
  const chosen = pinned && bars.find((bar) => bar.group.agent === pinned.id);
  if (chosen) return chosen;
  return [...bars].sort((a, b) => Number(a.group.stale) - Number(b.group.stale) || b.meter.percent - a.meter.percent || order(a.group.agent) - order(b.group.agent))[0];
}

/** The groups in catalog order. */
export function sortGroups<T extends { agent?: string }>(groups: readonly T[]): T[] {
  return [...groups].sort((a, b) => order(a.agent ?? AGENTS[0]!.id) - order(b.agent ?? AGENTS[0]!.id));
}

/** "Claude usage". */
export function groupHeading(agent: string): string {
  return `${agentInfo(agent).label} usage`;
}
