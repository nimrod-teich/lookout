import * as vscode from "vscode";
import type { AgentProvider } from "../core/agents/agent";
import { ClaudeProvider } from "../core/agents/claude/provider";
import { Attention } from "../core/attention";
import { sortViews } from "../core/model";
import { Monitor } from "../core/monitor";
import { createProcessTable, type ProcessTable } from "../core/proc";
import type { SessionView } from "../core/types";
import type { Config } from "./config";
import type { Log } from "./log";
import type { Terminals } from "./terminals";
import { isWatched } from "./watch";

const POLL_MS = 1000;

/** Polls the sessions on this host and announces when what the UI shows changes. */
export class Controller implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<readonly SessionView[]>();
  private readonly finished = new vscode.EventEmitter<SessionView>();
  private readonly waiting = new vscode.EventEmitter<SessionView>();
  readonly onDidChange = this.changed.event;
  /** A session of this window finished a turn while the user was not looking. */
  readonly onDidFinish = this.finished.event;
  /** A session of this window started to wait for the user while they were not looking. */
  readonly onDidStartWaiting = this.waiting.event;

  private readonly proc: ProcessTable = createProcessTable();
  private readonly attention = new Attention();
  private monitor: Monitor | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private current: readonly SessionView[] = [];
  private snapshot = "[]";

  constructor(
    private readonly terminals: Terminals,
    private readonly log: Log,
  ) {
    this.proc.onDidUpdate = () => this.poll();
  }

  get sessions(): readonly SessionView[] {
    return this.current;
  }

  /** Starts, or restarts with other settings. */
  start(config: Config): void {
    const providers: AgentProvider[] = [new ClaudeProvider(config.claudeConfigDir, this.proc)];
    this.monitor = new Monitor(providers, this.proc);
    this.log.info(`Watching ${providers.map((p) => p.label).join(", ")} (${config.claudeConfigDir})`);
    this.poll();
    this.timer ??= setInterval(() => this.poll(), POLL_MS);
  }

  /** Reads the sessions now, without waiting for the next tick. */
  poll(): void {
    if (!this.monitor) return;
    let views: SessionView[];
    try {
      views = this.monitor.poll({ hostPid: process.pid, terminalPids: this.terminals.pids });
    } catch (err) {
      this.log.errorOnce(`Poll failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return;
    }
    const update = this.attention.update(views, (view) => isWatched(view, this.terminals));
    this.publish(sortViews(update.views));
    for (const view of update.finished) this.finished.fire(view);
    for (const view of update.waiting) this.waiting.fire(view);
  }

  /** The user looked at this session. */
  markSeen(id: string): void {
    if (this.attention.markSeen(id)) this.poll();
  }

  markAllSeen(): void {
    if (this.attention.markAllSeen()) this.poll();
  }

  /** Clears "done" from the session whose tab or terminal the user just brought to the front. */
  noticeFocus(): void {
    for (const view of this.current) {
      if (view.state === "done" && isWatched(view, this.terminals)) this.attention.markSeen(view.id);
    }
    this.poll();
  }

  private publish(views: SessionView[]): void {
    const snapshot = JSON.stringify(views);
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.current = views;
    this.changed.fire(views);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.proc.onDidUpdate = undefined;
    this.changed.dispose();
    this.finished.dispose();
    this.waiting.dispose();
  }
}
