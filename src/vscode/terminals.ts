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
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChange = this.changed.event;

  constructor() {
    this.subscriptions = [
      vscode.window.onDidOpenTerminal((terminal) => void this.track(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => this.untrack(terminal)),
      vscode.window.onDidChangeActiveTerminal((terminal) => this.cameForward(terminal)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.tabsChanged()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.tabsChanged()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        // Typing or clicking in an editor; a selection an extension sets has no such kind.
        if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard || event.kind === vscode.TextEditorSelectionChangeKind.Mouse) this.presence.saw("elsewhere", Date.now());
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

  /** A session was sent a prompt at `at`, in the terminal with this shell pid or, for "elsewhere", outside the terminals. */
  sawPrompt(place: Place, at: number): void {
    this.presence.saw(place, at);
  }

  /** Brings the terminal with this shell pid to the front and focuses it. */
  show(pid: number): boolean {
    const terminal = this.byPid.get(pid);
    if (!terminal) return false;
    terminal.show(false);
    this.presence.saw(pid, Date.now());
    return true;
  }

  private cameForward(terminal: vscode.Terminal | undefined): void {
    if (!terminal) return;
    const at = Date.now();
    const pid = this.pidOf.get(terminal);
    if (pid !== undefined) this.presence.saw(pid, at);
    else void terminal.processId.then((id) => id !== undefined && this.presence.saw(id, at));
  }

  /** Another tab came to the front: the user went to it, unless it holds a terminal. */
  private tabsChanged(): void {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (tab === this.frontTab) return;
    this.frontTab = tab;
    if (!tab) return;
    if (tab.input instanceof vscode.TabInputTerminal) {
      const pid = this.activePid();
      if (pid !== undefined) this.presence.saw(pid, Date.now());
      return;
    }
    this.presence.saw("elsewhere", Date.now());
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
  }
}
