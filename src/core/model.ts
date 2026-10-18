import type { AgentSession, PastSession } from "./agents/agent";
import { canJump } from "./agents/catalog";
import { within } from "./folders";
import type { Host, PastView, SessionView, State } from "./types";
import type { OtherWindow } from "./windows";

const WORKTREE = /^(.*)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/;
const STATE_ORDER: Record<State, number> = { waiting: 0, done: 1, working: 2, unknown: 3, idle: 4 };

/** The title of a session that has no conversation yet: an open tab or terminal with nothing sent. */
export const EMPTY_TAB = "Empty tab";
export const EMPTY_TERMINAL = "Empty session";
/** @deprecated The empty-tab label; kept for the tests that name it. */
export const UNTITLED = EMPTY_TAB;

/** Last segment of a path written with either separator, whatever platform this runs on. */
function baseName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? dir;
}

/** Splits a directory into its project and, inside a Claude Code worktree, the worktree name. */
export function projectOf(cwd: string): { project: string; worktree?: string } {
  const match = WORKTREE.exec(cwd);
  if (match?.[1] && match[2]) return { project: baseName(match[1]), worktree: match[2] };
  return { project: baseName(cwd) };
}

/** What Lookout knows about the window it serves. */
export interface WindowContext {
  /** Pid of the extension host; an agent panel's sessions descend from it. */
  hostPid: number;
  /** Shell pids of the window's integrated terminals. */
  terminalPids: ReadonlySet<number>;
  /** Extension host pids of the other VS Code windows on this host, with their names and terminals. */
  windows: ReadonlyMap<number, OtherWindow>;
  /** The window's folders: a session VS Code runs in its Chat view is the window's when it works in one of them. */
  folders?: readonly string[];
}

interface Location {
  host: Host;
  terminalPid?: number;
  windowLabel?: string;
  windowPid?: number;
}

function locate(session: AgentSession, ancestors: readonly number[], ctx: WindowContext): Location {
  // VS Code runs it in its agent host, which serves every window: it is the window's whose folders hold it.
  if (session.vscodeSession) {
    if (session.cwd && within(session.cwd, ctx.folders ?? [])) return { host: "panel" };
    for (const [pid, other] of ctx.windows) {
      if (pid !== ctx.hostPid && session.cwd && within(session.cwd, other.folders ?? [])) return { host: "window", windowLabel: other.label, windowPid: pid };
    }
    return { host: "editor" };
  }
  if (session.panel && ancestors.includes(ctx.hostPid)) return { host: "panel" };
  const terminalPid = ancestors.find((pid) => ctx.terminalPids.has(pid));
  if (terminalPid !== undefined) return { host: "terminal", terminalPid };
  // Another window's: in its panel, under its extension host, or in one of its terminals; placed as that window places it.
  for (const pid of ancestors) {
    if (pid === ctx.hostPid) continue;
    const window = ctx.windows.get(pid);
    if (window && session.panel) return { host: "window", windowLabel: window.label, windowPid: pid };
    for (const [windowPid, other] of ctx.windows) {
      if (windowPid !== ctx.hostPid && other.terminals.includes(pid)) return { host: "window", windowLabel: other.label, windowPid };
    }
  }
  // An agent's panel in no window Lookout knows: one where Lookout does not run.
  if (session.panel) return { host: "editor" };
  return { host: "elsewhere" };
}

/** A session this window can bring to the front. */
export function isHere(view: SessionView): boolean {
  return view.host === "panel" || view.host === "terminal";
}

/**
 * The session to jump to after `lastId` among those that need attention here
 * and that their agent lets Lookout bring forward:
 * the next one in attention order, wrapping around, or the first when `lastId`
 * is not among them any more.
 */
export function nextAttention(views: readonly SessionView[], lastId: string | undefined): SessionView | undefined {
  const candidates = views.filter((view) => (view.state === "waiting" || view.state === "done") && isHere(view) && canJump(view));
  if (candidates.length === 0) return undefined;
  const index = candidates.findIndex((view) => view.id === lastId);
  return candidates[(index + 1) % candidates.length];
}

export function buildView(session: AgentSession, ancestors: readonly number[], ctx: WindowContext): SessionView {
  return {
    id: session.id,
    agent: session.agent,
    pid: session.pid,
    title: session.title ?? (session.panel ? EMPTY_TAB : EMPTY_TERMINAL),
    state: session.status,
    since: session.since,
    reason: session.status === "waiting" ? session.reason : undefined,
    evidence: session.evidence,
    question: session.status === "idle" ? session.question : undefined,
    lastWriteAt: session.lastWriteAt,
    ...projectOf(session.cwd),
    cwd: session.cwd,
    ...locate(session, ancestors, ctx),
    ...(session.vscodeSession ? { vscodeSession: session.vscodeSession } : {}),
    activity: session.activity,
    agents: session.agents ?? 0,
    empty: session.empty,
    branch: session.branch,
    model: session.model,
    effort: session.effort,
    background: session.background,
    contextTokens: session.contextTokens,
    contextWindow: session.contextWindow,
    pulse: session.pulse,
    pulseMarks: session.pulseMarks,
    spend: session.spend,
  };
}

/** The view of a session that is not running. */
export function buildPastView(session: PastSession): PastView {
  return { id: session.id, agent: session.agent, title: session.title, ...projectOf(session.cwd), branch: session.branch, cwd: session.cwd, resumable: session.resumable, modifiedAt: session.modifiedAt, ...(session.resumesIn ? { resumesIn: session.resumesIn } : {}), ...(session.vscodeSession ? { vscodeSession: session.vscodeSession } : {}) };
}

/** The agent's tabs open in a window: their labels, and the label it gives a title. */
export interface AgentTabs {
  labels: readonly string[];
  label(title: string): string;
}

/**
 * The earlier sessions whose agent tab is open in this window, as idle
 * sessions not started yet: after a reload the agent restores its tabs but
 * starts a session only once its tab is opened. Each tab not held by a
 * running session of this window's panel takes the newest resumable session
 * its label fits.
 */
export function restoredTabViews(past: readonly PastView[], live: readonly SessionView[], tabs: AgentTabs): SessionView[] {
  const open = [...tabs.labels];
  for (const view of live) {
    if (view.host !== "panel") continue;
    const at = open.indexOf(tabs.label(view.title));
    if (at >= 0) open.splice(at, 1);
  }
  const taken = new Set(live.map((view) => view.id));
  const out: SessionView[] = [];
  for (const label of open) {
    const view = past.find((p) => p.resumable && !taken.has(p.id) && tabs.label(p.title) === label);
    if (!view) continue;
    taken.add(view.id);
    out.push({
      id: view.id,
      agent: view.agent,
      pid: 0,
      title: view.title,
      state: "idle",
      since: view.modifiedAt,
      lastWriteAt: view.modifiedAt,
      evidence: { source: "transcript", at: view.modifiedAt, note: "its tab is open; the agent starts the session once the tab is opened" },
      project: view.project,
      worktree: view.worktree,
      branch: view.branch,
      cwd: view.cwd,
      host: "panel",
      agents: 0,
      restored: true,
    });
  }
  return out;
}

/** A prompt the agent reports blocks it; a question read from a reply does not, so it comes after. */
function typedRank(view: SessionView): number {
  return view.reason?.kind === "typed" ? 1 : 0;
}

/** What wants the user's attention first, each group ordered by how long it has been in its state. */
export function sortViews(views: readonly SessionView[]): SessionView[] {
  return [...views].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || typedRank(a) - typedRank(b) || (a.since ?? 0) - (b.since ?? 0) || a.id.localeCompare(b.id),
  );
}
