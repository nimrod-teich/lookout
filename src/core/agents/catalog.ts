// The agents Lookout knows: how each is named, coloured and drawn, and what
// Lookout can do with its sessions. Every place that names, colours or draws
// an agent reads this registry; nothing else hard-codes one. No vscode and no
// node imports: the webviews bundle it too.
import type { Host } from "../types";

/** What Lookout can do with an agent's sessions. The UI hides what an agent lacks. */
export interface Capabilities {
  /** Bring a session in a VS Code terminal to the front. */
  jumpTerminal: boolean;
  /** Bring a session in the agent's own editor tab to the front. */
  jumpPanel: boolean;
  /** Rename a session through the agent. */
  rename: boolean;
  /** Resume a session that is not running. */
  resume: boolean;
  /** Search and read the conversations. */
  search: boolean;
  /** Show the account's usage limits. */
  usage: boolean;
}

/** The agent's mark: a silhouette of our own, never a vendor's logo. */
export interface AgentGlyph {
  /** Its glyph in Lookout's icon font, written `$(name)` in the status bar and the jump list. */
  icon: string;
  /** The same silhouette as SVG path data in a 16-unit box, filled, for the webviews and the harbour. */
  path: string;
  /** Where on the silhouette the harbour hangs the boat's lantern: its masthead, the ferry's mast light. */
  lamp: [number, number];
}

export interface AgentInfo {
  /** The id its provider reports sessions with. */
  id: string;
  /** Short name for settings values and CSS: `lookout.statusBar.usageAgent`, `--agent-<key>`. */
  key: string;
  /** The plain name shown to the user. */
  label: string;
  /** CSS variable holding its accent hue in the webviews (media/*.css define it). */
  hue: string;
  /** The hue itself, where no CSS reaches (the status bar's hover), for dark and for light themes. */
  colors: { dark: string; light: string };
  glyph: AgentGlyph;
  capabilities: Capabilities;
}

const HULL = "M1 11.2h14l-2.4 3.2H3.4z";

/** The agents, Claude first. Sessions of an agent not listed here look and act as before the catalog. */
export const AGENTS: readonly AgentInfo[] = [
  {
    id: "claude-code",
    key: "claude",
    label: "Claude",
    hue: "--agent-claude",
    colors: { dark: "#f7906c", light: "#c2502a" },
    // A sloop: one mast, one sail.
    glyph: { icon: "lookout-sloop", path: `${HULL}M7.5 1h1.1v10.2H7.5zM7.1 2v8.3H2.3z`, lamp: [8, 11.2] },
    capabilities: { jumpTerminal: true, jumpPanel: true, rename: true, resume: true, search: true, usage: true },
  },
  {
    id: "codex",
    key: "codex",
    label: "Codex",
    hue: "--agent-codex",
    colors: { dark: "#7ae8df", light: "#14a093" },
    // A cutter: one mast, a mainsail aft and a headsail forward.
    glyph: { icon: "lookout-cutter", path: `${HULL}M6.4 1h1.1v10.2H6.4zM6 2.2v8.1H1.6zM7.9 3l6 7.3h-6z`, lamp: [6.95, 1.4] },
    capabilities: { jumpTerminal: true, jumpPanel: false, rename: false, resume: true, search: true, usage: true },
  },
  {
    id: "copilot",
    key: "copilot",
    label: "Copilot",
    hue: "--agent-copilot",
    colors: { dark: "#9373ea", light: "#5a35c8" },
    // A ferry: a long hull, two decks with a row of windows, a funnel.
    glyph: { icon: "lookout-ferry", path: "M.6 10.4h14.8l-1.8 4H2.4zM2.4 7.2h10.8v3.2H2.4zM3.6 8.2v1.2h1.4V8.2zm2.7 0v1.2h1.4V8.2zm2.7 0v1.2h1.4V8.2zM4.4 4.6h6v2.6h-6zM10.9 2.6h1.6v4.6h-1.6z", lamp: [7.4, 3.9] },
    capabilities: { jumpTerminal: true, jumpPanel: false, rename: false, resume: false, search: true, usage: false },
  },
];

const ALL: Capabilities = { jumpTerminal: true, jumpPanel: true, rename: true, resume: true, search: true, usage: true };

/** An agent the catalog does not list: named by its id, in the neutral colour, with every action as before. */
function unlisted(id: string): AgentInfo {
  return { id, key: id, label: id, hue: "--agent-other", colors: { dark: "#9fb0c0", light: "#717171" }, glyph: AGENTS[0]!.glyph, capabilities: ALL };
}

const BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

/** The agent a provider id names. */
export function agentInfo(id: string): AgentInfo {
  return BY_ID.get(id) ?? unlisted(id);
}

/** The agent a settings value names (`claude`, `codex`, `copilot`). */
export function agentByKey(key: string): AgentInfo | undefined {
  return AGENTS.find((agent) => agent.key === key);
}

/** Whether to tell agents apart in the UI: `auto` does once the board shows two or more agents. */
export type MarkerSetting = "auto" | "always" | "never";

export function markerSetting(value: unknown): MarkerSetting {
  return value === "always" || value === "never" ? value : "auto";
}

/**
 * Markers (each agent's hue and silhouette, its name in hovers and lists)
 * show when the user asks for them, or, by default, once the board shows two
 * or more agents (`agents`: the agent of every running session, earlier
 * session and usage group): a single-agent user sees no marker at all.
 */
export function markersShown(setting: MarkerSetting, agents: Iterable<string>): boolean {
  if (setting === "always") return true;
  if (setting === "never") return false;
  return new Set(agents).size >= 2;
}

/** What the board shows of one agent: a session, or a usage group with its limits. */
interface OnBoard {
  agent: string;
}

/**
 * The agents the board shows: those of its running sessions, of its earlier
 * sessions and of the usage groups with limits to show (Claude's group is
 * there even when it has none).
 */
export function boardAgents(board: { sessions: readonly OnBoard[]; past: readonly OnBoard[]; usage: readonly (OnBoard & { meters: readonly unknown[] })[] }): string[] {
  return [...board.sessions, ...board.past, ...board.usage.filter((group) => group.meters.length > 0)].map((item) => item.agent);
}

/**
 * Lookout can bring the session forward: its agent's tab or its terminal,
 * as the agent allows. A session in another window goes through that window,
 * which knows which of the two it is; one outside VS Code gets told so.
 */
export function canJump(view: { agent: string; host: Host }): boolean {
  const can = agentInfo(view.agent).capabilities;
  switch (view.host) {
    case "panel":
      return can.jumpPanel;
    case "terminal":
      return can.jumpTerminal;
    case "window":
      return can.jumpPanel || can.jumpTerminal;
    case "elsewhere":
      return true;
  }
}

/** The agent renames its sessions for Lookout. */
export function canRename(view: { agent: string }): boolean {
  return agentInfo(view.agent).capabilities.rename;
}

/** The agent resumes this session that is not running, in this window. */
export function canResume(view: { agent: string; resumable: boolean }): boolean {
  return view.resumable && agentInfo(view.agent).capabilities.resume;
}
