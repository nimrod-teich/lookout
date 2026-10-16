import type { Evidence, Reason, ReasonKind, SessionView, State } from "./types";

/** A working session whose transcript has not changed for this long is quiet. */
export const QUIET_MS = 10 * 60_000;

/** "45s", "12m", "3h 05m", "2d". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

const KIND_LABELS: Record<ReasonKind, string> = {
  permission: "Permission",
  question: "Question",
  plan: "Plan approval",
  dialog: "Dialog",
  typed: "Asked you a question",
};

/** "Permission", "Question", "Plan approval", "Dialog", "Asked you a question". */
export function reasonLabel(kind: ReasonKind): string {
  return KIND_LABELS[kind];
}

/** "Permission · Bash: npm test", "Question · Which one? (Red / Blue)"; the agent's own word alone when that is all there is. */
export function describeReason(reason: Reason | undefined): string {
  if (!reason) return "input";
  if (reason.ask === reason.raw) return `${reason.ask.charAt(0).toUpperCase()}${reason.ask.slice(1)}`;
  const options = reason.options?.length ? ` (${reason.options.join(" / ")})` : "";
  return `${KIND_LABELS[reason.kind]} · ${reason.ask}${options}`;
}

/** How long a working session's transcript has been silent, counted from when it started working at the earliest, when that is longer than `QUIET_MS`. */
export function quietFor(view: SessionView, now: number): number | undefined {
  if (view.state !== "working" || view.lastWriteAt === undefined) return undefined;
  const quiet = now - Math.max(view.lastWriteAt, view.since ?? -Infinity);
  return quiet > QUIET_MS ? quiet : undefined;
}

/** "From the session file, written 4s ago", "From the process, started 12s ago: no state recorded yet". */
export function describeEvidence(evidence: Evidence | undefined, now: number): string | undefined {
  if (!evidence) return undefined;
  const age = evidence.at === undefined ? "" : `, ${evidence.source === "process" ? "started" : "written"} ${formatElapsed(now - evidence.at)} ago`;
  return `From the ${evidence.source}${age}${evidence.note ? `: ${evidence.note}` : ""}`;
}

/** One line saying what a session is doing and for how long, e.g. "Needs you for 12m: Permission · Bash: npm test". */
export function describeState(view: SessionView, now: number): string {
  const elapsed = view.since === undefined ? undefined : formatElapsed(now - view.since);
  switch (view.state) {
    case "waiting":
      return `${elapsed ? `Needs you for ${elapsed}` : "Needs you"}: ${describeReason(view.reason)}`;
    case "done":
      return elapsed ? `Finished ${elapsed} ago` : "Finished";
    case "working": {
      const quiet = quietFor(view, now);
      if (quiet !== undefined) return `Working, quiet ${formatElapsed(quiet)}`;
      return elapsed ? `Working for ${elapsed}` : "Working";
    }
    case "idle":
      return elapsed ? `Idle for ${elapsed}` : "Idle";
    case "unknown":
      return "State unknown";
  }
}

/** What a desktop notification says about a session that needs the user, or finished. */
export function noticeBody(view: SessionView, finished: boolean): string {
  if (finished) return "Finished its turn";
  if (view.reason?.kind === "typed") return `Asked you a question: ${view.reason.ask}`;
  return `Needs you: ${describeReason(view.reason)}`;
}

/** "app" or, in a worktree, "app · fix-x". */
export function describeLocation(view: SessionView): string {
  return view.worktree ? `${view.project} · ${view.worktree}` : view.project;
}

export type Counts = Record<State, number>;

export function countStates(views: readonly SessionView[]): Counts {
  const counts: Counts = { waiting: 0, done: 0, working: 0, unknown: 0, idle: 0 };
  for (const view of views) counts[view.state]++;
  return counts;
}

/** "850", "190k", "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "claude-fable-5-1[1m]" → "Fable 5.1"; unknown ids are returned as they are. */
export function shortModel(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (!match) return id;
  const family = match[1]!;
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${match[2]}.${match[3]}`;
}

/** "$0.42", "$118", "$1.2k". */
export function formatUsd(usd: number): string {
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${Math.round(usd)}`;
  return `$${(usd / 1000).toFixed(1)}k`;
}
