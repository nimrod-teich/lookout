// What the worktrees page works out without the DOM: its sections, how long
// ago, which rows a filter keeps, their order, and the ticks after a new check.
import type { WorktreeRow, WorktreeTierView } from "./worktreesProtocol";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, short: "5m", "3h", "26d", "4mo", "2y". */
export function agoOf(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)}h`;
  if (ms < 60 * DAY) return `${Math.round(ms / DAY)}d`;
  if (ms < 730 * DAY) return `${Math.round(ms / (30 * DAY))}mo`;
  return `${Math.round(ms / (365 * DAY))}y`;
}

/** The time of day, "17:42". */
export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface Section {
  tier: WorktreeTierView;
  title: string;
  about: string;
  /** Its rows start ticked. */
  ticked: boolean;
  /** Its repositories start folded when there are several. */
  foldRepos: boolean;
}

/** The sections of the page, in order: what each tier is called and what it means. */
export const SECTIONS: readonly Section[] = [
  {
    tier: "safe",
    title: "Safe to remove",
    about:
      "Nothing in them is lost: no change, no untracked file, only ignored files a tool builds again, and every commit already on the default branch or on a remote. None has had git work in it in the last day. \"On a remote\" is as of each repository's last fetch, said by its name.",
    ticked: true,
    foldRepos: true,
  },
  {
    tier: "review",
    title: "For review",
    about: "Each can go, and its commits stay in its branch; read why it is here first.",
    ticked: false,
    foldRepos: false,
  },
  {
    tier: "gone",
    title: "Records with no folder",
    about: "Git still lists them, and keeps their branches checked out, but their folders are gone. Clearing a record frees no space.",
    ticked: true,
    foldRepos: false,
  },
  {
    tier: "keep",
    title: "Kept",
    about: "In use, or holding work only they have: Lookout does not remove them.",
    ticked: false,
    foldRepos: false,
  },
];

const TICKED_BY_DEFAULT = new Set<WorktreeTierView>(SECTIONS.filter((section) => section.ticked).map((section) => section.tier));

/**
 * The ticks after a check: a row the check left in its tier keeps the tick it
 * had, so a review pass survives Check again; a new row, or one the check
 * moved to another tier, gets its tier's own start.
 */
export function nextTicks(before: readonly WorktreeRow[], after: readonly WorktreeRow[], ticked: ReadonlySet<string>): Set<string> {
  const was = new Map(before.map((row) => [row.path, row.tier]));
  const next = new Set<string>();
  for (const row of after) {
    const same = was.get(row.path) === row.tier;
    if (same ? ticked.has(row.path) : TICKED_BY_DEFAULT.has(row.tier)) next.add(row.path);
  }
  return next;
}

/** The words of a filter, lower-cased; none for a blank one. */
export function filterWords(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether every word of the filter is in the row's name, branch, reason, folder, ignored files or repository. */
export function matchesFilter(row: WorktreeRow, words: readonly string[], repoName?: string): boolean {
  if (!words.length) return true;
  const text = [row.name, row.branch, row.reason, row.where, row.ignored?.join(" "), repoName].filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

export type SortBy = "size" | "age";

/** The rows in the order picked: the biggest first, or the oldest commit first (one with no commit last); the folder breaks ties. */
export function sortRows(rows: readonly WorktreeRow[], by: SortBy): WorktreeRow[] {
  return [...rows].sort((a, b) => {
    if (by === "age") {
      const at = (row: WorktreeRow) => row.headAt ?? Number.POSITIVE_INFINITY;
      if (at(a) !== at(b)) return at(a) - at(b);
    } else if (a.ownBytes !== b.ownBytes) return b.ownBytes - a.ownBytes;
    return a.path.localeCompare(b.path);
  });
}
