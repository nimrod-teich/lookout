// The thread worktrees are checked, removed and restored in (`dist/worktreeThread.js`),
// so git and the walks that size a worktree's folders never hold up VS Code's
// extension host.
import { parentPort } from "node:worker_threads";
import type { WorktreeAsk, WorktreeAnswer } from "./core/worktreeWorker";
import { freeSpace, processFolders, removeWorktrees, restoreWorktree, survey, type InUse, type SurveyProgress } from "./core/worktrees";

/** What the extension knows, with the folders this machine's processes run in. */
async function withProcesses(inUse: readonly InUse[]): Promise<InUse[]> {
  return [...inUse, ...(await processFolders()).map((dir) => ({ dir, why: "a process runs in it" }))];
}

async function answer(ask: WorktreeAsk): Promise<WorktreeAnswer> {
  const progress = (p: SurveyProgress) => parentPort!.postMessage({ id: ask.id, progress: p } satisfies WorktreeAnswer);
  switch (ask.op) {
    case "survey": {
      const inUse = await withProcesses(ask.input.inUse);
      return { id: ask.id, survey: await survey({ ...ask.input, inUse }, progress) };
    }
    case "remove": {
      const inUse = await withProcesses(ask.input.inUse);
      const dirs = [...new Set(ask.asks.map((one) => one.repo))];
      const before = freeSpace(dirs);
      const removals = await removeWorktrees(ask.asks, { ...ask.input, inUse }, progress);
      const after = freeSpace(dirs);
      let grew = 0;
      for (const [dev, free] of after) grew += free - (before.get(dev) ?? free);
      return { id: ask.id, removals, freeSpaceGrew: before.size ? grew : undefined };
    }
    case "restore":
      return { id: ask.id, restored: await restoreWorktree(ask.record, ask.git) };
  }
}

parentPort?.on("message", (ask: WorktreeAsk) => {
  answer(ask).then(
    (done) => parentPort!.postMessage(done),
    (error: unknown) => parentPort!.postMessage({ id: ask.id, error: String(error) } satisfies WorktreeAnswer),
  );
});
