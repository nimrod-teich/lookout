import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configDirInEnviron,
  configDirsInPs,
  discoverConfigDirs,
  homeConfigDirs,
  isConfigDir,
  keepConfigDirs,
  linuxProcessDirs,
} from "../../../../src/core/agents/claude/discover";
import { tempConfigDir } from "../../helpers";

/** A home directory with the default config directory and the folders named. */
function homeWith(...dirs: string[]): string {
  const home = tempConfigDir();
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude.json"), "{}");
  for (const dir of dirs) fs.mkdirSync(path.join(home, dir));
  return home;
}

/** Claude Code's config file in `dir`, as a run of Claude Code with that directory leaves it. */
function signIn(dir: string): string {
  fs.writeFileSync(path.join(dir, ".claude.json"), "{}");
  return dir;
}

describe("isConfigDir", () => {
  it("counts a directory with Claude Code's config file in it, and ~/.claude by ~/.claude.json beside it", () => {
    const home = homeWith(".claude-personal", ".claude-empty");
    signIn(path.join(home, ".claude-personal"));
    expect(isConfigDir(path.join(home, ".claude"), home)).toBe(true);
    expect(isConfigDir(path.join(home, ".claude-personal"), home)).toBe(true);
    expect(isConfigDir(path.join(home, ".claude-empty"), home)).toBe(false);
    expect(isConfigDir(path.join(home, "missing"), home)).toBe(false);
    fs.rmSync(path.join(home, ".claude.json"));
    expect(isConfigDir(path.join(home, ".claude"), home)).toBe(false);
  });
});

describe("homeConfigDirs", () => {
  it("finds ~/.claude and the home directory's .claude-<name> and .claude_<name> folders that Claude Code has run in", () => {
    const home = homeWith(".claude-work", ".claude_side", ".claude-backup", "claude-plain", ".clauderc.d");
    signIn(path.join(home, ".claude-work"));
    signIn(path.join(home, ".claude_side"));
    signIn(path.join(home, "claude-plain"));
    signIn(path.join(home, ".clauderc.d"));
    expect(homeConfigDirs(home)).toEqual([path.join(home, ".claude"), path.join(home, ".claude-work"), path.join(home, ".claude_side")]);
  });

  it("finds nothing in a home directory it cannot read", () => {
    expect(homeConfigDirs(path.join(tempConfigDir(), "missing"))).toEqual([]);
  });
});

describe("configDirInEnviron", () => {
  it("reads CLAUDE_CONFIG_DIR from a /proc environ, as written", () => {
    expect(configDirInEnviron("PATH=/usr/bin\0CLAUDE_CONFIG_DIR=/home/u/.claude-personal/\0HOME=/home/u\0")).toBe("/home/u/.claude-personal/");
    expect(configDirInEnviron("XCLAUDE_CONFIG_DIR=/x\0CLAUDE_CONFIG_DIR=\0")).toBeUndefined();
    expect(configDirInEnviron("PATH=/usr/bin\0")).toBeUndefined();
  });
});

describe("configDirsInPs", () => {
  it("reads CLAUDE_CONFIG_DIR from ps -E lines, each to the next space", () => {
    const text = [
      "claude --resume abc TERM=xterm CLAUDE_CONFIG_DIR=/Users/u/.claude-personal HOME=/Users/u",
      "/bin/zsh -l HOME=/Users/u",
      "node app.js XCLAUDE_CONFIG_DIR=/nope",
      "CLAUDE_CONFIG_DIR=/Users/u/.claude-work claude",
    ].join("\n");
    expect(configDirsInPs(text)).toEqual(["/Users/u/.claude-personal", "/Users/u/.claude-work"]);
  });
});

describe("linuxProcessDirs", () => {
  it("reads every process's environ it may, and passes over the rest", async () => {
    const root = tempConfigDir();
    const proc = (pid: string, environ?: string) => {
      fs.mkdirSync(path.join(root, pid));
      if (environ !== undefined) fs.writeFileSync(path.join(root, pid, "environ"), environ);
    };
    proc("10", "CLAUDE_CONFIG_DIR=/home/u/.claude-personal\0");
    proc("11", "HOME=/home/u\0");
    // Another user's: no environ to read.
    proc("12");
    proc("self", "CLAUDE_CONFIG_DIR=/not/a/pid\0");
    expect(await linuxProcessDirs(root)).toEqual(["/home/u/.claude-personal"]);
    expect(await linuxProcessDirs(path.join(root, "missing"))).toEqual([]);
  });
});

describe("discoverConfigDirs", () => {
  it("puts the processes' directories first, as they spelled them, then the home directory's, each once", async () => {
    const home = homeWith(".claude-personal");
    signIn(path.join(home, ".claude-personal"));
    const elsewhere = signIn(tempConfigDir());
    const notRun = tempConfigDir();
    const found = await discoverConfigDirs({
      home,
      processDirs: async () => [`${path.join(home, ".claude-personal")}${path.sep}`, elsewhere, notRun, "relative/.claude-x", elsewhere],
    });
    expect(found).toEqual([`${path.join(home, ".claude-personal")}${path.sep}`, elsewhere, path.join(home, ".claude")]);
  });

  it("still finds the home directory's when the process list fails", async () => {
    const home = homeWith();
    expect(await discoverConfigDirs({ home, processDirs: () => Promise.reject(new Error("ps failed")) })).toEqual([path.join(home, ".claude")]);
  });
});

describe("keepConfigDirs", () => {
  it("keeps the config directories, each by its first spelling", () => {
    const home = homeWith();
    const a = signIn(tempConfigDir());
    const gone = path.join(tempConfigDir(), "gone");
    expect(keepConfigDirs([a, `${a}${path.sep}`, gone, path.join(home, ".claude")], home)).toEqual([a, path.join(home, ".claude")]);
  });
});
