import * as vscode from "vscode";
import type { AgentProvider } from "../core/agents/agent";
import { ClaudeProvider } from "../core/agents/claude/provider";
import { Attention } from "../core/attention";
import { sortViews } from "../core/model";
import { Monitor } from "../core/monitor";
import { createProcessTable, type ProcessTable } from "../core/proc";
import type { SessionView } from "../core/types";
import { isStale, shouldAutoRefresh, UsageCache, usageCacheFile, type RefreshMode, type UsageSnapshot } from "../core/usage";
import { refreshUsage } from "../core/usageRefresh";
import { WindowRegistry } from "../core/windows";
import type { Config } from "./config";
import type { Log } from "./log";
import type { Terminals } from "./terminals";
import { isWatched } from "./watch";

/** Polling interval while the agents' records are watched; the watch triggers polls in between. */
const BACKSTOP_MS = 5000;
/** Polling interval when they can't be watched. */
const POLL_MS = 1000;
/** A burst of file changes becomes one poll. */
const DEBOUNCE_MS = 50;
const DONE_KEY = "lookout.done";

export interface ControllerHost {
  /** Pid of the extension host, which an agent panel's sessions descend from. */
  pid: number;
  /** Name of this window, for the other windows' lists. */
  label: string;
  /** Directory all windows on this host share. */
  sharedDir: string;
  /** Per-workspace storage, to carry finished marks across a reload. */
  state: vscode.Memento;
  /** The Claude Code binary that can fetch the account's usage, when installed. */
  claudeBinary(): string | undefined;
}

/** The usage numbers as the UI gets them. */
export interface Usage extends UsageSnapshot {
  stale: boolean;
}

/** Polls the sessions on this host and announces when what the UI shows changes. */
export class Controller implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<readonly SessionView[]>();
  private readonly usageChanged = new vscode.EventEmitter<Usage | undefined>();
  private readonly finished = new vscode.EventEmitter<SessionView>();
  private readonly waiting = new vscode.EventEmitter<SessionView>();
  readonly onDidChange = this.changed.event;
  /** The usage numbers were fetched or read anew. */
  readonly onDidChangeUsage = this.usageChanged.event;
  /** A session of this window finished a turn while the user was not looking. */
  readonly onDidFinish = this.finished.event;
  /** A session of this window started to wait for the user while they were not looking. */
  readonly onDidStartWaiting = this.waiting.event;

  private readonly proc: ProcessTable = createProcessTable();
  private readonly attention = new Attention();
  private readonly windows: WindowRegistry;
  private providers: AgentProvider[] = [];
  private monitor: Monitor | undefined;
  private watchers: { dispose(): void }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private current: readonly SessionView[] = [];
  private snapshot = "[]";
  private savedDone = "";
  private usageCache: UsageCache | undefined;
  private usageMode: RefreshMode = "manual";
  private currentUsage: UsageSnapshot | undefined;
  private refreshing: Promise<boolean> | undefined;
  private lastRefreshAttempt = -Infinity;

  constructor(
    private readonly host: ControllerHost,
    private readonly terminals: Terminals,
    private readonly log: Log,
  ) {
    this.proc.onDidUpdate = () => this.poll();
    this.windows = new WindowRegistry(host.sharedDir, this.proc);
    this.windows.register(host.pid, host.label);
    const done = host.state.get<string[]>(DONE_KEY, []);
    this.attention.restore(done);
    this.savedDone = done.join("\n");
  }

  get sessions(): readonly SessionView[] {
    return this.current;
  }

  get usage(): Usage | undefined {
    return this.currentUsage && { ...this.currentUsage, stale: isStale(this.currentUsage, Date.now()) };
  }

  /** Lookout can ask the agent for fresh usage numbers. */
  get canRefreshUsage(): boolean {
    return this.usageMode !== "off" && this.host.claudeBinary() !== undefined;
  }

  /** Starts, or restarts with other settings. */
  start(config: Config): void {
    this.providers = [new ClaudeProvider(config.claudeConfigDir, this.proc)];
    this.monitor = new Monitor(this.providers, this.proc);
    this.usageCache = new UsageCache(usageCacheFile(config.claudeConfigDir));
    this.usageMode = config.usageRefresh;
    this.log.info(`Watching ${this.providers.map((p) => p.label).join(", ")} (${config.claudeConfigDir})`);
    this.watch();
    this.poll();
  }

  /** Reads the sessions now, without waiting for the next tick. */
  poll(): void {
    if (!this.monitor) return;
    let views: SessionView[];
    try {
      views = this.monitor.poll({
        hostPid: this.host.pid,
        terminalPids: this.terminals.pids,
        windows: this.windows.read(this.host.pid),
      });
    } catch (err) {
      this.log.errorOnce(`Poll failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return;
    }
    const update = this.attention.update(views, (view) => isWatched(view, this.terminals));
    this.publish(sortViews(update.views));
    this.saveDone();
    for (const view of update.finished) this.finished.fire(view);
    for (const view of update.waiting) this.waiting.fire(view);
    this.pollUsage();
  }

  private pollUsage(): void {
    const read = this.usageCache?.read();
    if (read && read.fetchedAt !== this.currentUsage?.fetchedAt) {
      this.currentUsage = read;
      this.usageChanged.fire(this.usage);
    }
    if (this.canRefreshUsage && shouldAutoRefresh(this.usageMode, this.currentUsage, this.lastRefreshAttempt, Date.now())) void this.refreshUsage();
  }

  /**
   * Has the agent fetch fresh usage numbers. Resolves true when they arrived.
   * One fetch runs at a time; a call during a fetch waits for that one.
   */
  refreshUsage(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const binary = this.host.claudeBinary();
    if (!binary || this.usageMode === "off") return Promise.resolve(false);
    this.lastRefreshAttempt = Date.now();
    this.refreshing = refreshUsage({ binary })
      .then((snapshot) => {
        if (!snapshot) {
          this.log.errorOnce("Usage refresh: the Claude Code binary gave no usage numbers");
          return false;
        }
        this.currentUsage = snapshot;
        this.usageChanged.fire(this.usage);
        return true;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
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

  private watch(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    for (const provider of this.providers) {
      const watcher = provider.watch?.(() => this.schedulePoll());
      if (watcher) this.watchers.push(watcher);
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), this.watchers.length ? BACKSTOP_MS : POLL_MS);
  }

  private schedulePoll(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.poll();
    }, DEBOUNCE_MS);
  }

  private publish(views: SessionView[]): void {
    const snapshot = JSON.stringify(views);
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.current = views;
    this.changed.fire(views);
  }

  private saveDone(): void {
    const done = this.attention.snapshot();
    const key = done.join("\n");
    if (key === this.savedDone) return;
    this.savedDone = key;
    void this.host.state.update(DONE_KEY, done);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = undefined;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    this.proc.onDidUpdate = undefined;
    this.windows.unregister(this.host.pid);
    this.changed.dispose();
    this.usageChanged.dispose();
    this.finished.dispose();
    this.waiting.dispose();
  }
}
