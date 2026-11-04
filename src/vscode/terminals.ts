import * as vscode from "vscode";
import { Presence, type Place } from "../core/presence";

/** Keeps the shell pid of every integrated terminal of this window, and whether the user is in one. */
export class Terminals implements vscode.Disposable {
  private readonly byPid = new Map<number, vscode.Terminal>();
  private readonly presence = new Presence();
  /** The tab in front at the last change of tabs. */
  private frontTab: vscode.Tab | undefined;
  private readonly pidOf = new Map<vscode.Terminal, number>();
  private readonly known = new Set<number>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly moved = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChange = this.changed.event;
  /** The user went into a terminal or out of the terminals, as far as known. A prompt the controller notes, while it reads the sessions, does not fire it. */
  readonly onDidMove = this.moved.event;

  constructor() {
    this.subscriptions = [
      vscode.window.onDidOpenTerminal((terminal) => void this.track(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => this.untrack(terminal)),
      vscode.window.onDidChangeActiveTerminal((terminal) => this.cameForward(terminal)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.tabsChanged()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.tabsChanged()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        // Typing or clicking in an editor; a selection an extension sets has no such kind.
        if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard || event.kind === vscode.TextEditorSelectionChangeKind.Mouse) this.see("elsewhere", Date.now());
      }),
    ];
    this.frontTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    for (const terminal of vscode.window.terminals) void this.track(terminal);
  }

  /** Shell pids of the open terminals. */
  get pids(): ReadonlySet<number> {
    return this.known;
  }

  /** Shell pid of the terminal that is in front, when there is one. */
  activePid(): number | undefined {
    const active = vscode.window.activeTerminal;
    return active ? this.pidOf.get(active) : undefined;
  }

  /**
   * The user is in the terminal with this shell pid, as far as known: they
   * brought it forward, or sent its session a prompt, and went to no tab or
   * editor since. VS Code's active terminal stays active while they work elsewhere.
   */
  userIn(pid: number): boolean {
    return this.presence.inTerminal(pid);
  }

  /**
   * Shell pid of the terminal the user is in: the active one, which they
   * brought forward or sent a prompt in and did not leave since. Undefined
   * while they are in a tab, an editor or another panel, or nothing is known yet.
   */
  userTerminal(): number | undefined {
    const place = this.presence.where();
    return typeof place === "number" && place === this.activePid() ? place : undefined;
  }

  /** The user went to a tab or an editor, as a jump to a session's tab takes them, though no tab may have changed. */
  wentElsewhere(): void {
    this.see("elsewhere", Date.now());
  }

  /** A session was sent a prompt at `at`, in the terminal with this shell pid or, for "elsewhere", outside the terminals. */
  sawPrompt(place: Place, at: number): void {
    this.presence.saw(place, at);
  }

  /** Brings the terminal with this shell pid to the front and focuses it. */
  show(pid: number): boolean {
    const terminal = this.byPid.get(pid);
    if (!terminal) return false;
    terminal.show(false);
    this.see(pid, Date.now());
    return true;
  }

  /**
   * Types `text` into the terminal with this shell pid, as keys, without
   * Enter and without bringing it forward. Returns whether the terminal is open.
   */
  send(pid: number, text: string): boolean {
    const terminal = this.byPid.get(pid);
    if (!terminal || terminal.exitStatus !== undefined) return false;
    terminal.sendText(text, false);
    return true;
  }

  private cameForward(terminal: vscode.Terminal | undefined): void {
    if (!terminal) return;
    const at = Date.now();
    const pid = this.pidOf.get(terminal);
    if (pid !== undefined) this.see(pid, at);
    else void terminal.processId.then((id) => id !== undefined && this.see(id, at));
  }

  /** The user was at `place`: fires `onDidMove` when that is somewhere new. */
  private see(place: Place, at: number): void {
    const before = this.presence.where();
    this.presence.saw(place, at);
    if (this.presence.where() !== before) this.moved.fire();
  }

  /** Another tab came to the front: the user went to it, unless it holds a terminal. */
  private tabsChanged(): void {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (tab === this.frontTab) return;
    this.frontTab = tab;
    if (!tab) return;
    if (tab.input instanceof vscode.TabInputTerminal) {
      const pid = this.activePid();
      if (pid !== undefined) this.see(pid, Date.now());
      return;
    }
    this.see("elsewhere", Date.now());
  }

  private async track(terminal: vscode.Terminal): Promise<void> {
    const pid = await terminal.processId;
    if (pid === undefined || terminal.exitStatus !== undefined) return;
    this.byPid.set(pid, terminal);
    this.pidOf.set(terminal, pid);
    this.known.add(pid);
    this.changed.fire();
  }

  private untrack(terminal: vscode.Terminal): void {
    const pid = this.pidOf.get(terminal);
    if (pid === undefined) return;
    this.pidOf.delete(terminal);
    this.byPid.delete(pid);
    this.known.delete(pid);
    this.changed.fire();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
    this.moved.dispose();
  }
}
