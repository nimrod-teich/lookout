// How the board makes its sections: by state, or by what the sessions share.
// No node imports: the board bundles it too.
import { agentInfo } from "./agents/catalog";
import { shortModel } from "./format";
import type { SessionView, State } from "./types";

export type GroupBy = "state" | "project" | "branch" | "model" | "agent" | "window";

/** The groupings on offer, as the menu lists them; `short` is what the board's chip says. */
export const GROUPINGS: readonly { key: GroupBy; label: string; short: string; detail: string }[] = [
  { key: "state", label: "State", short: "State", detail: "Needs you, Finished, Working, Idle" },
  { key: "project", label: "Project", short: "Project", detail: "Worktrees of one repository together" },
  { key: "branch", label: "Branch", short: "Branch", detail: "The git branch each session works on" },
  { key: "model", label: "Model", short: "Model", detail: "The model of each session's last reply" },
  { key: "agent", label: "Agent", short: "Agent", detail: "Claude Code, Codex, Copilot" },
  { key: "window", label: "Window", short: "Window", detail: "This window, other windows, outside VS Code" },
];

export function isGroupBy(value: unknown): value is GroupBy {
  return GROUPINGS.some((grouping) => grouping.key === value);
}

/** The grouping as stored; state when it is not one on offer. */
export function readGroupBy(raw: unknown): GroupBy {
  return isGroupBy(raw) ? raw : "state";
}

/** One section of the board: its id names the grouping and the value, `project:api`. */
export interface Section {
  id: string;
  label: string;
  views: SessionView[];
  /** For a section by attribute: how many of its sessions are in each state. */
  summary?: Partial<Record<State, number>>;
}

/** What a section is missing when a session has no value for the grouping. */
const NONE: Record<Exclude<GroupBy, "state">, string> = { project: "No project", branch: "No branch", model: "No model yet", agent: "No agent", window: "No window" };

/** The session's value for a grouping, as its section's label; none when it has none. */
export function groupValue(view: SessionView, by: Exclude<GroupBy, "state">): string | undefined {
  switch (by) {
    case "project":
      return view.project || undefined;
    case "branch":
      return view.branch || undefined;
    case "model":
      return view.model ? shortModel(view.model) : undefined;
    case "agent":
      return agentInfo(view.agent).label;
    case "window":
      switch (view.host) {
        case "panel":
        case "terminal":
          return "This window";
        case "window":
          return view.windowLabel ? `Window: ${view.windowLabel}` : "Another window";
        case "editor":
          return "Window without Lookout";
        case "elsewhere":
          return "Outside VS Code";
      }
  }
}

const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/**
 * The board's sections for a grouping by attribute, in the order the views
 * come: the sessions that need the user first, pinned under their own
 * heading whatever the grouping, then one section per value, A to Z, with
 * the sessions that have no value last, then the parked sessions.
 */
export function sectionsBy(views: readonly SessionView[], by: Exclude<GroupBy, "state">): Section[] {
  const waiting: SessionView[] = [];
  const parked: SessionView[] = [];
  const byValue = new Map<string, SessionView[]>();
  let none: SessionView[] = [];
  for (const view of views) {
    if (view.parked) parked.push(view);
    else if (view.state === "waiting") waiting.push(view);
    else {
      const value = groupValue(view, by);
      if (value === undefined) none = [...none, view];
      else byValue.set(value, [...(byValue.get(value) ?? []), view]);
    }
  }
  const section = (id: string, label: string, list: SessionView[]): Section => {
    const summary: Partial<Record<State, number>> = {};
    for (const view of list) summary[view.state] = (summary[view.state] ?? 0) + 1;
    return { id, label, views: list, summary };
  };
  const sections = [...byValue].sort(([a], [b]) => text(a, b)).map(([value, list]) => section(`${by}:${value}`, value, list));
  if (none.length) sections.push(section(`${by}:`, NONE[by], none));
  return [...(waiting.length ? [{ id: "waiting", label: "Needs you", views: waiting }] : []), ...sections, ...(parked.length ? [{ id: "parked", label: "Parked", views: parked }] : [])];
}
