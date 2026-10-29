// Usage as the UI shows it: one group per agent, and the one bar the status
// bar has room for. No node imports: the board bundles it too.
import { AGENTS, agentByKey, agentInfo } from "./agents/catalog";
import type { UsageMeter } from "./usage";

/** One agent's limits, or one account's when the agent is watched in several. */
export interface UsageGroup {
  /** Id of the agent the numbers belong to. */
  agent: string;
  /** Names the group among the others, `claude-code:personal`; none for an agent watched in one account, whose id names it. */
  key?: string;
  /** The label of the agent's account the numbers belong to, when the agent is watched in several. */
  account?: string;
  /** The labels of the other directories signed in to the same account: these numbers are theirs too. */
  also?: string[];
  /** Epoch ms the numbers were fetched; none when there are none to show. */
  fetchedAt?: number;
  /** Old, and nothing will bring them up to date. */
  stale: boolean;
  meters: UsageMeter[];
  /** Lookout can have the agent fetch fresh numbers. */
  canRefresh?: boolean;
  /** Why there are no numbers, when Lookout knows: said in place of "No usage reported". */
  note?: string;
}

/** Which agent's bar the status bar shows: `auto`, an agent's key (`claude`, `codex`, `copilot`), or one account's (`claude:personal`). */
export type UsageAgentSetting = string;

/** What names a group among the others: its key, else its agent. */
export function groupKey(group: { agent?: string; key?: string }): string {
  return group.key ?? group.agent ?? AGENTS[0]!.id;
}

/** The agent and the account a pin names: `claude`, or `claude:personal`; none for `auto` or an agent the catalog does not list. */
export function parsePin(setting: UsageAgentSetting): { agent: string; account?: string } | undefined {
  if (setting === "auto") return undefined;
  const at = setting.indexOf(":");
  const agent = agentByKey(at < 0 ? setting : setting.slice(0, at));
  if (!agent) return undefined;
  const account = at < 0 ? undefined : setting.slice(at + 1);
  return account ? { agent: agent.id, account } : { agent: agent.id };
}

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
 * The group whose bar the status bar shows. A pinned agent's, or account's,
 * when it has numbers (of an agent's several accounts, the one under the
 * most pressure); otherwise the window under the most pressure: the highest
 * share used among the bars, fresh numbers before stale ones, catalog order
 * on a tie, then the order the groups come in.
 */
export function pickBar(groups: readonly UsageGroup[], setting: UsageAgentSetting = "auto"): { group: UsageGroup; meter: UsageMeter } | undefined {
  const bars = groups.flatMap((group) => {
    const meter = barMeter(group.meters);
    return meter ? [{ group, meter }] : [];
  });
  const pressure = (list: typeof bars) => [...list].sort((a, b) => Number(a.group.stale) - Number(b.group.stale) || b.meter.percent - a.meter.percent || order(a.group.agent) - order(b.group.agent))[0];
  const pin = parsePin(setting);
  const pinned = pin && pressure(bars.filter((bar) => bar.group.agent === pin.agent && (pin.account === undefined || bar.group.account === pin.account)));
  return pinned ?? pressure(bars);
}

/** The groups in catalog order. */
export function sortGroups<T extends { agent?: string }>(groups: readonly T[]): T[] {
  return [...groups].sort((a, b) => order(a.agent ?? AGENTS[0]!.id) - order(b.agent ?? AGENTS[0]!.id));
}

/** The limit closest to running out: the highest share used, the first of equals. */
export function peakMeter(meters: readonly UsageMeter[]): UsageMeter | undefined {
  return meters.reduce<UsageMeter | undefined>((peak, meter) => (peak === undefined || meter.percent > peak.percent ? meter : peak), undefined);
}

/**
 * What an agent's usage tab says: the limit that runs out first, the one the
 * status bar's bar shows (the session window for Claude and Codex); and, for
 * its hover, another limit when that one is closer to its end.
 */
export function tabMeters(meters: readonly UsageMeter[]): { shown?: UsageMeter; closest?: UsageMeter } {
  const shown = barMeter(meters);
  const peak = peakMeter(meters);
  return { shown, closest: shown && peak && peak.percent > shown.percent ? peak : undefined };
}

/**
 * The group whose limits the board lists, by key: the one picked last, else
 * the one the status bar's bar shows, else the first. A tab picked before the
 * agent had several accounts names the agent: its first account's group.
 */
export function chosenGroup<T extends { agent: string; key?: string }>(groups: readonly T[], picked?: string, bar?: string): T | undefined {
  const byKey = (key: string | undefined) => (key === undefined ? undefined : groups.find((group) => groupKey(group) === key));
  return byKey(picked) ?? byKey(bar) ?? groups.find((group) => group.agent === picked) ?? groups[0];
}

/** "Claude usage", or one account's: "Claude usage · personal", with the directories signed in to the same account. */
export function groupHeading(group: { agent: string; account?: string; also?: readonly string[] }): string {
  const heading = `${agentInfo(group.agent).label} usage`;
  if (!group.account) return heading;
  return `${heading} · ${group.account}${group.also?.length ? ` (also ${group.also.join(", ")})` : ""}`;
}
