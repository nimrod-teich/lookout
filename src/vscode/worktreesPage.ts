import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { formatBytes } from "../core/format";
import { RESTORE_DAYS, type RemovedWorktrees } from "../core/removedWorktrees";
import type { Removal, RemoveAsk, RemovedRecord, Survey, SurveyInput, SurveyProgress, WorktreeCheck } from "../core/worktrees";
import type { FromWorktrees, RemovalSummary, RemovedRow, ToWorktrees, WorktreeRow, WorktreesState } from "../webview/worktreesProtocol";

export const WORKTREES_VIEW_TYPE = "lookout.worktrees";

/** What checks, removes and restores worktrees: the worktree thread, or the same work in the tests. */
export interface WorktreeRunner {
  survey(input: SurveyInput, onProgress?: (progress: SurveyProgress) => void): Promise<Survey>;
  remove(asks: RemoveAsk[], input: Omit<SurveyInput, "folders" | "repos">, onProgress?: (progress: SurveyProgress) => void): Promise<{ removals: Removal[]; freeSpaceGrew?: number }>;
  restore(record: RemovedRecord): Promise<{ ok: boolean; error?: string }>;
  /** Stops the check under way: what it was asked rejects, and the next ask starts afresh. */
  stop(): void;
}

export interface WorktreesPageActions {
  /** Where to look for repositories, the ones sessions ran in, what uses a worktree now, and what can be built again. */
  input(): SurveyInput;
  /** Asks before a removal, in a modal dialog; true when the user goes ahead. */
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  /** Shows a folder in the system's file manager. */
  reveal(folder: string): void;
  /** Opens the worktree settings. */
  openSettings(): void;
}

/** Progress is sent to the page at most this often. */
const PROGRESS_MS = 150;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The folder that holds the worktree, when it is not the usual `<repo>/.claude/worktrees`, with the home folder as `~`. */
export function whereOf(check: Pick<WorktreeCheck, "repo" | "path">, home: string = os.homedir()): string | undefined {
  const dir = path.dirname(check.path);
  if (dir === path.join(check.repo, ".claude", "worktrees")) return undefined;
  if (dir === home) return "~";
  return dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

function rowOf(check: WorktreeCheck): WorktreeRow {
  const where = whereOf(check);
  return {
    path: check.path,
    repo: check.repo,
    name: path.basename(check.path),
    branch: check.branch,
    tier: check.tier,
    reason: check.reason,
    ownBytes: check.ownBytes,
    sharedBytes: check.sharedBytes,
    ...(check.headAt !== undefined ? { headAt: check.headAt } : {}),
    ...(check.ignored ? { ignored: check.ignored } : {}),
    ...(check.landed ? { landed: true } : {}),
    ...(where !== undefined ? { where } : {}),
  };
}

/** The row as the second look found it: its tier and reason now, its branch's fate and its ignored files with them. */
function asNow(row: WorktreeRow, now: NonNullable<Removal["now"]>): WorktreeRow {
  const next: WorktreeRow = { ...row, tier: now.tier, reason: now.reason };
  delete next.landed;
  delete next.ignored;
  if (now.landed) next.landed = true;
  if (now.ignored) next.ignored = now.ignored;
  return next;
}

function removedRowOf(record: RemovedRecord): RemovedRow {
  return { path: record.path, repo: record.repo, name: path.basename(record.path), branch: record.branch, branchDeleted: record.branchDeleted, removedAt: record.removedAt };
}

/**
 * The worktrees page: every linked worktree of the repositories found, in
 * the tiers the check puts them in, with what each takes on disk; the safe
 * ones ticked, a removal asked for in a modal, then done in the worktree
 * thread, each worktree looked at again first. What was removed can be put
 * back from the page for two weeks. One tab, reused.
 */
export class WorktreesPage implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private state: WorktreesState = { repos: [], rows: [], removed: [] };
  private lastProgress = 0;
  /** The check under way was stopped from the page: its rejection is no error. */
  private stopped = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly runner: WorktreeRunner,
    private readonly removed: RemovedWorktrees,
    private readonly actions: WorktreesPageActions,
  ) {}

  /** Opens the page, or brings it forward; the first opening checks the worktrees. */
  show(): void {
    const panel = this.ensurePanel();
    panel.reveal(undefined, false);
    this.post();
    if (this.state.checkedAt === undefined && !this.state.busy) void this.check();
  }

  /** The page's state, for the tests. */
  get current(): WorktreesState {
    return this.state;
  }

  /** Checks every worktree again. The last removal's summary goes with the rows it was about. */
  async check(): Promise<void> {
    if (this.state.busy) return;
    this.stopped = false;
    this.set({ busy: "check", progress: undefined, summary: undefined, error: undefined, notice: undefined });
    try {
      const survey = await this.runner.survey(this.actions.input(), (progress) => this.progress(progress));
      const rows = survey.worktrees.map(rowOf).sort((a, b) => b.ownBytes - a.ownBytes || a.path.localeCompare(b.path));
      const repos = survey.repos.map((info) => ({ repo: info.repo, name: path.basename(info.repo), defaultRef: info.defaultRef, fetchedAt: info.fetchedAt }));
      this.set({ busy: undefined, progress: undefined, checkedAt: survey.at, rows, repos });
    } catch (error) {
      if (this.stopped) this.set({ busy: undefined, progress: undefined, notice: this.state.checkedAt === undefined ? "The check was stopped." : "The check was stopped; the rows are from the one before." });
      else this.set({ busy: undefined, progress: undefined, error: `The check stopped: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /** Stops the check under way; a removal or a restore runs to its end. */
  stop(): void {
    if (this.state.busy !== "check") return;
    this.stopped = true;
    this.runner.stop();
  }

  /** Takes the last removal's summary off the page. */
  dismiss(): void {
    if (this.state.summary) this.set({ summary: undefined });
  }

  async remove(paths: readonly string[]): Promise<void> {
    if (this.state.busy) return;
    const wanted = new Set(paths);
    const rows = this.state.rows.filter((row) => wanted.has(row.path) && row.tier !== "keep");
    if (!rows.length) return;
    const records = rows.filter((row) => row.tier === "gone");
    const trees = rows.filter((row) => row.tier !== "gone");
    const review = trees.filter((row) => row.tier === "review");
    const branches = trees.filter((row) => row.landed && row.branch);
    const frees = trees.reduce((sum, row) => sum + row.ownBytes, 0);
    const what = [trees.length ? plural(trees.length, "worktree") : "", records.length ? plural(records.length, "record") : ""].filter(Boolean).join(" and ");
    const detail = [
      trees.length ? `Frees about ${formatBytes(frees)}.` : "",
      records.length ? `${plural(records.length, "record")} of a worktree whose folder is gone ${records.length === 1 ? "is" : "are"} cleared.` : "",
      review.length ? `${plural(review.length, "is", "are")} for review: what ${review.length === 1 ? "it holds" : "they hold"} that no tool builds again goes too.` : "",
      branches.length ? `${plural(branches.length, "branch", "branches")} whose change is on the default branch ${branches.length === 1 ? "goes" : "go"} too.` : "",
      trees.length ? `Each worktree can be put back from this page for ${RESTORE_DAYS} days, without its ignored files.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (!(await this.actions.confirm(`Remove ${what}?`, detail, "Remove"))) return;
    this.set({ busy: "remove", progress: { done: 0, total: rows.length }, error: undefined, notice: undefined });
    const input = this.actions.input();
    const asks: RemoveAsk[] = rows.map((row) => ({ repo: row.repo, path: row.path, shownAs: row.tier, bytes: row.ownBytes }));
    try {
      const done = await this.runner.remove(asks, { inUse: input.inUse, rebuildable: input.rebuildable, quietMs: input.quietMs }, (progress) => this.progress(progress));
      const now = Date.now();
      const ok = done.removals.filter((removal) => removal.ok);
      this.removed.add(ok.filter((removal) => !removal.record).map((removal) => ({ repo: removal.repo, path: removal.path, branch: removal.branch, head: removal.head, branchDeleted: removal.branchDeleted, removedAt: now })));
      const gone = new Set(ok.map((removal) => removal.path));
      // A worktree the second look refused shows as it stands now, not as the check had it.
      const stands = new Map(done.removals.flatMap((removal) => (!removal.ok && removal.now ? [[removal.path, removal.now] as const] : [])));
      const summary: RemovalSummary = {
        removed: ok.filter((removal) => !removal.record).length,
        records: ok.filter((removal) => removal.record).length,
        freedBytes: ok.reduce((sum, removal) => sum + removal.freedBytes, 0),
        branchesDeleted: ok.filter((removal) => removal.branchDeleted).length,
        ...(done.freeSpaceGrew !== undefined ? { freeSpaceGrew: done.freeSpaceGrew } : {}),
        failed: done.removals.filter((removal) => !removal.ok).map((removal) => ({ path: removal.path, name: path.basename(removal.path), error: removal.error ?? "not removed" })),
        at: now,
      };
      const rows = this.state.rows.flatMap((row) => {
        if (gone.has(row.path)) return [];
        const now = stands.get(row.path);
        return [now ? asNow(row, now) : row];
      });
      this.set({ busy: undefined, progress: undefined, summary, rows });
    } catch (error) {
      this.set({ busy: undefined, progress: undefined, error: `The removal stopped: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async restore(folder: string): Promise<void> {
    if (this.state.busy) return;
    const record = this.removed.list().find((candidate) => candidate.path === folder);
    if (!record) return;
    this.set({ busy: "restore", error: undefined, notice: undefined });
    try {
      const restored = await this.runner.restore(record);
      if (restored.ok) {
        this.removed.drop(folder);
        const on = record.branch ? ` on ${record.branch}` : "";
        this.set({ busy: undefined, notice: `${path.basename(folder)} is back${on}, without its ignored files: install its dependencies again before you build in it.` });
      } else {
        this.set({ busy: undefined, error: `${path.basename(folder)} was not put back: ${restored.error ?? "git refused"}.` });
      }
    } catch (error) {
      this.set({ busy: undefined, error: `The restore stopped: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private progress(progress: SurveyProgress): void {
    const now = Date.now();
    if (now - this.lastProgress < PROGRESS_MS && progress.done < progress.total) return;
    this.lastProgress = now;
    this.set({ progress });
  }

  private set(change: Partial<WorktreesState>): void {
    this.state = { ...this.state, ...change };
    this.post();
  }

  private post(): void {
    if (!this.panel) return;
    const message: ToWorktrees = { type: "state", state: { ...this.state, removed: this.removed.list().map(removedRowOf) } };
    void this.panel.webview.postMessage(message);
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) return this.panel;
    const panel = vscode.window.createWebviewPanel(WORKTREES_VIEW_TYPE, "Lookout: Worktrees", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw));
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    this.panel = panel;
    return panel;
  }

  private receive(raw: unknown): void {
    const message = raw as Partial<FromWorktrees>;
    switch (message?.type) {
      case "ready":
        this.post();
        return;
      case "check":
        void this.check();
        return;
      case "stop":
        this.stop();
        return;
      case "dismiss":
        this.dismiss();
        return;
      case "remove":
        if (Array.isArray(message.paths)) void this.remove(message.paths.filter((p): p is string => typeof p === "string"));
        return;
      case "restore":
        if (typeof message.path === "string") void this.restore(message.path);
        return;
      case "reveal":
        if (typeof message.path === "string" && this.state.rows.some((row) => row.path === message.path)) this.actions.reveal(message.path);
        return;
      case "settings":
        this.actions.openSettings();
        return;
      default:
        return;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "worktrees.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "worktrees.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Lookout: Worktrees</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}
