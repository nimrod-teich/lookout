import * as vscode from "vscode";
import type { AgentProvider, SearchOutcome } from "../core/agents/agent";
import { ArchivedSessions, stateDbCandidates } from "../core/agents/claude/archived";
import { ClaudeProvider } from "../core/agents/claude/provider";
import type { HistoryMessage } from "../core/history";
import { Attention } from "../core/attention";
import { buildPastView, sortViews } from "../core/model";
import { Monitor } from "../core/monitor";
import { createProcessTable, type ProcessTable } from "../core/proc";
import type { PastView, SessionView } from "../core/types";
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
const DISMISSED_KEY = "lookout.dismissed";
/** Matches shown per session. */
const SEARCH_HITS = 3;
/** A search reads conversations not read yet for at most this long; the rest are reported pending. */
const SEARCH_BUDGET_MS = 150;
/**
 * The agent can write to the transcript a moment after it records a state:
 * a prompt's tool call, a turn's last reply. An announcement looks again
 * this often, this many times, so it can say what the session asks.
 */
const ANNOUNCE_RETRY_MS = 250;
const ANNOUNCE_TRIES = 8;

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
  /** The folders open in this window: their past sessions are listed. */
  workspaceFolders(): string[];
  /** VS Code's extension storage directory, next to which it keeps extension state. */
  globalStorageDir: string;
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
  private pastViews: PastView[] = [];
  private archived = new ArchivedSessions([]);
  private savedDone = "";
  private savedDismissed = "";
  private typedQuestions = true;
  private usageCache: UsageCache | undefined;
  private usageMode: RefreshMode = "manual";
  private currentUsage: UsageSnapshot | undefined;
  private refreshing: Promise<boolean> | undefined;
  private lastRefreshAttempt = -Infinity;
  private readonly announcing = new Set<ReturnType<typeof setTimeout>>();

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
    const dismissed = host.state.get<Record<string, string>>(DISMISSED_KEY, {});
    this.attention.restoreDismissals(dismissed);
    this.savedDismissed = JSON.stringify(this.attention.dismissals());
  }

  get sessions(): readonly SessionView[] {
    return this.current;
  }

  /** The sessions that are not running, newest first. */
  get past(): readonly PastView[] {
    return this.pastViews;
  }

  /** The title of a live or a past session. */
  titleOf(id: string): string | undefined {
    return this.current.find((view) => view.id === id)?.title ?? this.pastViews.find((view) => view.id === id)?.title;
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
    this.typedQuestions = config.typedQuestions;
    this.providers = [new ClaudeProvider(config.claudeConfigDir, this.proc)];
    this.monitor = new Monitor(this.providers, this.proc);
    this.usageCache = new UsageCache(usageCacheFile(config.claudeConfigDir));
    this.usageMode = config.usageRefresh;
    this.archived = new ArchivedSessions(stateDbCandidates(this.host.globalStorageDir));
    if (!this.archived.available) this.log.info("The agent's archived-session list is out of reach; every past session is listed");
    this.log.info(`Watching ${this.providers.map((p) => p.label).join(", ")} (${config.claudeConfigDir})`);
    this.watch();
    this.poll();
  }

  /** Takes settings that need no restart, and shows their effect at once. */
  configure(config: Config): void {
    this.typedQuestions = config.typedQuestions;
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
    const update = this.attention.update(views, (view) => isWatched(view, this.terminals), { typedQuestions: this.typedQuestions });
    const exclude = new Set<string>([...update.views.map((view) => view.id), ...this.archived.read()]);
    const folders = this.host.workspaceFolders();
    const past = this.providers.flatMap((provider) => provider.past?.(folders, exclude) ?? []).map(buildPastView);
    past.sort((a, b) => b.modifiedAt - a.modifiedAt);
    this.publish(sortViews(update.views), past);
    this.saveDone();
    for (const view of update.finished) this.announceFinished(view);
    for (const view of update.waiting) this.announce(view);
    this.pollUsage();
  }

  /**
   * Announces a wait at once, or, while its reason is only the agent's word
   * and could still say more, once it does or after two seconds; not when the
   * user has turned to the session meanwhile.
   */
  private announce(view: SessionView, attempt = 0): void {
    if (!view.reason?.tentative || attempt >= ANNOUNCE_TRIES) {
      if (attempt === 0 || !isWatched(view, this.terminals)) this.waiting.fire(view);
      return;
    }
    this.later(() => {
      const now = this.current.find((v) => v.id === view.id);
      if (now?.state === "waiting") this.announce(now, attempt + 1);
    });
  }

  /** Announces a finished turn, unless its last reply turns out to ask something: that is announced as a wait. */
  private announceFinished(view: SessionView, attempt = 0): void {
    if (attempt >= ANNOUNCE_TRIES) {
      if (!isWatched(view, this.terminals)) this.finished.fire(view);
      return;
    }
    this.later(() => {
      const now = this.current.find((v) => v.id === view.id);
      if (now?.state === "done") this.announceFinished(now, attempt + 1);
    });
  }

  /** Polls again after a moment, then runs `next`. */
  private later(next: () => void): void {
    const timer = setTimeout(() => {
      this.announcing.delete(timer);
      this.poll();
      next();
    }, ANNOUNCE_RETRY_MS);
    this.announcing.add(timer);
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

  /** Searches the conversations of the live and the past sessions: the newest few matches per session, for the cards. */
  search(query: string): SearchOutcome {
    const started = Date.now();
    const outcome: SearchOutcome = { results: [], pending: 0 };
    for (const provider of this.providers) {
      const left = Math.max(0, SEARCH_BUDGET_MS - (Date.now() - started));
      const part = provider.search?.(query, SEARCH_HITS, left);
      if (!part) continue;
      outcome.results.push(...part.results);
      outcome.pending += part.pending;
    }
    return outcome;
  }

  /** The conversation of one live session, oldest first. */
  history(id: string): HistoryMessage[] | undefined {
    for (const provider of this.providers) {
      const messages = provider.history?.(id);
      if (messages) return messages;
    }
    return undefined;
  }

  /** The user looked at this session. */
  markSeen(id: string): void {
    if (this.attention.markSeen(id)) this.poll();
  }

  markAllSeen(): void {
    if (this.attention.markAllSeen()) this.poll();
  }

  /** The user dismissed the question a session's last message asks. */
  dismiss(id: string): void {
    if (this.attention.dismiss(id)) this.poll();
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

  private publish(views: SessionView[], past: PastView[]): void {
    const snapshot = JSON.stringify([views, past]);
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.current = views;
    this.pastViews = past;
    this.changed.fire(views);
  }

  private saveDone(): void {
    const done = this.attention.snapshot();
    const key = done.join("\n");
    if (key !== this.savedDone) {
      this.savedDone = key;
      void this.host.state.update(DONE_KEY, done);
    }
    const dismissed = this.attention.dismissals();
    const dismissedKey = JSON.stringify(dismissed);
    if (dismissedKey !== this.savedDismissed) {
      this.savedDismissed = dismissedKey;
      void this.host.state.update(DISMISSED_KEY, dismissed);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    for (const timer of this.announcing) clearTimeout(timer);
    this.announcing.clear();
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
