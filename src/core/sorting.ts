// How the board orders the sessions inside each group. No node imports: the board bundles it too.
import type { SessionView } from "./types";

/** At most this many sessions keep a place in the user's own order; the rest come first, as new ones do. */
const LIMIT = 500;

export type SortKey = "time" | "recent" | "name" | "project" | "tokens" | "cost" | "custom";

/** The order the user chose, and their own order of the sessions, kept for when they choose it. */
export interface SessionSort {
  by: SortKey;
  /** Session ids, in the order the user dragged them into. */
  order: string[];
}

export const DEFAULT_SORT: SessionSort = { by: "time", order: [] };

/** The orders on offer, as the sort menu lists them; `short` is what the board's chip says. */
export const SORTS: readonly { key: SortKey; label: string; short: string; detail: string }[] = [
  { key: "time", label: "Longest in its state first", short: "Time", detail: "Waited longest first in each group" },
  { key: "recent", label: "Latest change first", short: "Recent", detail: "Last state change first in each group" },
  { key: "name", label: "Name", short: "Name", detail: "By title, A to Z" },
  { key: "project", label: "Project", short: "Project", detail: "By project, then worktree, then title" },
  { key: "tokens", label: "Most tokens first", short: "Tokens", detail: "Input, output and cache together" },
  { key: "cost", label: "Most expensive first", short: "Price", detail: "At API list rates; sessions without a price last" },
  { key: "custom", label: "Your order", short: "Yours", detail: "Drag the cards to arrange them; new ones first" },
];

export function isSortKey(value: unknown): value is SortKey {
  return SORTS.some((sort) => sort.key === value);
}

/** The sort as stored, with anything unknown dropped. */
export function readSort(raw: unknown): SessionSort {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const order = Array.isArray(record.order) ? record.order.filter((id): id is string => typeof id === "string").slice(0, LIMIT) : [];
  return { by: isSortKey(record.by) ? record.by : "time", order };
}

const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/** Every token a session used; none counted while it has no spend yet. */
export function tokensOf(view: SessionView): number {
  const spend = view.spend;
  return spend ? spend.input + spend.output + spend.cacheRead + spend.cacheWrite : 0;
}

/**
 * The sessions in the chosen order. Groups are made from this order and keep
 * it, so only the order inside a group counts. "time" keeps the order the
 * sessions come in: the extension's, longest in its state first.
 */
export function orderViews(views: readonly SessionView[], sort: SessionSort): SessionView[] {
  switch (sort.by) {
    case "time":
      return [...views];
    case "recent":
      return [...views].sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
    case "name":
      return [...views].sort((a, b) => text(a.title, b.title));
    case "project":
      return [...views].sort((a, b) => text(a.project, b.project) || text(a.worktree ?? "", b.worktree ?? "") || text(a.title, b.title));
    case "tokens":
      return [...views].sort((a, b) => tokensOf(b) - tokensOf(a));
    case "cost":
      // A session whose model has no price goes after every priced one, by its tokens.
      return [...views].sort((a, b) => (b.spend?.costUsd ?? -1) - (a.spend?.costUsd ?? -1) || tokensOf(b) - tokensOf(a));
    case "custom": {
      const rank = new Map(sort.order.map((id, i) => [id, i]));
      // Sessions without a place come first, as they came: new ones show at the top.
      return [...views].sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1));
    }
  }
}

/**
 * The user's order after a drag inside one group: `group` is that group's
 * sessions as shown, `moved` goes before `before` (to the end without one).
 * The group's sessions take the front of the order in their new places;
 * the others keep theirs, behind them, since groups never mix.
 */
export function dragInto(order: readonly string[], group: readonly string[], moved: string, before: string | undefined): string[] {
  const rest = group.filter((id) => id !== moved);
  const at = before === undefined ? rest.length : rest.indexOf(before);
  const placed = [...rest.slice(0, at < 0 ? rest.length : at), moved, ...rest.slice(at < 0 ? rest.length : at)];
  return [...placed, ...order.filter((id) => !placed.includes(id))].slice(0, LIMIT);
}
