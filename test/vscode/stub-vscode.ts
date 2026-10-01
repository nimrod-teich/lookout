// A stand-in for the `vscode` module that records what the extension does to
// the UI. vitest.config.ts aliases `vscode` to this file.

export type Op = [target: string, action: string, value?: unknown];

interface StubTab {
  label: string;
  input: unknown;
  group: StubGroup;
}

interface StubGroup {
  viewColumn: number;
  tabs: StubTab[];
  activeTab?: StubTab;
}

export interface StubTerminal {
  name: string;
  processId: Promise<number | undefined>;
  exitStatus: undefined | { code: number };
  show(preserveFocus?: boolean): void;
}

export class EventEmitter<T> {
  private listeners: ((value: T) => void)[] = [];
  event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => void (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const stub = {
  ops: [] as Op[],
  config: {} as Record<string, unknown>,
  /** Commands the fake workbench knows; anything else rejects like VS Code does. */
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  groups: [] as StubGroup[],
  activeGroup: undefined as StubGroup | undefined,
  terminals: [] as StubTerminal[],
  activeTerminal: undefined as StubTerminal | undefined,
  focused: true,
  quickPick: undefined as ((items: readonly unknown[]) => unknown) | undefined,
  /** What the user presses on the next notification. */
  notificationAnswer: undefined as string | undefined,
  openTerminal: new EventEmitter<StubTerminal>(),
  closeTerminal: new EventEmitter<StubTerminal>(),
  /** Fired for any change of the front tab, the active terminal, or window focus. */
  focusChange: new EventEmitter<void>(),
  reset(): void {
    this.ops.length = 0;
    this.config = {};
    this.commands.clear();
    this.groups = [];
    this.activeGroup = undefined;
    this.terminals = [];
    this.activeTerminal = undefined;
    this.focused = true;
    this.quickPick = undefined;
    this.notificationAnswer = undefined;
    this.openTerminal.dispose();
    this.closeTerminal.dispose();
    this.focusChange.dispose();
  },
  /** Adds an editor group whose tabs are Claude Code panels with these labels. */
  addClaudeGroup(labels: string[]): StubGroup {
    const group: StubGroup = { viewColumn: this.groups.length + 1, tabs: [] };
    group.tabs = labels.map((label) => ({ label, input: new TabInputWebview("mainThreadWebview-claudeVSCodePanel"), group }));
    this.groups.push(group);
    return group;
  },
  /** Makes a tab the one in front. */
  activate(tab: StubTab): void {
    tab.group.activeTab = tab;
    this.activeGroup = tab.group;
  },
  addTerminal(name: string, pid: number | undefined): StubTerminal {
    const terminal: StubTerminal = {
      name,
      processId: Promise.resolve(pid),
      exitStatus: undefined,
      show: (preserveFocus) => void this.ops.push([`terminal:${name}`, "show", preserveFocus]),
    };
    this.terminals.push(terminal);
    return terminal;
  },
};

export class MarkdownString {
  constructor(
    public value = "",
    public supportThemeIcons = false,
  ) {}
  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
  appendText(text: string): this {
    this.value += text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
    return this;
  }
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class TabInputWebview {
  constructor(public viewType: string) {}
}

export const StatusBarAlignment = { Left: 1, Right: 2 };

function recorded<T extends object>(target: string, props: string[], methods: string[]): T {
  const values: Record<string, unknown> = {};
  const obj: Record<string, unknown> = {};
  for (const prop of props) {
    Object.defineProperty(obj, prop, {
      get: () => values[prop],
      set: (value: unknown) => {
        values[prop] = value;
        stub.ops.push([target, `set:${prop}`, value]);
      },
    });
  }
  for (const method of methods) obj[method] = () => void stub.ops.push([target, method]);
  return obj as T;
}

function notify(kind: string) {
  return (message: string, ...actions: string[]) => {
    stub.ops.push(["window", kind, message]);
    const answer = stub.notificationAnswer;
    return Promise.resolve(answer !== undefined && actions.includes(answer) ? answer : undefined);
  };
}

export const window = {
  createStatusBarItem: (id: string) =>
    recorded(`statusBar:${id}`, ["text", "tooltip", "backgroundColor", "name", "command", "accessibilityInformation"], ["show", "hide", "dispose"]),
  createOutputChannel: (name: string) => ({
    appendLine: (line: string) => void stub.ops.push([`output:${name}`, "appendLine", line]),
    dispose: () => {},
  }),
  showInformationMessage: notify("info"),
  showWarningMessage: notify("warning"),
  showQuickPick: (items: readonly unknown[]) => Promise.resolve(stub.quickPick?.(items)),
  tabGroups: {
    get all() {
      return stub.groups;
    },
    get activeTabGroup() {
      return stub.activeGroup;
    },
    onDidChangeTabs: stub.focusChange.event,
    onDidChangeTabGroups: stub.focusChange.event,
  },
  get terminals() {
    return stub.terminals;
  },
  get activeTerminal() {
    return stub.activeTerminal;
  },
  get state() {
    return { focused: stub.focused };
  },
  onDidOpenTerminal: stub.openTerminal.event,
  onDidCloseTerminal: stub.closeTerminal.event,
  onDidChangeActiveTerminal: stub.focusChange.event,
  onDidChangeWindowState: stub.focusChange.event,
};

export const commands = {
  executeCommand: (command: string, ...args: unknown[]) => {
    stub.ops.push(["commands", command, args]);
    const handler = stub.commands.get(command);
    if (!handler) return Promise.reject(new Error(`command '${command}' not found`));
    try {
      return Promise.resolve(handler(...args));
    } catch (err) {
      return Promise.reject(err);
    }
  },
  registerCommand: (command: string, handler: (...args: unknown[]) => unknown) => {
    stub.commands.set(command, handler);
    return { dispose: () => void stub.commands.delete(command) };
  },
};

export const workspace = {
  getConfiguration: (section: string) => ({
    get: (key: string, fallback?: unknown) => stub.config[`${section}.${key}`] ?? fallback,
  }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
};
