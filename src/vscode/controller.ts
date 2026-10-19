import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentHostSessions } from "../core/agentHost";
import type { AgentProvider, ResumeCommand, SearchOutcome } from "../core/agents/agent";
import { BackgroundReads } from "../core/background";
import { SavedPositions } from "../core/savedPositions";
import { ArchivedSessions, stateDbCandidates } from "../core/agents/claude/archived";
import { CLAUDE_CODE, ClaudeProvider } from "../core/agents/claude/provider";
import { CodexProvider } from "../core/agents/codex/provider";
import { chatStorageRoots, LocalChats } from "../core/agents/copilot/localChats";
import { CopilotProvider } from "../core/agents/copilot/provider";
import type { HistoryMessage, SnippetSize } from "../core/history";
import { Attention } from "../core/attention";
import { clockTime } from "../core/format";
import { buildPastView, restoredTabViews, sortViews, type AgentTabs } from "../core/model";
import { Monitor } from "../core/monitor";
import { isParked, park, readParking, settle, unpark, type Parking } from "../core/parking";
import { createProcessFinder, createProcessTable, type ProcessTable } from "../core/proc";
import type { PastView, SessionView, State } from "../core/types";
import { RefreshLedger } from "../core/refreshLedger";
import { hasFilters, parseQuery } from "../core/terms";
import { ClaudeSettingsEnv, envFlag, isStale, NONESSENTIAL_TRAFFIC, UsageCache, usageCacheFile, wantsRefresh, type RefreshMode, type UsageRead, type UsageSnapshot } from "../core/usage";
import { AlertLedger, reachedThresholds, scopeOf, type UsageAlert } from "../core/usageAlerts";
import type { UsageGroup } from "../core/usageGroups";
import { refreshEnv, refreshUsage, type RefreshResult } from "../core/usageRefresh";
import { WindowRegistry } from "../core/windows";
import { WorkerScanner } from "../core/workerScanner";
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
/** Which earlier sessions the board lists and searches: this window's folders, or every project. */
const EARLIER_SCOPE_KEY = "lookout.earlierScope";
/** The sessions the user starred, newest star first; kept for the machine, so every window shows them. */
const FAVOURITES_KEY = "lookout.favourites";
/** The sessions the user archived in Lookout, newest first; kept for the machine. They leave Earlier for the Archived group. */
const ARCHIVE_KEY = "lookout.archive";
/** The sessions parked, and those brought back from Parked; kept for every window. */
const PARKING_KEY = "lookout.parking";
/** The earlier sessions listed at most, the newest. */
const EARLIER_LIMIT = 500;
/** While the earlier sessions are still being read, the next slice is listed this soon. */
const FILL_MS = 300;
/** A window not in front leaves a usage alert this long to a window that is. */
const ALERT_GRACE_MS = 10_000;
/** Matches shown per session. */
const SEARCH_HITS = 3;
/** Without a thread to read them in, a search reads conversations not read yet for at most this long; the rest are reported pending. */
const SEARCH_BUDGET_MS = 150;
/** The conversations are read ahead of any search this long after the window opens, out of the way of its start. */
const READ_AHEAD_AFTER_MS = 3000;
/** And then looked at again at most this often, for what the live ones gained. */
const READ_AHEAD_MS = 2000;
/** The saved places of conversations that are gone are cleared this long after the window opens. */
const PRUNE_AFTER_MS = 60_000;
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
  /** The bundle of the thread that reads the conversations (`dist/reader.js`); without one, a search reads them here, a little at a time. */
  readerScript?: string;
  /** Where the places of each conversation's messages are kept for the next window (positions, no text), when they are read in a thread of their own. */
  savedPositionsDir?: string;
  /**
   * The agent's tabs open in this window whose session is not running: after
   * a reload the agent restores its tabs but starts a session only once its
   * tab is opened. Matched to earlier sessions by `label(title)`.
   */
  restoredTabs?(): AgentTabs;
}

/** The usage numbers as the UI gets them. */
export interface Usage extends UsageSnapshot {
  /** Old, and nothing will bring them up to date. */
  stale: boolean;
}

/** Which earlier sessions are listed and searched. */
export type EarlierScope = "folders" | "all";

/**
 * How a request for fresh usage numbers went. `rate-limited`: the usage
 * endpoint answered 429, now or before, and its wait is not over.
 */
export type RefreshOutcome = "fetched" | "failed" | "too soon" | "unavailable" | "rate-limited" | "no plan limits";

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
  /** Lists the earlier sessions again shortly, while they are still being read. */
  private fill: ReturnType<typeof setTimeout> | undefined;
  private current: readonly SessionView[] = [];
  private snapshot = "[]";
  private pastViews: PastView[] = [];
  /** Every earlier session listed in this window, as last listed: a conversation tab outlives a change of scope. */
  private readonly pastSeen = new Map<string, PastView>();
  /** Each session's state at the last poll, to tell when one starts a turn. */
  private readonly lastStates = new Map<string, State>();
  private earlierScope: EarlierScope;
  /** The scope holds older sessions than the limit lets the board list. */
  private earlierCapped = false;
  /** What the agents' lists leave out and why. */
  private earlierNotes: string[] = [];
  /** The limits of the agents other than Claude that record theirs, by agent id. */
  private agentUsage = new Map<string, UsageSnapshot>();
  /** What the UI last got of them: the numbers and whether they were stale. */
  private agentUsageShown = "";
  /** The starred sessions that are not running, wherever they ran. */
  private favouritePast: PastView[] = [];
  /** The archived sessions that are not running, wherever they ran. */
  private archivePast: PastView[] = [];
  private archived = new ArchivedSessions([]);
  private savedDone = "";
  private savedDismissed = "";
  private typedQuestions = true;
  /** A session resting this long parks on its own; 0: never. */
  private parkAfterMs = 24 * 3_600_000;
  /** Claude Code is watched: its sessions, and its usage, fetched by running it. */
  private claudeOn = true;
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
  /** The numbers the UI last got were stale. */
  private shownStale = false;
  /** The note the UI last got for Claude's group. */
  private shownNote: string | undefined;
  /** The last refresh found that plan limits do not apply to Claude Code's sign-in. */
  private noPlanLimits = false;
  private refreshing: Promise<RefreshOutcome> | undefined;
  /** The source of the numbers shown, named for the refreshes and the alerts. */
  private scope = "";
  private readonly alerts: AlertLedger;
  /** Usage alerts this window waits to claim while it is not in front. */
  private readonly pendingAlerts = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly announcing = new Set<ReturnType<typeof setTimeout>>();
  private readonly terminalsChanged: vscode.Disposable;
  /** Reads the conversations in a thread of their own, when there is one and it has not broken. */
  private background: BackgroundReads | undefined;
  private readonly read = new vscode.EventEmitter<void>();
  /** Conversations were read in the background: a search may find more. */
  readonly onDidRead = this.read.event;
  /** When the conversations are next read ahead of any search. */
  private readAheadAt = Infinity;
  private readAheadTimer: ReturnType<typeof setTimeout> | undefined;
  private pruneTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: ControllerHost,
    private readonly terminals: Terminals,
    private readonly log: Log,
  ) {
    this.proc.onDidUpdate = () => this.poll();
    this.windows = new WindowRegistry(host.sharedDir, this.proc);
    const done = host.state.get<string[]>(DONE_KEY, []);
    this.attention.restore(done);
    this.savedDone = done.join("\n");
    this.register();
    // The other windows find this one's terminal sessions by their shells.
    this.terminalsChanged = terminals.onDidChange(() => this.register());
    this.earlierScope = host.state.get<string>(EARLIER_SCOPE_KEY) === "all" ? "all" : "folders";
    const dismissed = host.state.get<Record<string, string>>(DISMISSED_KEY, {});
    this.attention.restoreDismissals(dismissed);
    this.savedDismissed = JSON.stringify(this.attention.dismissals());
    this.alerts = new AlertLedger(path.join(host.usageDir, "alerts"));
    this.ledger = new RefreshLedger(path.join(host.usageDir, "refresh"));
    this.alerts.prune(Date.now());
    this.ledger.prune(Date.now());
    const script = host.readerScript;
    const saved = script && host.savedPositionsDir ? new SavedPositions(host.savedPositionsDir) : undefined;
    this.background = script ? new BackgroundReads(new WorkerScanner(script), () => this.read.fire(), (error) => this.backgroundBroke(error), saved) : undefined;
    if (saved) this.pruneTimer = setTimeout(() => void saved.prune(), PRUNE_AFTER_MS);
  }

  /** A search's results fill in as the conversations are read in the background, so nobody needs to ask again. */
  get follows(): boolean {
    return this.background !== undefined;
  }

  /**
   * The thread that reads the conversations broke: searches read them here
   * again, a little at a time, as without one. Whoever follows a search hears
   * of it, and from now on asks again by itself.
   */
  private backgroundBroke(error: unknown): void {
    this.log.errorOnce(`The thread that reads the conversations stopped (${error instanceof Error ? error.message : String(error)}); searches read them in the extension host, a little at a time`);
    this.background?.dispose();
    this.background = undefined;
    this.read.fire();
  }

  get sessions(): readonly SessionView[] {
    return this.current;
  }

  /** The sessions that are not running, newest first. */
  get past(): readonly PastView[] {
    return this.pastViews;
  }

  /** Which earlier sessions are listed, the most listed, and whether older ones were left out. */
  get earlier(): { scope: EarlierScope; limit: number; capped: boolean; notes?: string[] } {
    return { scope: this.earlierScope, limit: EARLIER_LIMIT, capped: this.earlierCapped, notes: this.earlierNotes.length ? this.earlierNotes : undefined };
  }

  /** How to resume a session that is not running in a terminal, for an agent whose sessions resume there. */
  resumeCommand(id: string): ResumeCommand | undefined {
    const agent = this.pastView(id)?.agent;
    return this.providers.find((provider) => provider.id === agent)?.resumeCommand?.(id);
  }

  /** Lists and searches the earlier sessions of this window's folders, or of every project; kept for the workspace. */
  setEarlierScope(scope: EarlierScope): void {
    if (scope === this.earlierScope) return;
    this.earlierScope = scope;
    void this.host.state.update(EARLIER_SCOPE_KEY, scope);
    this.poll();
  }

  /** The sessions the user starred, newest star first, and those of them that are not running. */
  get favourites(): { ids: string[]; past: PastView[] } {
    return { ids: this.favouriteIds(), past: this.favouritePast };
  }

  private favouriteIds(): string[] {
    const ids = this.host.globalState.get<unknown>(FAVOURITES_KEY, []);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }

  /** Stars a session, or takes its star away. */
  toggleFavourite(id: string): void {
    const ids = this.favouriteIds();
    void this.host.globalState.update(FAVOURITES_KEY, ids.includes(id) ? ids.filter((other) => other !== id) : [id, ...ids]);
    this.poll();
  }

  /** Puts the starred sessions in the order the user dragged them into; stars it does not name keep theirs, behind. */
  orderFavourites(ids: readonly string[]): void {
    const stars = this.favouriteIds();
    const placed = ids.filter((id, i) => stars.includes(id) && ids.indexOf(id) === i);
    const next = [...placed, ...stars.filter((id) => !placed.includes(id))];
    if (next.join("\n") === stars.join("\n")) return;
    void this.host.globalState.update(FAVOURITES_KEY, next);
    this.poll();
  }

  /** The sessions the user archived in Lookout, newest archive first, and those of them that are not running. */
  get archive(): { ids: string[]; past: PastView[] } {
    return { ids: this.archiveIds(), past: this.archivePast };
  }

  private archiveIds(): string[] {
    const ids = this.host.globalState.get<unknown>(ARCHIVE_KEY, []);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }

  /**
   * Archives a session, taking its star away, or brings it back to Earlier.
   * Lookout keeps the archive itself: the agent's own list of archived
   * sessions is not written.
   */
  toggleArchive(id: string): void {
    const ids = this.archiveIds();
    if (ids.includes(id)) {
      void this.host.globalState.update(ARCHIVE_KEY, ids.filter((other) => other !== id));
    } else {
      void this.host.globalState.update(ARCHIVE_KEY, [id, ...ids]);
      const stars = this.favouriteIds();
      if (stars.includes(id)) void this.host.globalState.update(FAVOURITES_KEY, stars.filter((other) => other !== id));
    }
    this.poll();
  }

  private parking(): Parking {
    return readParking(this.host.globalState.get<unknown>(PARKING_KEY));
  }

  private saveParking(parking: Parking): void {
    if (JSON.stringify(parking) !== JSON.stringify(this.parking())) void this.host.globalState.update(PARKING_KEY, parking);
  }

  /** Parks a session whose turn is over, or brings a parked one back. */
  togglePark(id: string): void {
    const view = this.current.find((v) => v.id === id);
    if (!view) return;
    this.saveParking(view.parked ? unpark(this.parking(), id) : park(this.parking(), id));
    this.poll();
  }

  /**
   * The parked sessions go under Parked, idle: a finished mark this window
   * keeps goes with them, and another window drops its own the same way.
   */
  private parkViews(views: readonly SessionView[], now: number): SessionView[] {
    const parking = settle(this.parking(), views);
    this.saveParking(parking);
    return views.map((view) => {
      if (!isParked(view, parking, now, this.parkAfterMs)) return view;
      if (view.state !== "done") return { ...view, parked: true };
      this.attention.markSeen(view.id);
      return { ...view, state: "idle", parked: true };
    });
  }

  /** Where a live or a past session works: its project, worktree and git branch. */
  whereOf(id: string): string | undefined {
    const view = this.current.find((v) => v.id === id) ?? this.pastView(id);
    if (!view) return undefined;
    const project = view.worktree ? `${view.project} · ${view.worktree}` : view.project;
    return view.branch ? `${project} · ⎇ ${view.branch}` : project;
  }

  /** The title of a live or a past session. */
  titleOf(id: string): string | undefined {
    return this.current.find((view) => view.id === id)?.title ?? this.pastView(id)?.title;
  }

  /** A session that is not running, as listed now or, when the scope has changed since, as last listed. */
  pastView(id: string): PastView | undefined {
    return this.pastViews.find((view) => view.id === id) ?? this.favouritePast.find((view) => view.id === id) ?? this.archivePast.find((view) => view.id === id) ?? this.pastSeen.get(id);
  }

  /** The usage numbers, or nothing when there are none to show: none cached, unreadable, or another account's. */
  get usage(): Usage | undefined {
    const snapshot = this.usageRead.snapshot;
    if (!snapshot) return undefined;
    return { ...snapshot, stale: isStale(snapshot, Date.now()) };
  }

  /**
   * Every agent's usage, one group each, every meter tagged with its agent.
   * Claude's group is there without numbers too, to say there are none and
   * whether a refresh can fetch them.
   */
  get usageGroups(): UsageGroup[] {
    const usage = this.usage;
    const now = Date.now();
    const note = this.claudeNote;
    const claude: UsageGroup = { agent: CLAUDE_CODE, fetchedAt: usage?.fetchedAt, stale: usage?.stale ?? false, meters: (usage?.meters ?? []).map((meter) => ({ ...meter, agent: CLAUDE_CODE })), canRefresh: this.canRefreshUsage, ...(note ? { note } : {}) };
    // The others' numbers come with their sessions' records; Lookout cannot fetch them anew.
    const others = [...this.agentUsage].map(([agent, snapshot]): UsageGroup => ({ agent, fetchedAt: snapshot.fetchedAt, stale: isStale(snapshot, now), meters: snapshot.meters.map((meter) => ({ ...meter, agent })), canRefresh: false }));
    return this.claudeOn ? [claude, ...others] : others;
  }

  /** Claude Code is told to make no network calls it can do without, which fetching usage is. Asked again each time: the settings file can change. */
  private get refreshDisabled(): boolean {
    return this.refreshDisabledByEnv || envFlag(this.settingsEnv?.get(NONESSENTIAL_TRAFFIC));
  }

  /** Lookout can ask the agent for fresh usage numbers. */
  get canRefreshUsage(): boolean {
    return this.claudeOn && this.usageMode !== "off" && !this.refreshDisabled && this.host.claudeBinary() !== undefined;
  }

  /** Epoch ms until which the usage endpoint asked for no more requests from this account; -Infinity when it did not. */
  get refreshHeldUntil(): number {
    return this.ledger.heldUntil(this.scope);
  }

  /** Why Claude's group has no numbers, when Lookout knows: the usage endpoint asked for a wait, or plan limits do not apply. */
  private get claudeNote(): string | undefined {
    if (this.usageRead.snapshot) return undefined;
    const held = this.refreshHeldUntil;
    if (held > Date.now()) return `Too many usage checks; next at ${clockTime(held)}`;
    if (this.noPlanLimits) return "No plan limits for this sign-in";
    return undefined;
  }

  /** Names the numbers shown, for the refreshes on file. */
  private get ledgerKey(): string {
    return `${this.scope}-${this.usageRead.snapshot?.fetchedAt ?? "none"}`;
  }

  /** Why Lookout cannot fetch the usage numbers, when it cannot. */
  get usageNote(): string | undefined {
    if (!this.claudeOn) return "Claude Code is turned off (lookout.agents.claude)";
    if (this.refreshDisabled) return "refresh disabled by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";
    if (this.usageMode === "off") return "refresh is off (lookout.usage.refresh)";
    if (this.host.claudeBinary() === undefined) return "refresh needs the Claude Code extension";
    return undefined;
  }

  /** The sessions VS Code's own Chat runs, through its agent host: one reader for every agent, made on first use. */
  private agentHostSessions: AgentHostSessions | undefined;
  private agentHost(): AgentHostSessions {
    this.agentHostSessions ??= new AgentHostSessions(path.resolve(this.host.globalStorageDir, "..", "..", "agentSessionData"));
    return this.agentHostSessions;
  }

  /** Starts, or restarts with other settings. */
  start(config: Config): void {
    this.typedQuestions = config.typedQuestions;
    this.parkAfterMs = config.parkAfterMs;
    this.claudeOn = config.claudeEnabled;
    this.providers = config.claudeEnabled ? [new ClaudeProvider(config.claudeConfigDir, this.proc)] : [];
    if (config.codexEnabled) {
      // Codex keeps no per-process file: its sessions are its running processes, found by name.
      // Which threads the VS Code extension's app-server holds, from the files it holds open.
      const finder = createProcessFinder("codex", process.platform, { files: true });
      finder.onDidUpdate = () => this.schedulePoll();
      this.providers.push(new CodexProvider(config.codexHome, finder, this.agentHost()));
    }
    if (config.copilotEnabled) {
      // Copilot's sessions name the process holding them; the finder tells which of those still run.
      const finder = createProcessFinder("copilot");
      finder.onDidUpdate = () => this.schedulePoll();
      // VS Code's own Copilot sessions are held by the runtime its agent host runs.
      const runtimes = createProcessFinder("copilot-runtime");
      runtimes.onDidUpdate = () => this.schedulePoll();
      const agentHost = this.agentHost();
      // VS Code's Local chats, kept with the workspaces' storage on the side of VS Code that shows the window.
      const roots = chatStorageRoots(this.host.globalStorageDir);
      const localChats = new LocalChats(() => roots);
      this.providers.push(new CopilotProvider(config.copilotHome, finder, this.proc, Date.now, runtimes, agentHost, localChats));
    }
    this.monitor = new Monitor(this.providers, this.proc);
    const cacheFile = usageCacheFile(config.claudeConfigDir);
    // Claude's usage is read from what Claude Code cached, only while Claude is watched.
    this.usageCache = config.claudeEnabled ? new UsageCache(cacheFile) : undefined;
    this.usageRead = { snapshot: undefined, why: "missing" };
    this.noPlanLimits = false;
    this.scope = scopeOf(cacheFile);
    this.settingsEnv = new ClaudeSettingsEnv(path.join(config.claudeConfigDir, "settings.json"));
    this.refreshEnvironment = refreshEnv(process.env, config.claudeConfigDir, path.join(os.homedir(), ".claude"));
    this.usageMode = config.usageRefresh;
    this.usageAlerts = config.usageAlerts;
    this.refreshDisabledByEnv = config.usageRefreshDisabled;
    // The sessions Claude Code's panel archived: its own list, read only while Claude is watched.
    this.archived = new ArchivedSessions(config.claudeEnabled ? stateDbCandidates(this.host.globalStorageDir) : []);
    if (config.claudeEnabled && !this.archived.available) this.log.info("The agent's archived-session list is out of reach; every past session is listed");
    const homes = [...(config.claudeEnabled ? [config.claudeConfigDir] : []), ...(config.codexEnabled ? [config.codexHome] : []), ...(config.copilotEnabled ? [config.copilotHome] : [])];
    this.log.info(this.providers.length ? `Watching ${this.providers.map((p) => p.label).join(", ")} (${homes.join(", ")})` : "Watching no agent: every agent is turned off");
    this.watch();
    if (this.background && this.readAheadAt === Infinity) {
      this.readAheadAt = Date.now() + READ_AHEAD_AFTER_MS;
      this.readAheadTimer = setTimeout(() => this.poll(), READ_AHEAD_AFTER_MS);
    }
    this.poll();
  }

  /** How many agents are watched: none when every agent is turned off. */
  get watching(): number {
    return this.providers.length;
  }

  /** Takes settings that need no restart, and shows their effect at once. */
  configure(config: Config): void {
    this.typedQuestions = config.typedQuestions;
    this.parkAfterMs = config.parkAfterMs;
    this.usageMode = config.usageRefresh;
    this.usageAlerts = config.usageAlerts;
    this.refreshDisabledByEnv = config.usageRefreshDisabled;
    this.poll();
  }

  /** The window's folders changed: other windows place the sessions VS Code runs in them by its folders. */
  foldersChanged(): void {
    this.register();
    this.poll();
  }

  /** Records this window for the others: its name, terminals, folders, and the sessions it marked finished. */
  private register(): void {
    this.windows.register(this.host.pid, this.host.label, this.terminals.pids, this.host.workspaceFolders(), this.attention.snapshot());
  }

  /** Reads the sessions now, without waiting for the next tick. */
  poll(): void {
    if (!this.monitor) return;
    let views: SessionView[];
    const windows = this.windows.read(this.host.pid);
    try {
      views = this.monitor.poll({
        hostPid: this.host.pid,
        terminalPids: this.terminals.pids,
        folders: this.host.workspaceFolders(),
        windows,
      });
    } catch (err) {
      this.log.errorOnce(`Poll failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return;
    }
    this.notePrompts(views);
    const update = this.attention.update(views, (view) => isWatched(view, this.terminals), {
      typedQuestions: this.typedQuestions,
      doneElsewhere: (view) => view.windowPid !== undefined && (windows.get(view.windowPid)?.done?.includes(view.id) ?? false),
    });
    const exclude = new Set<string>([...update.views.map((view) => view.id), ...this.archived.read()]);
    // A session that runs again leaves the archive.
    let archive = this.archiveIds();
    if (archive.some((id) => update.views.some((view) => view.id === id))) {
      archive = archive.filter((id) => !update.views.some((view) => view.id === id));
      void this.host.globalState.update(ARCHIVE_KEY, archive);
    }
    const archived = new Set(archive);
    // The starred and the archived sessions are asked for by id besides, wherever they ran.
    const scope = { folders: this.host.workspaceFolders(), all: this.earlierScope === "all", limit: EARLIER_LIMIT, also: [...this.favouriteIds(), ...archive] };
    let capped = false;
    let incomplete = false;
    const notes: string[] = [];
    const also: PastView[] = [];
    const past = this.providers
      .flatMap((provider) => {
        const list = provider.past?.(scope, exclude);
        capped ||= list?.capped ?? false;
        incomplete ||= list?.incomplete ?? false;
        notes.push(...(list?.notes ?? []));
        also.push(...(list?.also ?? []).map(buildPastView));
        return list?.sessions ?? [];
      })
      .map(buildPastView);
    past.sort((a, b) => b.modifiedAt - a.modifiedAt);
    // Tabs the agent restored after a reload, not started yet: their sessions stay on the board, idle.
    const restored = this.claudeOn && this.host.restoredTabs ? restoredTabViews(past, update.views, this.host.restoredTabs()) : [];
    const notRestored = (view: PastView) => !restored.some((r) => r.id === view.id);
    // The archived leave Earlier for the Archived group, newest archive first.
    const shownPast = past.filter((view) => !archived.has(view.id) && notRestored(view));
    const archivePast = [...past, ...also].filter((view) => archived.has(view.id) && notRestored(view)).sort((a, b) => archive.indexOf(a.id) - archive.indexOf(b.id));
    const favouritePast = also.filter((view) => !archived.has(view.id));
    this.earlierCapped = capped || shownPast.length > EARLIER_LIMIT;
    this.earlierNotes = notes;
    // An idle tab or terminal with nothing sent is not worth a card.
    const shown = update.views.filter((view) => !(view.empty && view.state === "idle"));
    this.publish(sortViews(this.parkViews([...shown, ...restored], Date.now())), shownPast.slice(0, EARLIER_LIMIT), favouritePast, archivePast);
    for (const view of [...this.pastViews, ...this.favouritePast, ...this.archivePast]) this.pastSeen.set(view.id, view);
    if (incomplete) this.scheduleFill();
    this.saveDone();
    for (const view of update.finished) this.announceFinished(view);
    for (const view of update.waiting) this.announce(view);
    this.pollUsage();
    this.readAhead();
  }

  /** Has the background read every conversation the search covers, so the first search finds them read. */
  private readAhead(): void {
    const now = Date.now();
    if (!this.background || now < this.readAheadAt) return;
    this.readAheadAt = now + READ_AHEAD_MS;
    for (const provider of this.providers) provider.readAhead?.(this.background);
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
    if (this.disposed || !this.monitor) return;
    this.pollAgentUsage();
    if (!this.usageCache) return;
    this.consider(this.usageCache.readWithReason());
    const now = Date.now();
    if (this.canRefreshUsage && wantsRefresh(this.usageMode, this.usageRead.snapshot, now) && now >= this.nextRefreshAt(false)) void this.refreshUsage();
  }

  /**
   * The limits of the other agents, as their providers read them from their
   * records. The UI hears of new numbers and of numbers that turned stale;
   * new numbers are checked against the alert thresholds.
   */
  private pollAgentUsage(): void {
    const now = Date.now();
    const next = new Map<string, UsageSnapshot>();
    for (const provider of this.providers) {
      const snapshot = provider.usage?.(now);
      if (snapshot) next.set(provider.id, snapshot);
    }
    const changed = JSON.stringify([...next]) !== JSON.stringify([...this.agentUsage]);
    this.agentUsage = next;
    const shown = JSON.stringify([...next].map(([agent, snapshot]) => [agent, snapshot.fetchedAt, isStale(snapshot, now)]));
    if (!changed && shown === this.agentUsageShown) return;
    this.agentUsageShown = shown;
    if (changed) this.announceThresholds();
    this.usageChanged.fire(this.usage);
  }

  /** Takes a read of the cache: newer numbers, or word that there are none to show; never older numbers. */
  private consider(read: UsageRead): void {
    const before = this.usageRead;
    const news = read.snapshot ? before.snapshot === undefined || read.snapshot.fetchedAt > before.snapshot.fetchedAt : before.snapshot !== undefined || read.why !== before.why;
    if (news) this.acceptUsage(read);
    else if ((this.usage?.stale ?? false) !== this.shownStale || this.claudeNote !== this.shownNote) this.fireUsage();
  }

  private acceptUsage(read: UsageRead): void {
    this.usageRead = read;
    this.announceThresholds();
    this.fireUsage();
  }

  /** Tells the UI about the numbers; also when they only turned stale, which no new reading announces. */
  private fireUsage(): void {
    const usage = this.usage;
    this.shownStale = usage?.stale ?? false;
    this.shownNote = this.claudeNote;
    this.usageChanged.fire(usage);
  }

  /** The thresholds the numbers shown reach in windows still running; none from numbers too old to go by. */
  private currentAlerts(): UsageAlert[] {
    if (!this.usageAlerts) return [];
    const usage = this.usage;
    const now = Date.now();
    const running = (meter: { resetsAt?: number }) => meter.resetsAt === undefined || meter.resetsAt > now;
    const alerts = usage && !usage.stale ? reachedThresholds(usage.meters.filter(running), this.scope) : [];
    // Each other agent's windows, named for that agent: each threshold of each window is announced once.
    for (const [agent, snapshot] of this.agentUsage) {
      if (isStale(snapshot, now)) continue;
      alerts.push(...reachedThresholds(snapshot.meters.filter(running).map((meter) => ({ ...meter, agent })), agent));
    }
    return alerts;
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
   * host, and less often after failures unless the user asks (`manual`);
   * after the usage endpoint answered 429, not before the wait its
   * Retry-After asks, the user's request neither. The numbers then come from
   * the cache the agent rewrote, with its account check, not from its
   * answer; a refresh that leaves the cache as it was failed. One fetch runs
   * at a time; a call during a fetch waits for it.
   */
  refreshUsage(manual = false): Promise<RefreshOutcome> {
    if (this.refreshing) return this.refreshing;
    const binary = this.host.claudeBinary();
    const cache = this.usageCache;
    if (!binary || !cache || !this.canRefreshUsage) return Promise.resolve("unavailable");
    const now = Date.now();
    if (now < this.refreshHeldUntil) return Promise.resolve("rate-limited");
    const key = this.ledgerKey;
    const scope = this.scope;
    const before = this.usageRead.snapshot?.fetchedAt;
    if (!this.ledger.claim(key, now, manual)) return Promise.resolve("too soon");
    const refreshing: Promise<RefreshOutcome> = refreshUsage({ binary, env: this.refreshEnvironment })
      .then((result): RefreshOutcome => {
        this.refreshing = undefined;
        if (this.disposed || cache !== this.usageCache) return "failed";
        this.noPlanLimits = result.answer?.kind === "no plan limits";
        if (result.retryAfterMs !== undefined) {
          const until = Date.now() + result.retryAfterMs;
          this.ledger.hold(scope, until);
          this.log.info(`Usage refresh: the usage endpoint answered 429 (too many requests); no refresh before ${clockTime(until)}, the wait its Retry-After asks`);
        }
        this.consider(cache.readWithReason());
        const after = this.usageRead.snapshot?.fetchedAt;
        if (after !== undefined && (before === undefined || after > before)) return "fetched";
        if (result.retryAfterMs === undefined) this.log.errorOnce(refreshFailure(result));
        this.fireUsage();
        if (result.retryAfterMs !== undefined) return "rate-limited";
        return this.noPlanLimits ? "no plan limits" : "failed";
      })
      .finally(() => {
        if (this.refreshing === refreshing) this.refreshing = undefined;
      });
    this.refreshing = refreshing;
    return refreshing;
  }

  /** When a refresh may start again, automatic or asked for. */
  nextRefreshAt(manual: boolean): number {
    return Math.max(this.ledger.nextAt(this.ledgerKey, manual), this.refreshHeldUntil);
  }

  /**
   * Searches the conversations of the live and the past sessions: the newest
   * few matches per session, for the cards, or for the search page `page`
   * asks (more matches, cut wider). Days go by `zone`, the time zone of
   * whoever searches (minutes behind UTC): in a remote window the
   * extension's own clock can be in another.
   */
  search(query: string, zone?: number, page?: { hits: number; snippet: SnippetSize }): SearchOutcome {
    const started = Date.now();
    const parsed = parseQuery(query, started, zone);
    const outcome: SearchOutcome = { results: [], pending: 0 };
    if (parsed.terms.length === 0 && !hasFilters(parsed)) return outcome;
    for (const provider of this.providers) {
      const left = Math.max(0, SEARCH_BUDGET_MS - (Date.now() - started));
      const part = provider.search?.(parsed, page?.hits ?? SEARCH_HITS, left, page?.snippet, this.background);
      if (!part) continue;
      outcome.results.push(...part.results);
      outcome.pending += part.pending;
    }
    return outcome;
  }

  /** The conversation of one live session, oldest first. */
  history(id: string): HistoryMessage[] | undefined {
    for (const provider of this.providers) {
      const messages = provider.history?.(id, this.background);
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

  /** The user marked these sessions of this window seen in another window. */
  seenElsewhere(ids: readonly string[]): void {
    let any = false;
    for (const id of ids) if (this.attention.markSeen(id)) any = true;
    if (any) this.poll();
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

  /**
   * A session of this window that starts a turn was sent a prompt where it
   * runs, so the user was there: in its terminal, or, for a panel session,
   * outside the terminals. Work its background jobs do is no prompt.
   */
  private notePrompts(views: readonly SessionView[]): void {
    const now = Date.now();
    for (const view of views) {
      const before = this.lastStates.get(view.id);
      if (view.state !== "working" || view.background || before === undefined || before === "working") continue;
      if (view.host === "terminal" && view.terminalPid !== undefined) this.terminals.sawPrompt(view.terminalPid, view.since ?? now);
      else if (view.host === "panel") this.terminals.sawPrompt("elsewhere", view.since ?? now);
    }
    this.lastStates.clear();
    for (const view of views) this.lastStates.set(view.id, view.state);
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

  private scheduleFill(): void {
    if (this.fill || this.disposed) return;
    this.fill = setTimeout(() => {
      this.fill = undefined;
      this.poll();
    }, FILL_MS);
  }

  private schedulePoll(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.poll();
    }, DEBOUNCE_MS);
  }

  private publish(views: SessionView[], past: PastView[], favouritePast: PastView[], archivePast: PastView[]): void {
    const snapshot = JSON.stringify([views, past, this.earlierScope, this.earlierCapped, this.earlierNotes, this.favouriteIds(), favouritePast, archivePast]);
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.current = views;
    this.pastViews = past;
    this.favouritePast = favouritePast;
    this.archivePast = archivePast;
    this.changed.fire(views);
  }

  private saveDone(): void {
    const done = this.attention.snapshot();
    const key = done.join("\n");
    if (key !== this.savedDone) {
      this.savedDone = key;
      void this.host.state.update(DONE_KEY, done);
      // The other windows show this window's finished sessions as it marks them.
      this.register();
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
    if (this.fill) clearTimeout(this.fill);
    if (this.readAheadTimer) clearTimeout(this.readAheadTimer);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.background?.dispose();
    this.read.dispose();
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

/** What the log says about a refresh that brought no new numbers. */
function refreshFailure(result: RefreshResult): string {
  const why = result.failure ? `: ${result.failure}` : "";
  switch (result.answer?.kind) {
    case "no plan limits":
      return "Usage refresh: Claude Code reports no plan limits for its sign-in (an API key, Bedrock or Vertex, or a token without the profile scope)";
    case "numbers":
      return `Usage refresh: Claude Code answered, but its cache did not change${why}`;
    default:
      return `Usage refresh: the Claude Code binary gave no usage numbers${why}`;
  }
}
