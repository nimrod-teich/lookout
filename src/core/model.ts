import type { AgentSession } from "./agents/agent";
import type { Host, SessionView, State } from "./types";

const WORKTREE = /^(.*)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/;
const STATE_ORDER: Record<State, number> = { waiting: 0, done: 1, working: 2, unknown: 3, idle: 4 };

export const UNTITLED = "Untitled session";

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
}

function locate(session: AgentSession, ancestors: readonly number[], ctx: WindowContext): { host: Host; terminalPid?: number } {
  if (session.panel && ancestors.includes(ctx.hostPid)) return { host: "panel" };
  const terminalPid = ancestors.find((pid) => ctx.terminalPids.has(pid));
  return terminalPid === undefined ? { host: "elsewhere" } : { host: "terminal", terminalPid };
}

export function buildView(session: AgentSession, ancestors: readonly number[], ctx: WindowContext): SessionView {
  return {
    id: session.id,
    agent: session.agent,
    pid: session.pid,
    title: session.title ?? UNTITLED,
    state: session.status,
    since: session.since,
    needs: session.status === "waiting" ? session.needs : undefined,
    ...projectOf(session.cwd),
    cwd: session.cwd,
    ...locate(session, ancestors, ctx),
  };
}

/** What wants the user's attention first, each group ordered by how long it has been in its state. */
export function sortViews(views: readonly SessionView[]): SessionView[] {
  return [...views].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.since ?? 0) - (b.since ?? 0) || a.id.localeCompare(b.id),
  );
}
