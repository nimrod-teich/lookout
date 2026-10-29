import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentHostSessions } from "../core/agentHost";
import type { AgentProvider, ResumeCommand, SearchOutcome } from "../core/agents/agent";
import { BackgroundReads } from "../core/background";
import { SavedPositions } from "../core/savedPositions";
import { accountFile, describeDirs, emailKey, type AccountFile } from "../core/agents/claude/account";
import { ArchivedSessions, stateDbCandidates } from "../core/agents/claude/archived";
import { closeStores, runScan } from "../core/agents/lineReaders";
import { managedRetention, readRetention, retentionIn, userSettingsFile, writeRetention } from "../core/agents/claude/retention";
import { signInEnv, type ClaudeDir } from "../core/agents/claude/paths";
import { CLAUDE_CODE, ClaudeProvider } from "../core/agents/claude/provider";
import { CodexProvider } from "../core/agents/codex/provider";
import { chatStorageRoots, LocalChats } from "../core/agents/copilot/localChats";
import { CopilotProvider } from "../core/agents/copilot/provider";
import { readThroughStore, type HistoryMessage, type SnippetSize } from "../core/history";
import { Attention } from "../core/attention";
import { clockTime } from "../core/format";
import { buildPastView, projectOf, restoredTabViews, sortViews, type AgentTabs } from "../core/model";
import { Monitor } from "../core/monitor";
import { withNotes, type NotedSession } from "../core/notes";
import { isParked, park, readParking, settle, unpark, type Parking } from "../core/parking";
import { createProcessFinder, createProcessTable, type ProcessTable } from "../core/proc";
import type { PastView, SessionView, State } from "../core/types";
import { RefreshLedger } from "../core/refreshLedger";
import { readThrough, searchWithStore } from "../core/search";
import { latestNote, SessionRecords, type NoteEntry, type SessionSeen } from "../core/sessionRecords";
import { ConversationStore, type StoredSession } from "../core/store";
import { hasFilters, parseQuery } from "../core/terms";
import { TranscriptVault, type Restore } from "../core/vault";
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

/** How applying `lookout.retention.days` went: a write, or why not. */
export type RetentionOutcome =
  | { kind: "written"; days: number; file: string; backup?: string; overriddenBy?: string }
  | { kind: "managed"; days: number; file: string }
  | { kind: "failed"; days: number; file: string; why: string };

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
/** The Claude accounts seen signed in on the machine: organization uuid → `emailKey` of the account's address, never the address. */
const CLAUDE_ORGS_KEY = "lookout.claudeOrgs";
/** The sessions the user archived in Lookout, newest first; kept for the machine. They leave Earlier for the Archived group. */
const ARCHIVE_KEY = "lookout.archive";
/** The sessions parked, and those brought back from Parked; kept for every window. */
const PARKING_KEY = "lookout.parking";
/** The earlier sessions listed and searched at most, the newest, while their messages are held in memory: without the store. */
const EARLIER_LIMIT = 500;
/** With the store, the database is the index: every earlier session is listed and searched. */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;
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
/** The transcripts are looked for this often: one gone leaves its session under Purged. */
const SWEEP_MS = 600_000;
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
  /** Where Lookout keeps what is its own about each session, the user's note first of all, for every window; without it, no notes. */
  recordsDir?: string;
  /** The database the conversations go into as they are read, to outlive the agents' transcripts and to be searched; without it, or without `node:sqlite`, the search reads the files as before. */
  storeFile?: string;
  /** How often the transcripts are looked for, for the tests. */
  sweepMs?: number;
  /** Where the transcripts the user asked Lookout to keep are kept; without it, no keeping. */
  vaultDir?: string;
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

/** One Claude Code directory's usage: the numbers it cached, and how Lookout has them refreshed. */
interface UsageSource {
  dir: ClaudeDir;
  /** Its label, while several directories are watched. */
  account?: string;
  /** Names its usage group: the agent's id, with the label while several directories are watched. */
  key: string;
  cache: UsageCache;
  /** Who the directory is signed in as: directories signed in to one account show one group. */
  signedIn: AccountFile;
  /** The directory's own settings file, which can switch refreshes off. */
  settingsEnv: ClaudeSettingsEnv;
  /** The environment the binary gets: the directory's own sign-in. */
  env: NodeJS.ProcessEnv;
  /** Where the numbers come from, named for the refreshes and the alerts. */
  scope: string;
  read: UsageRead;
  /** The last refresh found that plan limits do not apply to the directory's sign-in. */
  noPlanLimits: boolean;
  /** The numbers the UI last got were stale. */
  shownStale: boolean;
  /** The note the UI last got for the group. */
  shownNote: string | undefined;
}

/** A directory's usage source; with `accounts`, keyed and named by its label. */
function usageSource(dir: ClaudeDir, accounts: boolean): UsageSource {
  const file = usageCacheFile(dir.resolved);
  return {
    dir,
    ...(accounts ? { account: dir.label } : {}),
    key: accounts ? `${CLAUDE_CODE}:${dir.label}` : CLAUDE_CODE,
    cache: new UsageCache(file),
    signedIn: accountFile(file),
    settingsEnv: new ClaudeSettingsEnv(path.join(dir.resolved, "settings.json")),
    env: refreshEnv(process.env, dir),
    scope: scopeOf(file),
    read: { snapshot: undefined, why: "missing" },
    noPlanLimits: false,
    shownStale: false,
    shownNote: undefined,
  };
}

/** A source's numbers, or none: none cached, unreadable, or another account's. */
function usageOf(source: UsageSource | undefined, now: number = Date.now()): Usage | undefined {
  const snapshot = source?.read.snapshot;
  return snapshot ? { ...snapshot, stale: isStale(snapshot, now) } : undefined;
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
  /** The sessions published last, by id: the running ones, and the listed ones by list, the first list holding one wins. */
  private liveById = new Map<string, SessionView>();
  private pastById = new Map<string, PastView>();
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
  /** The sessions with a note that are not running and that no other list holds, wherever they ran: searched, and named on the search page. */
  private notedPast: PastView[] = [];
  /** What Lookout keeps about the sessions itself: the user's notes, with each session's title and place as last seen. */
  private readonly records: SessionRecords | undefined;
  private readonly recordsWatch: { dispose(): void } | undefined;
  /** The conversations, kept: searched from here, and read from here once a transcript is gone. */
  private readonly store: ConversationStore | undefined;
  /** The build of the reading code, which the store's rows and the saved places must come from. */
  private readonly build: string;
  /** The sessions whose transcript is gone, their conversations kept, last written first. */
  private purgedPast: PastView[] = [];
  private purgedKey = "[]";
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Keep a conversation after its transcript goes; off: it goes with it. */
  private historyKeep = true;
  /** The search keeps what the tool calls ran and returned too. */
  private toolOutput = false;
  /** When keeping went off, if it is: only what is purged since then goes. */
  private keepOffSince: number | undefined;
  /** What the store was last told of each session, to tell it only of changes. */
  private readonly remembered = new Map<string, string>();
  /** The sessions listed under Earlier at the last poll: one gone since has its transcript looked for at once. */
  private listedBefore = new Set<string>();
  /** The transcripts kept on the user's say-so. */
  private readonly vault: TranscriptVault | undefined;
  /** The sessions whose transcript is kept, as last read from the vault. */
  private keptIds = new Set<string>();
  /** Keep every starred session's transcript. */
  private keepFavourites = false;
  private sweepSoon: ReturnType<typeof setTimeout> | undefined;
  private archived = new ArchivedSessions([]);
  private savedDone = "";
  private savedDismissed = "";
  private typedQuestions = true;
  /** A session resting this long parks on its own; 0: never. */
  private parkAfterMs = 24 * 3_600_000;
  /** Claude Code is watched: its sessions, and its usage, fetched by running it. */
  private claudeOn = true;
  /** The Claude Code config directory watched: its settings files say how long it keeps transcripts. */
  private claudeConfigDir = "";
  /** Keep Claude Code's transcripts this many days, written into its user settings file; 0 leaves Claude Code's own. */
  private retentionDays = 0;
  private usageMode: RefreshMode = "manual";
  private usageAlerts = true;
  /** Refresh is switched off for Claude Code in VS Code's environment or the Claude Code extension's settings. */
  private refreshDisabledByEnv = false;
  /** Claude Code's usage: a source per directory watched, the primary first; none while Claude is not watched. */
  private sources: UsageSource[] = [];
  private readonly ledger: RefreshLedger;
  /** The one refresh this window runs, and whose numbers it fetches. */
  private refreshing: { key: string; promise: Promise<RefreshOutcome> } | undefined;
  /** The groups the UI last got, and the directories each shares its account with. */
  private shownSources = "";
  /** The names the user gave Claude accounts, by `emailKey`. */
  private accountNames = new Map<string, string>();
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
    this.build = (script ? buildOf(script) : undefined) ?? "in-thread";
    this.store = host.storeFile ? ConversationStore.open(host.storeFile) : undefined;
    if (host.storeFile && !this.store) this.log.info("The conversations are not kept: this runtime has no node:sqlite, or the database could not be opened");
    // With the store, the saved places are not needed: the store says how far each file was read.
    const saved = !this.store && script && host.savedPositionsDir ? new SavedPositions(host.savedPositionsDir, this.build) : undefined;
    const into = this.store ? { file: this.store.file, build: this.build } : undefined;
    // Every index reads through the store from now on: a read on its own would leave the store behind.
    // The store is the index: the indexes keep no messages, and read them from it.
    this.installReadThrough();
    this.background = script ? new BackgroundReads(new WorkerScanner(script), () => this.read.fire(), (error) => this.backgroundBroke(error), saved, into) : undefined;
    if (saved) this.pruneTimer = setTimeout(() => void saved.prune(), PRUNE_AFTER_MS);
    this.vault = host.vaultDir ? new TranscriptVault(host.vaultDir) : undefined;
    this.readKept();
    this.records = host.recordsDir ? new SessionRecords(host.recordsDir) : undefined;
    // A note written in another window shows here too.
    this.recordsWatch = this.records?.watch(() => this.schedulePoll());
  }

  /** The earlier sessions listed and searched at most: every one while the store is the index, else the newest 500. */
  private get earlierLimit(): number {
    return this.store ? NO_LIMIT : EARLIER_LIMIT;
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
    return { scope: this.earlierScope, limit: this.earlierLimit, capped: this.earlierCapped, notes: this.earlierNotes.length ? this.earlierNotes : undefined };
  }

  /**
   * Keeps Claude Code's retention of transcripts at `lookout.retention.days`:
   * the one setting Lookout writes, into Claude Code's user settings file,
   * when that file says otherwise. Nothing while the setting is 0, Claude
   * Code is off, or the file holds the value already; else what was done.
   */
  applyRetention(): RetentionOutcome | undefined {
    const days = this.retentionDays;
    if (!this.claudeOn || this.claudeConfigDir === "" || days <= 0) return undefined;
    // Managed settings win over the user's file: a write there would change nothing.
    const managed = managedRetention(this.claudeConfigDir);
    if (managed.in.kind === "set" || managed.in.kind === "invalid") return { kind: "managed", days, file: managed.file ?? "the managed settings" };
    const file = userSettingsFile(this.claudeConfigDir);
    const held = retentionIn(file);
    if (held.kind === "set" && held.days === days) return undefined;
    const outcome = writeRetention(this.claudeConfigDir, days);
    if (!outcome.ok) return { kind: "failed", days, file: outcome.file, why: outcome.why };
    // A folder's own settings file still sets its own for this window.
    const effective = readRetention(this.claudeConfigDir, this.host.workspaceFolders());
    const overriddenBy = effective.level === "project" || effective.level === "local" ? effective.file : undefined;
    return { kind: "written", days, file: outcome.file, ...(outcome.backup ? { backup: outcome.backup } : {}), ...(overriddenBy ? { overriddenBy } : {}) };
  }

  /** How to resume a session that is not running in a terminal, for an agent whose sessions resume there. */
  resumeCommand(id: string): ResumeCommand | undefined {
    const agent = this.pastView(id)?.agent;
    // An agent watched in several accounts has a provider for each: the one that listed the session answers.
    for (const provider of this.providers) {
      if (provider.id !== agent) continue;
      const command = provider.resumeCommand?.(id);
      if (command) return command;
    }
    return undefined;
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
    const view = this.liveById.get(id) ?? this.pastView(id);
    if (!view) return undefined;
    const project = view.worktree ? `${view.project} · ${view.worktree}` : view.project;
    const where = view.account ? `${view.account} · ${project}` : project;
    return view.branch ? `${where} · ⎇ ${view.branch}` : where;
  }

  /** The title of a live or a past session. */
  titleOf(id: string): string | undefined {
    return this.liveById.get(id)?.title ?? this.pastView(id)?.title;
  }

  /** The agent of a live or a past session. */
  agentOf(id: string): string | undefined {
    return (this.liveById.get(id) ?? this.pastView(id))?.agent;
  }

  /**
   * When each session's conversation started and was last active, by its
   * messages' times: from the store, one question for all of them, where it
   * holds the conversation; else from the conversation read here.
   */
  spansOf(ids: readonly string[]): Map<string, { started?: number; lastActive?: number }> {
    const out = new Map<string, { started?: number; lastActive?: number }>();
    const files = new Map<string, string>();
    if (this.store) for (const id of ids) {
      const file = this.fileOf(id) ?? this.store.session(id)?.file;
      if (file) files.set(id, file);
    }
    const spans = this.store ? this.store.spans([...files.values()]) : new Map<string, { started: number; lastActive: number }>();
    for (const id of ids) {
      const file = files.get(id);
      const span = file ? spans.get(file) : undefined;
      if (span) {
        out.set(id, span);
        continue;
      }
      const times = (this.history(id) ?? []).map((message) => message.at).filter((at): at is number => at !== undefined);
      out.set(id, times.length ? { started: Math.min(...times), lastActive: Math.max(...times) } : {});
    }
    return out;
  }

  /** A session that is not running, as listed now or, when the scope has changed since, as last listed; failing those, as its record remembers it. */
  pastView(id: string): PastView | undefined {
    return this.pastById.get(id) ?? this.pastSeen.get(id) ?? this.recordedView(id);
  }

  /** The sessions whose transcript the agent deleted, their conversations kept by Lookout. */
  get purged(): readonly PastView[] {
    return this.purgedPast;
  }

  /** The conversations are kept in a store of Lookout's own: searched from it, and read from it once a transcript is gone. */
  get keepsConversations(): boolean {
    return this.store !== undefined;
  }

  /** Where the kept transcripts are, when keeping is on. */
  get keptTranscriptsDir(): string | undefined {
    return this.host.vaultDir;
  }

  /** The sessions whose transcript Lookout keeps. */
  get kept(): ReadonlySet<string> {
    return this.keptIds;
  }

  /** A session's transcript can be kept: it is known, and there. */
  canKeep(id: string): boolean {
    return this.transcriptOf(id) !== undefined;
  }

  /** The transcript of a live or a past session, when there is one on disk. */
  private transcriptOf(id: string): string | undefined {
    const file = this.fileOf(id) ?? this.store?.session(id)?.file;
    return file && fs.existsSync(file) ? file : undefined;
  }

  /** Keeps a session's transcript, on the user's say-so; false when there is none to keep, or it could not be. */
  keepTranscript(id: string): boolean {
    if (!this.vault) return false;
    const view = this.current.find((v) => v.id === id) ?? this.pastView(id);
    const file = this.transcriptOf(id);
    if (!view || !file) return false;
    const kept = this.vault.keep(id, view.agent, file);
    if (kept) this.readIntoStore(id);
    this.readKept();
    this.poll();
    return kept !== undefined;
  }

  /** Has the store read a session's conversation, so it holds what the transcript says before the agent deletes it. */
  private readIntoStore(id: string): void {
    if (!this.store) return;
    for (const provider of this.providers) {
      if (!provider.conversations) continue;
      for (const conversation of provider.conversations()) {
        if (conversation.id !== id) continue;
        readThrough(conversation, this.background);
        return;
      }
    }
  }

  /** Stops keeping a session's transcript: the copy goes. */
  releaseTranscript(id: string): void {
    if (!this.vault) return;
    this.vault.release(id);
    this.readKept();
    this.poll();
  }

  /** Puts a purged session's kept transcript back where the agent keeps its transcripts; the session leaves Purged once the sweep finds it there. */
  restoreTranscript(id: string): Restore {
    if (!this.vault) return { ok: false, file: "", why: "is not kept" };
    const outcome = this.vault.restore(id);
    if (outcome.ok) this.sweepStore();
    return outcome;
  }

  /** Reads which sessions the vault keeps: on start, after a change here, and at every sweep, for what other windows kept. */
  private readKept(): void {
    this.keptIds = new Set(this.vault ? this.vault.kept().map((record) => record.id) : []);
  }

  /** The starred sessions' transcripts, kept when the setting asks, and the kept transcripts of sessions whose file the agent replaced, kept again. */
  private keepStarred(stars: ReadonlySet<string>, live: readonly SessionView[]): void {
    if (!this.vault || !this.keepFavourites) return;
    let changed = false;
    for (const id of stars) {
      if (this.keptIds.has(id)) continue;
      const view = live.find((v) => v.id === id) ?? this.pastView(id);
      const file = this.transcriptOf(id);
      if (!view || !file) continue;
      if (this.vault.keep(id, view.agent, file)) {
        this.readIntoStore(id);
        changed = true;
      }
    }
    if (changed) this.readKept();
  }

  /** The views marked with what is kept of them. */
  private markKept<T extends { id: string; kept?: boolean }>(views: T[]): T[] {
    if (this.keptIds.size === 0) return views;
    return views.map((view) => (this.keptIds.has(view.id) ? { ...view, kept: true } : view));
  }

  /** Forgets a purged session: its kept conversation goes. */
  forget(id: string): void {
    if (!this.store) return;
    this.store.forget([id]);
    this.pastSeen.delete(id);
    this.sweepStore();
  }

  /** Forgets every purged session; how many. */
  forgetPurged(): number {
    if (!this.store) return 0;
    const count = this.store.forgetPurged();
    this.sweepStore();
    return count;
  }

  /**
   * Looks for every remembered session's transcript: one gone leaves its
   * session under Purged, with its conversation kept, or, with nothing
   * kept, is forgotten; one back comes back.
   */
  private sweepStore(): void {
    if (this.disposed) return;
    if (this.vault) {
      // A kept transcript whose file the agent replaced is kept again from the new file.
      for (const record of this.vault.kept()) if (fs.existsSync(record.file)) this.vault.refresh(record.id);
      this.readKept();
    }
    if (!this.store) return;
    const letting = this.keepOffSince === undefined ? undefined : { after: this.keepOffSince, graceMs: this.host.sweepMs ?? SWEEP_MS };
    this.store.sweep(Date.now(), this.keptIds, letting);
    // With keeping off, nothing shows under Purged; what was kept before stays in the store until forgotten.
    const purged = this.historyKeep ? this.store.purged() : [];
    const key = JSON.stringify(purged);
    if (key === this.purgedKey) return;
    this.purgedKey = key;
    this.purgedPast = purged.map(purgedView);
    this.poll();
  }

  /** A session listed last time and neither listed nor running now: its transcript may be gone, so the sweep runs at once rather than at its hour. */
  private noticeVanished(live: readonly SessionView[], past: readonly PastView[]): void {
    const listed = new Set(past.map((view) => view.id));
    let vanished = false;
    for (const id of this.listedBefore) {
      if (listed.has(id) || live.some((view) => view.id === id)) continue;
      vanished = true;
      break;
    }
    this.listedBefore = listed;
    if (!vanished || !this.store || this.sweepSoon) return;
    this.sweepSoon = setTimeout(() => {
      this.sweepSoon = undefined;
      this.sweepStore();
    }, DEBOUNCE_MS);
  }

  /** Tells the store what each listed session is called and where its conversation is, when that changed. */
  private rememberSessions(live: readonly SessionView[], past: readonly PastView[]): void {
    if (!this.store) return;
    // What changed since the store was last told, written in one transaction.
    const changed: { session: Parameters<ConversationStore["rememberSession"]>[0]; key: string }[] = [];
    const remember = (id: string, agent: string, title: string, cwd: string, branch: string | undefined, modifiedAt: number | undefined) => {
      const file = this.fileOf(id);
      if (!file) return;
      const key = [agent, file, title, cwd, branch ?? "", modifiedAt ?? ""].join("\n");
      if (this.remembered.get(id) === key) return;
      changed.push({ session: { id, agent, file, title, cwd, branch, modifiedAt }, key });
    };
    // A running session's time changes with every line: the store keeps the one it has until the session rests.
    for (const view of live) if (!view.restored) remember(view.id, view.agent, view.title, view.cwd, view.branch, undefined);
    for (const view of past) if (!view.purged) remember(view.id, view.agent, view.title, view.cwd, view.branch, view.modifiedAt);
    if (changed.length === 0) return;
    try {
      this.store.rememberSessions(changed.map((c) => c.session));
      for (const { session, key } of changed) this.remembered.set(session.id, key);
    } catch (error) {
      this.log.errorOnce(`The conversation store could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The conversation file of a live or a past session, from its agent. */
  private fileOf(id: string): string | undefined {
    for (const provider of this.providers) {
      const file = provider.fileOf?.(id);
      if (file) return file;
    }
    return undefined;
  }

  /** What a session's record says it was called and where it worked, for a session no agent lists any more. */
  private recordedView(id: string): PastView | undefined {
    const record = this.records?.get(id);
    if (!record) return undefined;
    const cwd = record.cwd ?? "";
    const latest = latestNote(record);
    return { id, agent: record.agent, title: record.title ?? "Untitled session", ...projectOf(cwd), branch: record.branch, cwd, resumable: false, modifiedAt: record.modifiedAt ?? latest?.at ?? 0, ...noteFields(record.notes) };
  }

  /** The user's notes on a live or a past session, oldest first. */
  notesOf(id: string): NoteEntry[] {
    return this.records?.notesOf(id) ?? [];
  }

  /** What the board knows a session as, for its record: as it runs, or as last listed. */
  private seenFor(id: string): SessionSeen | undefined {
    const live = this.current.find((view) => view.id === id);
    if (live) return seenOf(live);
    const past = this.pastView(id);
    return past ? seenOf(past) : undefined;
  }

  /**
   * Adds a note to a session's thread, with the session's title and place
   * as the board has them. False when Lookout keeps no records, knows
   * nothing of the session, or the note is blank.
   */
  addNote(id: string, text: string): boolean {
    if (!this.records) return false;
    const seen = this.seenFor(id);
    if (!seen && !this.records.get(id)) return false;
    if (!this.records.addNote(id, text, seen)) return false;
    this.poll();
    return true;
  }

  /** Changes one note; a blank text takes it away. False when Lookout cannot. */
  editNote(id: string, noteId: string, text: string): boolean {
    if (!this.records?.editNote(id, noteId, text)) return false;
    this.poll();
    return true;
  }

  /** Takes one note away. False when Lookout cannot. */
  removeNote(id: string, noteId: string): boolean {
    if (!this.records?.removeNote(id, noteId)) return false;
    this.poll();
    return true;
  }

  /** Takes every note on a session away. */
  removeNotes(id: string): boolean {
    if (!this.records) return false;
    this.records.removeNotes(id);
    this.poll();
    return true;
  }

  /** The ids of the sessions with a note. */
  private notedIds(): string[] {
    return this.records ? this.records.noted().map((record) => record.id) : [];
  }

  /** The views with the user's notes on them: the newest, and how many there are. */
  private annotate<T extends { id: string; note?: string; noteCount?: number }>(views: T[]): T[] {
    if (!this.records) return views;
    return views.map((view) => {
      const fields = noteFields(this.records!.notesOf(view.id));
      return fields.note === undefined ? view : { ...view, ...fields };
    });
  }

  /** The records follow the sessions they are about: a title or a branch that changed is written down. A running session's time is not, since it changes with every line its transcript gains. */
  private observeRecords(live: readonly SessionView[], past: readonly PastView[]): void {
    if (!this.records) return;
    for (const view of live) this.records.observe(view.id, seenOf(view, false));
    for (const view of past) this.records.observe(view.id, seenOf(view));
  }

  /** The sessions with a note, as the search sees them: those on the board, and those only a record remembers. */
  private noteCandidates(): NotedSession[] {
    if (!this.records) return [];
    const out: NotedSession[] = [];
    const seen = new Set<string>();
    const take = (id: string, cwd: string, branch: string | undefined) => {
      if (seen.has(id)) return;
      const notes = this.records!.notesOf(id);
      if (notes.length === 0) return;
      seen.add(id);
      out.push({ id, notes, cwd, branch });
    };
    for (const view of this.current) take(view.id, view.cwd, view.branch);
    for (const view of [...this.pastViews, ...this.favouritePast, ...this.archivePast, ...this.notedPast, ...this.purgedPast]) take(view.id, view.cwd, view.branch);
    for (const record of this.records.noted()) take(record.id, record.cwd ?? "", record.branch);
    return out;
  }

  /** The first account's usage numbers, or nothing when there are none to show: none cached, unreadable, or another account's. */
  get usage(): Usage | undefined {
    return usageOf(this.distinctSources()[0]?.source);
  }

  /**
   * The sources whose numbers show, each with the labels of the directories
   * after it signed in to the same account: those show none of their own,
   * and none of them is refreshed. A directory with no sign-in shows its own.
   */
  private distinctSources(): { source: UsageSource; also: string[] }[] {
    const out: { source: UsageSource; also: string[] }[] = [];
    const byAccount = new Map<string, { source: UsageSource; also: string[] }>();
    for (const source of this.sources) {
      const uuid = source.signedIn.read()?.uuid;
      const first = uuid === undefined ? undefined : byAccount.get(uuid);
      if (first) {
        first.also.push(source.dir.label);
        continue;
      }
      const entry = { source, also: [] as string[] };
      if (uuid !== undefined) byAccount.set(uuid, entry);
      out.push(entry);
    }
    return out;
  }

  /**
   * The name the user gave the account of an organization: Claude Code
   * stamps the organization into each transcript, and Lookout learns whose
   * it is when a watched directory is signed in to that account.
   */
  private nameOf(organizationUuid: string): string | undefined {
    if (this.accountNames.size === 0) return undefined;
    const key = this.host.globalState.get<Record<string, string>>(CLAUDE_ORGS_KEY, {})[organizationUuid];
    return key === undefined ? undefined : this.accountNames.get(key);
  }

  /** Learns the organization of the account a directory is signed in to, kept for the machine by a hash of its address. */
  private learnAccount(source: UsageSource): void {
    const who = source.signedIn.read();
    if (!who?.organizationUuid || !who.email) return;
    const known = this.host.globalState.get<Record<string, string>>(CLAUDE_ORGS_KEY, {});
    const key = emailKey(who.email);
    if (known[who.organizationUuid] === key) return;
    void this.host.globalState.update(CLAUDE_ORGS_KEY, { ...known, [who.organizationUuid]: key });
  }

  /** What a source's group is called: the name of the account it is signed in to, else its directory's label while several are watched. */
  private labelOf(source: UsageSource): string | undefined {
    const org = source.signedIn.read()?.organizationUuid;
    return (org === undefined ? undefined : this.nameOf(org)) ?? source.account;
  }

  /** The source a group's key names; without one, the first account's. */
  private sourceOf(key?: string): UsageSource | undefined {
    return key === undefined ? this.distinctSources()[0]?.source : this.sources.find((source) => source.key === key);
  }

  /** The accounts whose usage shows, each with its group's key: one, without a label, while one directory is watched. */
  get usageAccounts(): { key: string; account?: string }[] {
    return this.distinctSources().map(({ source }) => {
      const account = this.labelOf(source);
      return { key: source.key, ...(account ? { account } : {}) };
    });
  }

  /**
   * Every agent's usage, one group each, and one per Claude account while
   * several directories are watched; every meter tagged with its agent and
   * account. A Claude group is there without numbers too, to say there are
   * none and whether a refresh can fetch them.
   */
  get usageGroups(): UsageGroup[] {
    const now = Date.now();
    const claude = this.distinctSources().map(({ source, also }): UsageGroup => {
      const usage = usageOf(source, now);
      const note = this.noteOf(source);
      const account = this.labelOf(source);
      return {
        agent: CLAUDE_CODE,
        ...(account ? { key: source.key, account } : {}),
        ...(also.length ? { also } : {}),
        fetchedAt: usage?.fetchedAt,
        stale: usage?.stale ?? false,
        meters: (usage?.meters ?? []).map((meter) => ({ ...meter, agent: CLAUDE_CODE, ...(account ? { account } : {}) })),
        canRefresh: this.canRefresh(source),
        ...(note ? { note } : {}),
      };
    });
    // The others' numbers come with their sessions' records; Lookout cannot fetch them anew.
    const others = [...this.agentUsage].map(([agent, snapshot]): UsageGroup => ({ agent, fetchedAt: snapshot.fetchedAt, stale: isStale(snapshot, now), meters: snapshot.meters.map((meter) => ({ ...meter, agent })), canRefresh: false }));
    return this.claudeOn ? [...claude, ...others] : others;
  }

  /** Claude Code is told to make no network calls it can do without, which fetching usage is: in the environment, or in the directory's settings file, asked again each time as it can change. */
  private refreshDisabled(source: UsageSource | undefined): boolean {
    return this.refreshDisabledByEnv || envFlag(source?.settingsEnv.get(NONESSENTIAL_TRAFFIC));
  }

  /** Lookout can ask the agent for fresh numbers for this source. */
  private canRefresh(source: UsageSource): boolean {
    return this.claudeOn && this.usageMode !== "off" && !this.refreshDisabled(source) && this.host.claudeBinary() !== undefined;
  }

  /** Lookout can ask the agent for fresh usage numbers, for one account at least. */
  get canRefreshUsage(): boolean {
    return this.distinctSources().some(({ source }) => this.canRefresh(source));
  }

  /** Epoch ms until which the usage endpoint asked for no more requests from this account, the first without a key; -Infinity when it did not. */
  refreshHeldUntil(key?: string): number {
    const source = this.sourceOf(key);
    return source ? this.ledger.heldUntil(source.scope) : -Infinity;
  }

  /** Why a Claude group has no numbers, when Lookout knows: the usage endpoint asked for a wait, or plan limits do not apply. */
  private noteOf(source: UsageSource): string | undefined {
    if (source.read.snapshot) return undefined;
    const held = this.ledger.heldUntil(source.scope);
    if (held > Date.now()) return `Too many usage checks; next at ${clockTime(held)}`;
    if (source.noPlanLimits) return "No plan limits for this sign-in";
    return undefined;
  }

  /** Names the numbers shown, for the refreshes on file. */
  private ledgerKey(source: UsageSource): string {
    return `${source.scope}-${source.read.snapshot?.fetchedAt ?? "none"}`;
  }

  /** Why Lookout cannot fetch an account's usage numbers, the first's without a key, when it cannot. */
  usageNote(key?: string): string | undefined {
    if (!this.claudeOn) return "Claude Code is turned off (lookout.agents.claude)";
    if (this.refreshDisabled(this.sourceOf(key))) return "refresh disabled by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";
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

  /**
   * Has every index read through the store, which is the index: the indexes
   * keep no messages and read them from it, and read the tool calls and
   * results too while the search keeps them.
   */
  private installReadThrough(): void {
    const store = this.store;
    if (!store) return;
    readThroughStore({ scan: runScan, store: { file: store.file, build: this.build }, messages: (file) => store.messages(file), tools: this.toolOutput });
  }

  /**
   * Keeps the tool output in the search, or stops: off, every tool call and
   * result kept goes at once; on, the conversations are read again for it,
   * in the background, from now on.
   */
  private setToolOutput(on: boolean): void {
    if (on === this.toolOutput) return;
    this.toolOutput = on;
    this.installReadThrough();
    if (!on) {
      try {
        this.store?.dropTools();
      } catch (error) {
        this.log.info(`The tool output kept could not be let go of now: ${String(error)}; each conversation lets go of its own as it is read`);
      }
    }
    // The conversations want reading again: at once, not at the next read-ahead; at the start the first read-ahead comes soon anyway.
    if (this.readAheadAt !== Infinity) this.readAheadAt = Math.min(this.readAheadAt, Date.now());
  }

  /** Starts, or restarts with other settings. */
  start(config: Config): void {
    this.typedQuestions = config.typedQuestions;
    this.parkAfterMs = config.parkAfterMs;
    this.historyKeep = config.historyKeep;
    this.keepOffSince = config.historyKeep ? undefined : (this.keepOffSince ?? Date.now());
    this.keepFavourites = config.keepFavourites;
    this.setToolOutput(config.searchToolOutput);
    this.claudeOn = config.claudeEnabled;
    this.accountNames = config.claudeAccountNames;
    this.remembered.clear();
    this.claudeConfigDir = config.claudeConfigDir;
    this.retentionDays = config.retentionDays;
    // One provider per Claude Code directory, each its own account. The first is the one the Claude Code panel runs;
    // another's sessions resume in a terminal on that directory's sign-in. Their labels show once there are several.
    const accounts = config.claudeDirs.length > 1;
    this.providers = config.claudeEnabled
      ? config.claudeDirs.map(
          (dir, i) =>
            new ClaudeProvider(dir.resolved, this.proc, { ...(accounts ? { account: dir.label } : {}), ...(i > 0 ? { terminalEnv: signInEnv(dir) } : {}), nameOf: (org) => this.nameOf(org) }),
        )
      : [];
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
    // Claude's usage is read from what Claude Code cached in each directory, only while Claude is watched.
    this.sources = config.claudeEnabled ? config.claudeDirs.map((dir) => usageSource(dir, accounts)) : [];
    this.shownSources = "";
    this.usageMode = config.usageRefresh;
    this.usageAlerts = config.usageAlerts;
    this.refreshDisabledByEnv = config.usageRefreshDisabled;
    // The sessions Claude Code's panel archived: its own list, read only while Claude is watched.
    this.archived = new ArchivedSessions(config.claudeEnabled ? stateDbCandidates(this.host.globalStorageDir) : []);
    if (config.claudeEnabled && !this.archived.available) this.log.info("The agent's archived-session list is out of reach; every past session is listed");
    const homes = [...(config.claudeEnabled ? [config.claudeConfigDir] : []), ...(config.codexEnabled ? [config.codexHome] : []), ...(config.copilotEnabled ? [config.copilotHome] : [])];
    // An agent watched in several directories is named once; the next lines list its directories.
    this.log.info(this.providers.length ? `Watching ${[...new Set(this.providers.map((p) => p.label))].join(", ")} (${homes.join(", ")})` : "Watching no agent: every agent is turned off");
    // Several Claude Code directories: which is which, and who each is signed in as, by label only.
    for (const line of describeDirs(config.claudeDirs, this.sources.map((source) => source.signedIn.read()))) this.log.info(line);
    this.watch();
    if (this.background && this.readAheadAt === Infinity) {
      this.readAheadAt = Date.now() + READ_AHEAD_AFTER_MS;
      this.readAheadTimer = setTimeout(() => this.poll(), READ_AHEAD_AFTER_MS);
    }
    this.poll();
    if (this.store || this.vault) {
      if (this.sweepTimer) clearInterval(this.sweepTimer);
      this.sweepTimer = setInterval(() => this.sweepStore(), this.host.sweepMs ?? SWEEP_MS);
      this.sweepStore();
    }
  }

  /** How many agents are watched: none when every agent is turned off. */
  get watching(): number {
    return this.providers.length;
  }

  /** Takes settings that need no restart, and shows their effect at once. */
  configure(config: Config): void {
    this.accountNames = config.claudeAccountNames;
    this.typedQuestions = config.typedQuestions;
    this.parkAfterMs = config.parkAfterMs;
    this.usageMode = config.usageRefresh;
    this.usageAlerts = config.usageAlerts;
    this.refreshDisabledByEnv = config.usageRefreshDisabled;
    const keep = this.historyKeep;
    this.historyKeep = config.historyKeep;
    if (keep !== this.historyKeep) this.keepOffSince = this.historyKeep ? undefined : Date.now();
    this.keepFavourites = config.keepFavourites;
    this.setToolOutput(config.searchToolOutput);
    this.retentionDays = config.retentionDays;
    this.poll();
    if (keep !== this.historyKeep) this.sweepStore();
  }

  /** The window's folders changed: other windows place the sessions VS Code runs in them by its folders, and their settings files can set the retention. */
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
    const stars = new Set(this.favouriteIds());
    // The starred, the archived and the noted sessions are asked for by id besides, wherever they ran.
    const limit = this.earlierLimit;
    const scope = { folders: this.host.workspaceFolders(), all: this.earlierScope === "all", limit, also: [...new Set([...stars, ...archive, ...this.notedIds()])] };
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
    // A starred session whose transcript is gone is listed from the store, as no agent lists it.
    const favouritePast = [...also.filter((view) => stars.has(view.id) && !archived.has(view.id)), ...this.purgedPast.filter((view) => stars.has(view.id) && !archived.has(view.id))];
    // Noted sessions no other list holds: not on the board, but searched and known by name.
    const notedPast = also.filter((view) => !stars.has(view.id) && !archived.has(view.id) && notRestored(view));
    this.earlierCapped = capped || shownPast.length > limit;
    this.earlierNotes = notes;
    // An idle tab or terminal with nothing sent is not worth a card.
    const shown = update.views.filter((view) => !(view.empty && view.state === "idle"));
    const live = this.markKept(this.annotate(sortViews(this.parkViews([...shown, ...restored], Date.now()))));
    this.rememberSessions(live, [...past, ...also]);
    this.noticeVanished(update.views, past);
    this.keepStarred(stars, live);
    const mark = (views: PastView[]) => this.markKept(this.annotate(views));
    this.publish(live, mark(shownPast.slice(0, limit)), mark(favouritePast), mark(archivePast), mark(notedPast), mark(this.purgedPast));
    for (const view of [...this.pastViews, ...this.favouritePast, ...this.archivePast, ...this.notedPast, ...this.purgedPast]) this.pastSeen.set(view.id, view);
    this.observeRecords(live, [...this.pastViews, ...this.favouritePast, ...this.archivePast, ...this.notedPast, ...this.purgedPast]);
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
    if (this.sources.length === 0) return;
    for (const source of this.sources) {
      this.learnAccount(source);
      this.consider(source, source.cache.readWithReason());
    }
    // A directory signed in, out, or to another account: the groups change.
    const distinct = this.distinctSources();
    const shown = JSON.stringify(distinct.map(({ source, also }) => [source.key, this.labelOf(source), also]));
    if (shown !== this.shownSources) {
      this.shownSources = shown;
      this.announceThresholds();
      this.usageChanged.fire(this.usage);
    }
    // One fetch at a time: the first account whose numbers are due.
    if (this.refreshing) return;
    const now = Date.now();
    const due = distinct.find(({ source }) => this.canRefresh(source) && wantsRefresh(this.usageMode, source.read.snapshot, now) && now >= this.nextRefreshAt(false, source.key));
    if (due) void this.refreshUsage(false, due.source.key);
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

  /** Takes a read of a source's cache: newer numbers, or word that there are none to show; never older numbers. */
  private consider(source: UsageSource, read: UsageRead): void {
    const before = source.read;
    const news = read.snapshot ? before.snapshot === undefined || read.snapshot.fetchedAt > before.snapshot.fetchedAt : before.snapshot !== undefined || read.why !== before.why;
    if (news) this.acceptUsage(source, read);
    else if ((usageOf(source)?.stale ?? false) !== source.shownStale || this.noteOf(source) !== source.shownNote) this.fireUsage(source);
  }

  private acceptUsage(source: UsageSource, read: UsageRead): void {
    source.read = read;
    this.announceThresholds();
    this.fireUsage(source);
  }

  /** Tells the UI about a source's numbers; also when they only turned stale, which no new reading announces. */
  private fireUsage(source: UsageSource): void {
    source.shownStale = usageOf(source)?.stale ?? false;
    source.shownNote = this.noteOf(source);
    this.usageChanged.fire(this.usage);
  }

  /** The thresholds the numbers shown reach in windows still running; none from numbers too old to go by. */
  private currentAlerts(): UsageAlert[] {
    if (!this.usageAlerts) return [];
    const now = Date.now();
    const running = (meter: { resetsAt?: number }) => meter.resetsAt === undefined || meter.resetsAt > now;
    const alerts: UsageAlert[] = [];
    // Each Claude account's windows, named for the account while there are several: one set of alerts per account.
    for (const { source } of this.distinctSources()) {
      const usage = usageOf(source, now);
      if (!usage || usage.stale) continue;
      const account = this.labelOf(source);
      alerts.push(...reachedThresholds(usage.meters.filter(running).map((meter) => (account ? { ...meter, account } : meter)), source.scope));
    }
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
   * Has the agent fetch fresh usage numbers for one account, the first
   * without a key: at most once every 180 s on the host, 10 s after any
   * other account's unless the user asks (`manual`), and less often after
   * failures unless the user asks; after the usage endpoint answered 429,
   * not before the wait its Retry-After asks, the user's request neither.
   * The numbers then come from the cache the agent rewrote, with its account
   * check, not from its answer; a refresh that leaves the cache as it was
   * failed. One fetch runs at a time: a call for the same account during a
   * fetch waits for it, one for another account runs after it.
   */
  refreshUsage(manual = false, key?: string): Promise<RefreshOutcome> {
    const source = this.sourceOf(key);
    if (!source) return Promise.resolve("unavailable");
    if (this.refreshing) {
      if (this.refreshing.key === source.key) return this.refreshing.promise;
      return this.refreshing.promise.then(() => this.refreshUsage(manual, source.key));
    }
    const binary = this.host.claudeBinary();
    if (!binary || !this.canRefresh(source)) return Promise.resolve("unavailable");
    const now = Date.now();
    if (now < this.ledger.heldUntil(source.scope)) return Promise.resolve("rate-limited");
    const before = source.read.snapshot?.fetchedAt;
    if (!this.ledger.claim(this.ledgerKey(source), now, manual, source.scope)) return Promise.resolve("too soon");
    const label = this.labelOf(source);
    const named = label ? ` for ${label}` : "";
    const promise: Promise<RefreshOutcome> = refreshUsage({ binary, env: source.env })
      .then((result): RefreshOutcome => {
        this.refreshing = undefined;
        if (this.disposed || !this.sources.includes(source)) return "failed";
        source.noPlanLimits = result.answer?.kind === "no plan limits";
        if (result.retryAfterMs !== undefined) {
          const until = Date.now() + result.retryAfterMs;
          this.ledger.hold(source.scope, until);
          this.log.info(`Usage refresh${named}: the usage endpoint answered 429 (too many requests); no refresh before ${clockTime(until)}, the wait its Retry-After asks`);
        }
        this.consider(source, source.cache.readWithReason());
        const after = source.read.snapshot?.fetchedAt;
        if (after !== undefined && (before === undefined || after > before)) return "fetched";
        if (result.retryAfterMs === undefined) this.log.errorOnce(`${named ? `Usage refresh${named}: ` : ""}${refreshFailure(result)}`);
        this.fireUsage(source);
        if (result.retryAfterMs !== undefined) return "rate-limited";
        return source.noPlanLimits ? "no plan limits" : "failed";
      })
      .finally(() => {
        if (this.refreshing?.promise === promise) this.refreshing = undefined;
      });
    this.refreshing = { key: source.key, promise };
    return promise;
  }

  /** When a refresh of an account's numbers, the first's without a key, may start again, automatic or asked for. */
  nextRefreshAt(manual: boolean, key?: string): number {
    const source = this.sourceOf(key);
    if (!source) return Infinity;
    return Math.max(this.ledger.nextAt(this.ledgerKey(source), manual, source.scope), this.ledger.heldUntil(source.scope));
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
    // `has:note` without words asks for the notes alone: the conversations have nothing to add, nor to be read for.
    const notesOnly = parsed.hasNote === true && parsed.terms.length === 0;
    const limit = page?.hits ?? SEARCH_HITS;
    for (const provider of notesOnly ? [] : this.providers) {
      const left = Math.max(0, SEARCH_BUDGET_MS - (Date.now() - started));
      // From the store where there is one: one query over the conversations it holds.
      const part = this.store && provider.conversations ? searchWithStore(provider.conversations(), parsed, limit, left, page?.snippet, this.background, this.store) : provider.search?.(parsed, limit, left, page?.snippet, this.background);
      if (!part) continue;
      outcome.results.push(...part.results);
      outcome.pending += part.pending;
    }
    // The purged sessions' conversations, from the store alone.
    if (this.store && !notesOnly && this.purgedPast.length > 0) {
      const store = this.store;
      const conversations = this.purgedPast.map((view) => ({ id: view.id, cwd: view.cwd, branch: view.branch, pastModifiedAt: view.modifiedAt, file: store.session(view.id)?.file, index: () => undefined }));
      const part = searchWithStore(conversations, parsed, limit, 0, page?.snippet, undefined, store);
      outcome.results.push(...part.results);
    }
    // The notes count as one more line of their sessions' conversations.
    return this.records ? withNotes(outcome, this.noteCandidates(), parsed, page?.hits ?? SEARCH_HITS, page?.snippet) : outcome;
  }

  /** The conversation of one session, oldest first: from its agent's transcript, or from the store once the transcript is gone. */
  history(id: string): HistoryMessage[] | undefined {
    for (const provider of this.providers) {
      const messages = provider.history?.(id, this.background);
      if (messages) return messages;
    }
    const file = this.store?.session(id)?.file;
    return file ? this.store?.messages(file) : undefined;
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

  private publish(views: SessionView[], past: PastView[], favouritePast: PastView[], archivePast: PastView[], notedPast: PastView[], purgedPast: PastView[]): void {
    const snapshot = JSON.stringify([views, past, this.earlierScope, this.earlierCapped, this.earlierNotes, this.favouriteIds(), favouritePast, archivePast, notedPast, purgedPast]);
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.current = views;
    this.pastViews = past;
    this.favouritePast = favouritePast;
    this.archivePast = archivePast;
    this.notedPast = notedPast;
    this.purgedPast = purgedPast;
    // Looked up by id per search result: a map, not a scan of thousands of sessions per result.
    this.liveById = new Map(views.map((view) => [view.id, view]));
    const byId = new Map<string, PastView>();
    for (const list of [past, favouritePast, archivePast, notedPast, purgedPast]) for (const view of list) if (!byId.has(view.id)) byId.set(view.id, view);
    this.pastById = byId;
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
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.sweepSoon) clearTimeout(this.sweepSoon);
    this.recordsWatch?.dispose();
    this.background?.dispose();
    readThroughStore(undefined);
    this.store?.close();
    // The in-thread reads opened the store too.
    closeStores();
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

/** A purged session as the board shows it: not running, not resumable, its conversation kept. */
function purgedView(session: StoredSession): PastView {
  return { id: session.id, agent: session.agent, title: session.title, ...projectOf(session.cwd), branch: session.branch, cwd: session.cwd, resumable: false, modifiedAt: session.modifiedAt ?? session.purgedAt ?? 0, purged: true };
}

/** What a session is called and where it works, as the board has it, for its record; `withTime`: when its transcript was last written, too. */
/** The note fields of a view: the newest note's text and time, and how many notes there are; none without notes. */
function noteFields(notes: readonly NoteEntry[] | undefined): { note?: string; noteAt?: number; noteCount?: number } {
  const latest = notes?.at(-1);
  if (!latest) return {};
  return { note: latest.text, noteAt: latest.at, noteCount: notes!.length };
}

function seenOf(view: SessionView | PastView, withTime = true): SessionSeen {
  const seen: SessionSeen = { agent: view.agent, title: view.title, cwd: view.cwd };
  if (view.branch !== undefined) seen.branch = view.branch;
  const modifiedAt = "modifiedAt" in view ? view.modifiedAt : view.lastWriteAt;
  if (withTime && modifiedAt !== undefined) seen.modifiedAt = modifiedAt;
  return seen;
}

/** The build of the reading thread's bundle, which saved places must come from; none when it cannot be read. */
function buildOf(script: string): string | undefined {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(script)).digest("hex").slice(0, 20);
  } catch {
    return undefined;
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
