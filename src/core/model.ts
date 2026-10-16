import type { AgentSession, PastSession } from "./agents/agent";
import type { Host, PastView, SessionView, State } from "./types";

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
  /** Extension host pids of the other VS Code windows on this host, with their names. */
  windows: ReadonlyMap<number, string>;
}

interface Location {
  host: Host;
  terminalPid?: number;
  windowLabel?: string;
}

function locate(session: AgentSession, ancestors: readonly number[], ctx: WindowContext): Location {
  if (session.panel && ancestors.includes(ctx.hostPid)) return { host: "panel" };
  const terminalPid = ancestors.find((pid) => ctx.terminalPids.has(pid));
  if (terminalPid !== undefined) return { host: "terminal", terminalPid };
  const windowPid = ancestors.find((pid) => pid !== ctx.hostPid && ctx.windows.has(pid));
  if (windowPid !== undefined) return { host: "window", windowLabel: ctx.windows.get(windowPid) };
  return { host: "elsewhere" };
}

/** A session this window can bring to the front. */
export function isHere(view: SessionView): boolean {
  return view.host === "panel" || view.host === "terminal";
}

/**
 * The session to jump to after `lastId` among those that need attention here:
 * the next one in attention order, wrapping around, or the first when `lastId`
 * is not among them any more.
 */
export function nextAttention(views: readonly SessionView[], lastId: string | undefined): SessionView | undefined {
  const candidates = views.filter((view) => (view.state === "waiting" || view.state === "done") && isHere(view));
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
    activity: session.activity,
    agents: session.agents ?? 0,
    lastReply: session.lastReply,
    model: session.model,
    contextTokens: session.contextTokens,
    contextWindow: session.contextWindow,
    pulse: session.pulse,
    spend: session.spend,
  };
}

/** The view of a session that is not running. */
export function buildPastView(session: PastSession): PastView {
  return { id: session.id, agent: session.agent, title: session.title, ...projectOf(session.cwd), cwd: session.cwd, modifiedAt: session.modifiedAt };
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
