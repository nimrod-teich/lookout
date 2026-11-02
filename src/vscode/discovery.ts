import * as os from "node:os";
import { discoverConfigDirs, keepConfigDirs, type DiscoverSources } from "../core/agents/claude/discover";

/** Where the directories found are kept, so one found once is watched from the start of the next window. */
export const FOUND_DIRS_KEY = "lookout.claudeFoundDirs";

/** How often the processes and the home directory are looked at again. */
export const DISCOVER_EVERY_MS = 60_000;

interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * The Claude Code config directories found on this machine. A directory
 * found stays found while it holds Claude Code's config file, so a session
 * that ended outside the home directory keeps its account on the board.
 */
export class ConfigDiscovery {
  private found: string[];
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly state: Memento,
    private readonly onDidChange: (dirs: readonly string[], added: readonly string[]) => void,
    private readonly sources: DiscoverSources = {},
    /** Off: no process or folder is looked at. */
    private readonly enabled: () => boolean = () => true,
  ) {
    const kept = state.get<unknown>(FOUND_DIRS_KEY);
    const home = sources.home ?? os.homedir();
    this.found = keepConfigDirs(Array.isArray(kept) ? kept.filter((dir): dir is string => typeof dir === "string") : [], home);
  }

  /** The directories found so far, in the order they were found. */
  get dirs(): readonly string[] {
    return this.found;
  }

  /** Looks now, then every minute; `stop` ends it. */
  start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), DISCOVER_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look: those found before that still hold a config file, then the new ones. */
  scan(): Promise<void> {
    this.running ??= this.look().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async look(): Promise<void> {
    if (!this.enabled()) return;
    const home = this.sources.home ?? os.homedir();
    const now = await discoverConfigDirs(this.sources);
    const next = keepConfigDirs([...this.found, ...now], home);
    if (next.length === this.found.length && next.every((dir, i) => dir === this.found[i])) return;
    const added = next.filter((dir) => !this.found.includes(dir));
    this.found = next;
    await this.state.update(FOUND_DIRS_KEY, next);
    this.onDidChange(next, added);
  }
}
