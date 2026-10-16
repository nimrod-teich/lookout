import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { JumpMailbox, type JumpReply, type JumpRequest } from "../core/jumpMailbox";
import type { Desktop } from "../core/osNotify";
import { raiseSteps, type WindowIdentity } from "../core/raise";
import type { SessionView } from "../core/types";
import type { Log } from "./log";
import { findPowershell, runCapturing, runCommand, type CapturingRunner, type Runner } from "./osNotifier";

/**
 * The timing of a jump through another window. The window that answers acts
 * only on requests younger than REQUEST_FRESH_MS and spends at most
 * RAISE_BUDGET_MS coming forward, so it answers well within REPLY_WAIT_MS,
 * after which the window that asked takes its request back: no window comes
 * forward after the user was told it did not answer.
 */
const REPLY_WAIT_MS = 6_000;
const REQUEST_FRESH_MS = 2_000;
const RAISE_BUDGET_MS = 3_000;
/** How long a raise may take to show in the window's focus state. */
const FOCUS_WAIT_MS = 700;
/** The mailbox is looked at this often besides when its directory changes. */
const CHECK_MS = 1_000;
/** A raise program is not started with less time than this left. */
const MIN_STEP_MS = 300;

/** How a jump to another window's session went. */
export type CrossWindowOutcome = "raised" | "opened" | "not found" | "no answer" | "not sent";

/** Whether this window comes to the front within `ms`. */
function focusWithin(ms: number): Promise<boolean> {
  if (vscode.window.state.focused) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (focused: boolean) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(focused);
    };
    const subscription = vscode.window.onDidChangeWindowState(() => {
      if (vscode.window.state.focused) done(true);
    });
    const timer = setTimeout(() => done(vscode.window.state.focused), ms);
  });
}

export interface RaiseRunners {
  run: Runner;
  capture: CapturingRunner;
}

/**
 * Brings this VS Code window to the front of the desktop within `budgetMs`:
 * VS Code's own focus command first, then the desktop's tools, the window
 * told apart by its title. True when the window ends up in front.
 */
export async function raiseWindow(desktop: Desktop | undefined, identity: WindowIdentity, log: Log, budgetMs: number = RAISE_BUDGET_MS, runners: RaiseRunners = { run: runCommand, capture: runCapturing }): Promise<boolean> {
  if (vscode.window.state.focused) return true;
  const deadline = Date.now() + budgetMs;
  const left = () => deadline - Date.now();
  try {
    await vscode.commands.executeCommand("workbench.action.focusWindow");
  } catch (err) {
    log.info(`Raise with VS Code's focus command failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (await focusWithin(Math.min(FOCUS_WAIT_MS, Math.max(0, left())))) return true;
  if (!desktop) return false;
  for (const step of raiseSteps(desktop, identity, { powershell: findPowershell(desktop) })) {
    if (left() < MIN_STEP_MS) break;
    let command = "run" in step ? step.run : undefined;
    if ("list" in step) {
      const listed = await runners.capture(step.list, left());
      command = listed.ok ? step.pick(listed.output) : undefined;
      if (!command) {
        log.info(`Raise with ${path.win32.basename(step.list.file)}: ${listed.ok ? "no such window" : `failed (${listed.failure})`}`);
        continue;
      }
    }
    if (!command || left() < MIN_STEP_MS) break;
    const result = await runners.run(command, left());
    log.info(`Raise with ${path.win32.basename(command.file)}: ${result.ok ? `done in ${result.ms} ms` : `failed (${result.failure})`}`);
    if (result.ok && (await focusWithin(Math.min(FOCUS_WAIT_MS, Math.max(0, left()))))) return true;
  }
  return vscode.window.state.focused;
}

export interface CrossWindowHost {
  /** Pid of this window's extension host: its address. */
  pid: number;
  /** The directory the windows on this host share. */
  dir: string;
  /** The live session with this id, as this window sees it. */
  find(sessionId: string): SessionView | undefined;
  /** Brings a session hosted in this window to the front: its tab or terminal. */
  reveal(view: SessionView): Promise<boolean>;
  /** Brings this window to the front of the desktop. */
  raise(): Promise<boolean>;
  /** A window's registry record changed: the other windows and their terminals are read again. */
  registryChanged?(): void;
  log: Log;
}

/**
 * Jumps to sessions hosted by the other VS Code windows on this host, and
 * answers theirs: a window asks the one that hosts a session to bring it
 * forward, through a mailbox in the directory they share. The window that
 * answers reveals the session's tab or terminal, comes to the front itself,
 * and says how it went.
 */
export class CrossWindowJumps implements vscode.Disposable {
  private readonly mailbox: JumpMailbox;
  /** The requests this window sent and waits on, by window and session. */
  private readonly waiting = new Map<string, (reply: JumpReply | undefined) => void>();
  /** A jump in progress, by window and session: asking again waits for the same answer. */
  private readonly pending = new Map<string, Promise<CrossWindowOutcome>>();
  private watcher: fs.FSWatcher | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private checking: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly host: CrossWindowHost) {
    this.mailbox = new JumpMailbox(host.dir);
    try {
      fs.mkdirSync(host.dir, { recursive: true });
      this.watcher = fs.watch(host.dir, (_event, name) => {
        if (typeof name === "string" && /^\d+\.json$/.test(name)) host.registryChanged?.();
        void this.check();
      });
      this.watcher.on("error", () => this.watcher?.close());
    } catch {
      // Without a watch the mailbox is still looked at every second.
    }
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    void this.check();
  }

  /** Asks the window that hosts `view` to bring it to the front, and waits for its answer; asking again meanwhile waits for the same one. */
  request(view: SessionView): Promise<CrossWindowOutcome> {
    const to = view.windowPid;
    if (to === undefined || this.disposed) return Promise.resolve("not sent");
    const key = `${to}:${view.id}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const asking = this.ask(to, view.id, key).finally(() => this.pending.delete(key));
    this.pending.set(key, asking);
    return asking;
  }

  private async ask(to: number, sessionId: string, key: string): Promise<CrossWindowOutcome> {
    const letter = this.mailbox.send(to, { sessionId, fromPid: this.host.pid }, Date.now());
    if (letter === undefined) return "not sent";
    // The answer cannot come before this runs: the other window needs at least a look at the directory.
    const answer = await new Promise<JumpReply | undefined>((resolve) => {
      const finish = (reply: JumpReply | undefined) => {
        clearTimeout(timer);
        if (this.waiting.get(key) === finish) this.waiting.delete(key);
        resolve(reply);
      };
      const timer = setTimeout(() => finish(undefined), REPLY_WAIT_MS);
      this.waiting.set(key, finish);
    });
    if (!answer) {
      // Not taken in time: take it back, so that window does not come forward after all.
      this.mailbox.withdraw(letter);
      return "no answer";
    }
    if (!answer.found) return "not found";
    return answer.raised ? "raised" : "opened";
  }

  /** Takes the answers for this window and the requests to it; one look at a time. */
  private check(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.checking) return this.checking;
    const look = async () => {
      const now = Date.now();
      for (const answer of this.mailbox.takeReplies(this.host.pid, now)) this.waiting.get(`${answer.fromPid}:${answer.sessionId}`)?.(answer);
      // A request older than this was sent by a window that gives up on it before this one could answer.
      for (const request of this.mailbox.takeRequests(this.host.pid, now, REQUEST_FRESH_MS)) await this.answer(request);
    };
    // Cleared once the look has settled, never before it is recorded: a look with nothing to do ends at once.
    this.checking = look()
      .catch((err: unknown) => this.host.log.errorOnce(`Cross-window jump: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  private async answer(request: JumpRequest): Promise<void> {
    const view = this.host.find(request.sessionId);
    const here = view !== undefined && (view.host === "panel" || view.host === "terminal");
    const found = here ? await this.host.reveal(view) : false;
    const raised = found ? await this.host.raise() : false;
    this.host.log.info(`Jump asked by window ${request.fromPid}: "${view?.title ?? request.sessionId}" ${found ? (raised ? "shown, window raised" : "shown, window not raised") : "not here"}`);
    if (!this.disposed) this.mailbox.reply(request.fromPid, { sessionId: request.sessionId, fromPid: this.host.pid, found, raised }, Date.now());
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.watcher?.close();
    for (const finish of [...this.waiting.values()]) finish(undefined);
    this.waiting.clear();
  }
}
