// Tying live `codex` processes to the rollouts they write.
//
// A Codex process keeps no file naming its thread, and does not hold its
// rollout open, so the tie is inferred:
//
// 1. `codex resume <id>` names its thread.
// 2. A thread belongs to the process of its directory (the rollout's
//    `session_meta.cwd`) that started last before the thread was created: the
//    one that created it. A process takes the one of its threads written last,
//    so a thread started with `/new` counts; of two written in the same
//    second, the one whose file moved since the last look, then the newer.
// 3. A process with no thread of its own takes a thread of its directory
//    created before it started but written since (one it resumed from the
//    picker), the one written last, so long as no other process owns it.
// 4. Where the platform does not tell a process's directory (Windows), the
//    directory is not compared.
//
// Threads the terminal program wrote (`originator` `codex-tui`) are the ones
// owned; an editor extension's threads in the same folder are not. A process
// with nothing sent yet has no thread and stays unmatched. Two sessions in
// one folder can still trade places when the older one starts a new thread
// after the newer one started.

export interface LiveProcess {
  pid: number;
  cwd?: string;
  startedMs?: number;
  resumeId?: string;
}

export interface RolloutInfo {
  file: string;
  id: string;
  cwd?: string;
  /** Epoch ms the thread was created (`session_meta.timestamp`). */
  createdAt?: number;
  mtimeMs: number;
  /** Who wrote it (`session_meta.originator`), e.g. `codex-tui`. */
  originator?: string;
}

/** Clocks of a file's mtime and of a process start differ by this much at most. */
const SLACK_MS = 2_000;

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return norm(a) === norm(b);
}

/** A rollout the terminal program wrote, as opposed to an editor extension or a script. */
function fromTerminal(rollout: RolloutInfo): boolean {
  return rollout.originator === undefined || /tui|cli/i.test(rollout.originator);
}

function sameDir(process: LiveProcess, rollout: RolloutInfo): boolean {
  return process.cwd === undefined || rollout.cwd === undefined || samePath(rollout.cwd, process.cwd);
}

/** Written last first; of two in the same second, the one that moved since the last look, then the newer thread. */
function newestWritten(rollouts: RolloutInfo[], moved: (file: string) => boolean): RolloutInfo | undefined {
  return [...rollouts].sort(
    (a, b) => Math.floor(b.mtimeMs / 1000) - Math.floor(a.mtimeMs / 1000) || Number(moved(b.file)) - Number(moved(a.file)) || (b.createdAt ?? 0) - (a.createdAt ?? 0),
  )[0];
}

export function matchRollouts(processes: readonly LiveProcess[], rollouts: readonly RolloutInfo[], moved: (file: string) => boolean = () => false): Map<number, RolloutInfo> {
  const matched = new Map<number, RolloutInfo>();
  const taken = new Set<string>();
  for (const process of processes) {
    if (!process.resumeId) continue;
    const rollout = rollouts.find((r) => r.id === process.resumeId && !taken.has(r.file));
    if (!rollout) continue;
    matched.set(process.pid, rollout);
    taken.add(rollout.file);
  }
  const open = processes.filter((p) => !matched.has(p.pid));
  // Each thread the terminal program created goes to the process of its folder that started last before it.
  const owned = new Map<number, RolloutInfo[]>();
  const owner = new Map<string, number>();
  for (const rollout of rollouts) {
    if (taken.has(rollout.file) || !fromTerminal(rollout) || rollout.createdAt === undefined) continue;
    const creators = open.filter((p) => sameDir(p, rollout) && (p.startedMs ?? -Infinity) <= rollout.createdAt! + SLACK_MS);
    const creator = creators.sort((a, b) => (b.startedMs ?? -Infinity) - (a.startedMs ?? -Infinity))[0];
    if (!creator) continue;
    owned.set(creator.pid, [...(owned.get(creator.pid) ?? []), rollout]);
    owner.set(rollout.file, creator.pid);
  }
  for (const process of open) {
    const best = newestWritten(owned.get(process.pid) ?? [], moved);
    if (!best) continue;
    matched.set(process.pid, best);
    taken.add(best.file);
  }
  // Left without a thread of their own: one resumed from the picker, older than the process, written since it started.
  const rest = open.filter((p) => !matched.has(p.pid)).sort((a, b) => (b.startedMs ?? -Infinity) - (a.startedMs ?? -Infinity));
  for (const process of rest) {
    const start = process.startedMs ?? -Infinity;
    const candidates = rollouts.filter((r) => !taken.has(r.file) && !owner.has(r.file) && sameDir(process, r) && r.mtimeMs >= start - SLACK_MS);
    const terminal = candidates.filter(fromTerminal);
    const best = newestWritten(terminal.length ? terminal : candidates, moved);
    if (!best) continue;
    matched.set(process.pid, best);
    taken.add(best.file);
  }
  return matched;
}
