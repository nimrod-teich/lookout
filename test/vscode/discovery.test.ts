import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigDiscovery, FOUND_DIRS_KEY } from "../../src/vscode/discovery";
import { tempConfigDir } from "../core/helpers";

class Memento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

/** A config directory Claude Code has run in. */
function configDir(): string {
  const dir = tempConfigDir();
  fs.writeFileSync(path.join(dir, ".claude.json"), "{}");
  return dir;
}

describe("ConfigDiscovery", () => {
  it("keeps a directory found while it holds Claude Code's config file, and says what each look added", async () => {
    // A home directory with no config directory in it.
    const home = tempConfigDir();
    const a = configDir();
    const b = configDir();
    let running = [a];
    const changes: [readonly string[], readonly string[]][] = [];
    const state = new Memento();
    const discovery = new ConfigDiscovery(state, (dirs, added) => changes.push([dirs, added]), { home, processDirs: async () => running });

    await discovery.scan();
    expect(discovery.dirs).toEqual([a]);
    expect(state.get(FOUND_DIRS_KEY)).toEqual([a]);

    // The process that named it ended: the directory stays.
    running = [b];
    await discovery.scan();
    expect(discovery.dirs).toEqual([a, b]);

    // Nothing new: no change to tell.
    await discovery.scan();
    expect(changes).toEqual([
      [[a], [a]],
      [[a, b], [b]],
    ]);

    // Its config file is gone: so is the directory.
    fs.rmSync(path.join(a, ".claude.json"));
    await discovery.scan();
    expect(discovery.dirs).toEqual([b]);
    expect(changes.at(-1)).toEqual([[b], []]);
  });

  it("starts from the directories kept, those that still hold a config file", () => {
    const a = configDir();
    const gone = tempConfigDir();
    const state = new Memento();
    state.values.set(FOUND_DIRS_KEY, [a, gone, 42]);
    expect(new ConfigDiscovery(state, () => {}, { home: tempConfigDir(), processDirs: async () => [] }).dirs).toEqual([a]);
  });

  it("looks at no process while it is off", async () => {
    let asked = 0;
    const discovery = new ConfigDiscovery(
      new Memento(),
      () => {},
      {
        home: tempConfigDir(),
        processDirs: async () => {
          asked++;
          return [configDir()];
        },
      },
      () => false,
    );
    await discovery.scan();
    expect(asked).toBe(0);
    expect(discovery.dirs).toEqual([]);
  });
});
