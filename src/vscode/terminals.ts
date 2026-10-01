import * as vscode from "vscode";

/** Keeps the shell pid of every integrated terminal of this window. */
export class Terminals implements vscode.Disposable {
  private readonly byPid = new Map<number, vscode.Terminal>();
  private readonly pidOf = new Map<vscode.Terminal, number>();
  private readonly known = new Set<number>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChange = this.changed.event;

  constructor() {
    this.subscriptions = [
      vscode.window.onDidOpenTerminal((terminal) => void this.track(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => this.untrack(terminal)),
    ];
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

  /** Brings the terminal with this shell pid to the front and focuses it. */
  show(pid: number): boolean {
    const terminal = this.byPid.get(pid);
    if (!terminal) return false;
    terminal.show(false);
    return true;
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
