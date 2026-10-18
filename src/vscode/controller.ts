import * as os from "node:os";
import * as path from "node:path";
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
import { clockTime } from "../core/format";
import { addSamples, paceOf, type Pace, type SampleStore } from "../core/pace";
import { RefreshLedger } from "../core/refreshLedger";
import { ClaudeSettingsEnv, envFlag, isStale, NONESSENTIAL_TRAFFIC, UsageCache, usageCacheFile, wantsRefresh, type RefreshMode, type UsageRead, type UsageSnapshot } from "../core/usage";
import { AlertLedger, reachedThresholds, scopeOf, type UsageAlert } from "../core/usageAlerts";
import { refreshEnv, refreshUsage } from "../core/usageRefresh";
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
/** Usage readings, for the pace, per source of numbers; kept across reloads. */
const SAMPLES_KEY = "lookout.usageReadings";
/** A window not in front leaves a usage alert this long to a window that is. */
const ALERT_GRACE_MS = 10_000;
/** An attempt to refresh usage that started longer ago than this has ended, in whichever window made it. */
const REFRESH_IN_FLIGHT_MS = 30_000;
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
  /** Storage shared by every window, for the usage readings. */
  globalState: vscode.Memento;
  /** Directory where the windows on this host record their usage refreshes and which usage alerts went out. */
  usageDir: string;
  /** This window is the one in front. */
  focused(): boolean;
  /** The Claude Code binary that can fetch the account's usage, when installed. */
  claudeBinary(): string | undefined;
  /** The folders open in this window: their past sessions are listed. */
  workspaceFolders(): string[];
  /** VS Code's extension storage directory, next to which it keeps extension state. */
  globalStorageDir: string;
}

/** The usage numbers as the UI gets them. */
export interface Usage extends UsageSnapshot {
  /** Old, and nothing will bring them up to date. */
  stale: boolean;
  /** Pace per meter key, where the readings allow one. */
  pace: Record<string, Pace>;
}

/** How a request for fresh usage numbers went. */
export type RefreshOutcome = "fetched" | "failed" | "too soon" | "unavailable";

/** Polls the sessions on this host and announces when what the UI shows changes. */
export class Controller implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<readonly SessionView[]>();
  private readonly usageChanged = new vscode.EventEmitter<Usage | undefined>();
  private readonly finished = new vscode.EventEmitter<SessionView>();
  private readonly waiting = new vscode.EventEmitter<SessionView>();
  readonly onDidChange = this.changed.event;
  /** The usage numbers were fetched or read anew. */
  readonly onDidChangeUsage = this.usageChanged.event;
  private readonly thresholdReached = new vscode.EventEmitter<UsageAlert>();
  /** A usage meter reached a threshold for the first time in its window, and this window is the one to say so. */
  readonly onDidReachUsageThreshold = this.thresholdReached.event;
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
  private usageRead: UsageRead = { snapshot: undefined, why: "missing" };
  private usageAlerts = true;
  /** Refresh is switched off for Claude Code in VS Code's environment or the Claude Code extension's settings. */
  private refreshDisabledByEnv = false;
  /** Claude Code's own settings file, which can switch it off too. */
  private settingsEnv: ClaudeSettingsEnv | undefined;
  /** The environment the Claude Code binary gets: the config directory the numbers are read from. */
  private refreshEnvironment: NodeJS.ProcessEnv = process.env;
  private readonly ledger: RefreshLedger;
  /** The key of the numbers this window's last refresh failed to replace. */
  private failedKey: string | undefined;
  /** The numbers the UI last got were stale. */
  private shownStale = false;
  private refreshing: Promise<RefreshOutcome> | undefined;
  /** Usage readings per source of numbers. */
  private readonly sampleStores: Record<string, SampleStore>;
  /** The readings of the source shown. */
  private samples: SampleStore = {};
  /** The source of the numbers shown, named for the readings, the refreshes and the alerts. */
  private scope = "";
  private readonly alerts: AlertLedger;
  /** Usage alerts this window waits to claim while it is not in front. */
  private readonly pendingAlerts = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly announcing = new Set<ReturnType<typeof setTimeout>>();
  private readonly terminalsChanged: vscode.Disposable;

  constructor(
    private readonly host: ControllerHost,
    private readonly terminals: Terminals,
    private readonly log: Log,
  ) {
    this.proc.onDidUpdate = () => this.poll();
    this.windows = new WindowRegistry(host.sharedDir, this.proc);
    this.windows.register(host.pid, host.label, terminals.pids);
    // The other windows find this one's terminal sessions by their shells.
    this.terminalsChanged = terminals.onDidChange(() => this.windows.register(host.pid, host.label, terminals.pids));
    const done = host.state.get<string[]>(DONE_KEY, []);
    this.attention.restore(done);
    this.savedDone = done.join("\n");
    const dismissed = host.state.get<Record<string, string>>(DISMISSED_KEY, {});
    this.attention.restoreDismissals(dismissed);
    this.savedDismissed = JSON.stringify(this.attention.dismissals());
    this.sampleStores = { ...host.globalState.get<Record<string, SampleStore>>(SAMPLES_KEY, {}) };
    this.alerts = new AlertLedger(path.join(host.usageDir, "alerts"));
    this.ledger = new RefreshLedger(path.join(host.usageDir, "refresh"));
    this.alerts.prune(Date.now());
    this.ledger.prune(Date.now());
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

  /** The usage numbers, or nothing when there are none to show: none cached, unreadable, or another account's. */
  get usage(): Usage | undefined {
    const snapshot = this.usageRead.snapshot;
    if (!snapshot) return undefined;
    const now = Date.now();
    const stale = isStale(snapshot, now);
    // Numbers too old to go by are no base for a forecast.
    const pace: Record<string, Pace> = {};
    for (const meter of stale ? [] : snapshot.meters) {
      const found = paceOf(this.samples[meter.key], meter, now);
      if (found) pace[meter.key] = found;
    }
    return { ...snapshot, stale, pace };
  }

  /** Claude Code is told to make no network calls it can do without, which fetching usage is. Asked again each time: the settings file can change. */
  private get refreshDisabled(): boolean {
    return this.refreshDisabledByEnv || envFlag(this.settingsEnv?.get(NONESSENTIAL_TRAFFIC));
  }

  /** Lookout can ask the agent for fresh usage numbers. */
  get canRefreshUsage(): boolean {
    return this.usageMode !== "off" && !this.refreshDisabled && this.host.claudeBinary() !== undefined;
  }

  /** Names the numbers shown, for the refreshes on file. */
  private get ledgerKey(): string {
    return `${this.scope}-${this.usageRead.snapshot?.fetchedAt ?? "none"}`;
  }

  /** A refresh of the numbers shown was tried, by this window or another, and they are still there. */
  private get refreshFailing(): boolean {
    if (this.refreshing) return false;
    const key = this.ledgerKey;
    if (this.failedKey === key) return true;
    const { count, lastAt } = this.ledger.attempts(key);
    return count > 0 && lastAt !== undefined && Date.now() - lastAt > REFRESH_IN_FLIGHT_MS;
  }

  /** Why the usage numbers are not kept fresh, when that needs saying. */
  get usageNote(): string | undefined {
    if (this.refreshDisabled) return "refresh disabled by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";
    if (this.usageMode === "off") return "refresh is off (lookout.usage.refresh)";
    if (this.host.claudeBinary() === undefined) return "refresh needs the Claude Code extension";
    if (!this.refreshFailing) return undefined;
    if (this.usageMode !== "auto") return "the last refresh failed";
    return `the last refresh failed; trying again at ${clockTime(Math.max(Date.now(), this.nextRefreshAt(false)))}`;
  }

  /** Starts, or restarts with other settings. */
  start(config: Config): void {
    this.typedQuestions = config.typedQuestions;
    this.providers = [new ClaudeProvider(config.claudeConfigDir, this.proc)];
    this.monitor = new Monitor(this.providers, this.proc);
    const cacheFile = usageCacheFile(config.claudeConfigDir);
    this.usageCache = new UsageCache(cacheFile);
    this.usageRead = { snapshot: undefined, why: "missing" };
    this.scope = scopeOf(cacheFile);
    this.samples = this.sampleStores[this.scope] ??= {};
    this.settingsEnv = new ClaudeSettingsEnv(path.join(config.claudeConfigDir, "settings.json"));
    this.refreshEnvironment = refreshEnv(process.env, config.claudeConfigDir, path.join(os.homedir(), ".claude"));
    this.usageMode = config.usageRefresh;
    this.usageAlerts = config.usageAlerts;
    this.refreshDisabledByEnv = config.usageRefreshDisabled;
    this.archived = new ArchivedSessions(stateDbCandidates(this.host.globalStorageDir));
    if (!this.archived.available) this.log.info("The agent's archived-session list is out of reach; every past session is listed");
    this.log.info(`Watching ${this.providers.map((p) => p.label).join(", ")} (${config.claudeConfigDir})`);
    this.watch();
    this.poll();
  }

  /** Takes settings that need no restart, and shows their effect at once. */
  configure(config: Config): void {
    this.typedQuestions = config.typedQuestions;
    this.usageMode = config.usageRefresh;
    this.usageAlerts = config.usageAlerts;
    this.refreshDisabledByEnv = config.usageRefreshDisabled;
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
    if (this.disposed || !this.usageCache) return;
    this.consider(this.usageCache.readWithReason());
    const now = Date.now();
    if (this.canRefreshUsage && wantsRefresh(this.usageMode, this.usageRead.snapshot, now) && now >= this.nextRefreshAt(false)) void this.refreshUsage();
  }

  /** Takes a read of the cache: newer numbers, or word that there are none to show; never older numbers. */
  private consider(read: UsageRead): void {
    const before = this.usageRead;
    const news = read.snapshot ? before.snapshot === undefined || read.snapshot.fetchedAt > before.snapshot.fetchedAt : before.snapshot !== undefined || read.why !== before.why;
    if (news) this.acceptUsage(read);
    else if ((this.usage?.stale ?? false) !== this.shownStale) this.fireUsage();
  }

  private acceptUsage(read: UsageRead): void {
    this.usageRead = read;
    if (read.snapshot && addSamples(this.samples, read.snapshot)) void this.host.globalState.update(SAMPLES_KEY, this.sampleStores);
    this.announceThresholds();
    this.fireUsage();
  }

  /** Tells the UI about the numbers; also when they only turned stale, which no new reading announces. */
  private fireUsage(): void {
    const usage = this.usage;
    this.shownStale = usage?.stale ?? false;
    this.usageChanged.fire(usage);
  }

  /** The thresholds the numbers shown reach in windows still running; none from numbers too old to go by. */
  private currentAlerts(): UsageAlert[] {
    const usage = this.usage;
    if (!this.usageAlerts || !usage || usage.stale) return [];
    const now = Date.now();
    return reachedThresholds(
      usage.meters.filter((meter) => meter.resetsAt === undefined || meter.resetsAt > now),
      this.scope,
    );
  }

  /**
   * Each threshold once per window, by one VS Code window on the host: the
   * one in front claims it at once; the others leave it a moment, so the
   * alert shows where the user is, and claim it themselves when no window in
   * front did.
   */
  private announceThresholds(): void {
    if (this.disposed) return;
    for (const alert of this.currentAlerts()) {
      if (this.pendingAlerts.has(alert.id)) continue;
      if (this.host.focused()) {
        this.claimAlert(alert);
        continue;
      }
      const timer = setTimeout(() => {
        this.pendingAlerts.delete(alert.id);
        const still = this.currentAlerts().find((current) => current.id === alert.id);
        if (still && !this.disposed) this.claimAlert(still);
      }, ALERT_GRACE_MS);
      this.pendingAlerts.set(alert.id, timer);
    }
  }

  private claimAlert(alert: UsageAlert): void {
    if (this.alerts.claim(alert.id)) this.thresholdReached.fire(alert);
  }

  /**
   * Has the agent fetch fresh usage numbers: at most once every 180 s on the
   * host, and less often after failures unless the user asks (`manual`). The
   * numbers then come from the cache the agent rewrote, with its account
   * check, not from its answer; a refresh that leaves the cache as it was
   * failed. One fetch runs at a time; a call during a fetch waits for it.
   */
  refreshUsage(manual = false): Promise<RefreshOutcome> {
    if (this.refreshing) return this.refreshing;
    const binary = this.host.claudeBinary();
    const cache = this.usageCache;
    if (!binary || !cache || !this.canRefreshUsage) return Promise.resolve("unavailable");
    const now = Date.now();
    const key = this.ledgerKey;
    const before = this.usageRead.snapshot?.fetchedAt;
    if (!this.ledger.claim(key, now, manual)) return Promise.resolve("too soon");
    const refreshing: Promise<RefreshOutcome> = refreshUsage({ binary, env: this.refreshEnvironment })
      .then((answer): RefreshOutcome => {
        this.refreshing = undefined;
        if (this.disposed || cache !== this.usageCache) return "failed";
        this.consider(cache.readWithReason());
        const after = this.usageRead.snapshot?.fetchedAt;
        if (after !== undefined && (before === undefined || after > before)) {
          this.failedKey = undefined;
          return "fetched";
        }
        this.failedKey = this.ledgerKey;
        this.log.errorOnce(answer ? "Usage refresh: Claude Code answered, but its cache did not change" : "Usage refresh: the Claude Code binary gave no usage numbers");
        this.fireUsage();
        return "failed";
      })
      .finally(() => {
        if (this.refreshing === refreshing) this.refreshing = undefined;
      });
    this.refreshing = refreshing;
    return refreshing;
  }

  /** When a refresh may start again, automatic or asked for. */
  nextRefreshAt(manual: boolean): number {
    return this.ledger.nextAt(this.ledgerKey, manual);
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

  /** Another window's record changed: read the windows again, and place the sessions anew. */
  windowsChanged(): void {
    this.windows.invalidate();
    this.schedulePoll();
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
    this.disposed = true;
    for (const timer of this.pendingAlerts.values()) clearTimeout(timer);
    this.pendingAlerts.clear();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    for (const timer of this.announcing) clearTimeout(timer);
    this.announcing.clear();
    this.timer = undefined;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    this.proc.onDidUpdate = undefined;
    this.terminalsChanged.dispose();
    this.windows.unregister(this.host.pid);
    this.changed.dispose();
    this.usageChanged.dispose();
    this.thresholdReached.dispose();
    this.finished.dispose();
    this.waiting.dispose();
  }
}
