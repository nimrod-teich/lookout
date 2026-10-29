import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { labelOf, resolveConfigDirs, sameDirs, type ClaudeDir, type ConfigDirSources } from "../../../../src/core/agents/claude/paths";
import { tempConfigDir } from "../../helpers";

const home = path.resolve("/home/u");
const standard = path.join(home, ".claude");

/** The directories' labels and spellings, in order. */
function listed(extra: unknown, more: ConfigDirSources = {}): [string, string][] {
  return resolveConfigDirs({ home, env: {}, extra, ...more }).map((dir) => [dir.label, dir.dir]);
}

describe("resolveConfigDirs", () => {
  it("watches ~/.claude alone by default, as the default directory", () => {
    expect(resolveConfigDirs({ home, env: {} })).toEqual([{ dir: standard, resolved: standard, label: "default", isDefault: true }]);
  });

  it("takes the primary from the setting, then the Claude Code extension's CLAUDE_CONFIG_DIR, then the environment's", () => {
    const env = { CLAUDE_CONFIG_DIR: "/env/claude-env" };
    expect(listed([], { setting: "~/.claude-work", claudeExtensionEnv: "/ext/claude-ext", env })).toEqual([["work", path.join(home, ".claude-work")]]);
    expect(listed([], { setting: "  ", claudeExtensionEnv: "/ext/claude-ext", env })).toEqual([["ext", "/ext/claude-ext"]]);
    expect(listed([], { env })).toEqual([["env", "/env/claude-env"]]);
  });

  it("keeps a directory's spelling, which names its stored sign-in, and resolves it apart", () => {
    const [dir] = resolveConfigDirs({ home, env: {}, setting: "~/.claude-work/" });
    expect(dir).toEqual({ dir: path.join(home, ".claude-work") + path.sep, resolved: path.join(home, ".claude-work"), label: "work", isDefault: false });
    expect(resolveConfigDirs({ home, env: {}, setting: `${standard}${path.sep}` })[0]).toMatchObject({ label: "default", isDefault: true });
  });

  it("adds the listed directories in order, each a path or label=path, ~ expanded", () => {
    expect(listed(["personal=~/.claude-personal", "~/claude_side", "/srv/claude-team", "/data/a=b"])).toEqual([
      ["default", standard],
      ["personal", path.join(home, ".claude-personal")],
      ["side", path.join(home, "claude_side")],
      ["team", "/srv/claude-team"],
      ["a=b", "/data/a=b"],
    ]);
    expect(resolveConfigDirs({ home, env: {}, extra: ["work.2=~/w"] })[1]).toMatchObject({ label: "work.2", resolved: path.join(home, "w"), isDefault: false });
  });

  it("makes a relative path absolute", () => {
    expect(listed(["rel/.claude-r"])[1]).toEqual(["r", path.resolve("rel/.claude-r")]);
  });

  it("lists a directory once, however it is spelled; a later spelling only names one that has no name", () => {
    expect(listed(["~/.claude-personal", "~/.claude-personal/", "x=~/.claude-personal"])).toEqual([
      ["default", standard],
      ["x", path.join(home, ".claude-personal")],
    ]);
    expect(listed(["a=~/.claude-personal", "b=~/.claude-personal"])).toEqual([
      ["default", standard],
      ["a", path.join(home, ".claude-personal")],
    ]);
  });

  it("lets a listed primary name it, and drops one with no name", () => {
    expect(listed(["firma=~/.claude", "~/.claude-personal"])).toEqual([
      ["firma", standard],
      ["personal", path.join(home, ".claude-personal")],
    ]);
    expect(listed(["~/.claude"])).toEqual([["default", standard]]);
  });

  it("keeps labels unique: names given first, then names from the directories, numbered", () => {
    expect(listed(["~/a/.claude-dev", "~/b/.claude-dev", "dev=~/c"]).map(([label]) => label)).toEqual(["default", "dev-2", "dev-3", "dev"]);
    expect(listed(["x=~/p", "x=~/q"]).map(([label]) => label)).toEqual(["default", "x", "q"]);
    expect(listed(["default=~/.claude-other"]).map(([label]) => label)).toEqual(["default-2", "default"]);
  });

  it("ignores entries that are not paths", () => {
    expect(listed([42, "", "   ", null, { dir: "~/x" }])).toEqual([["default", standard]]);
    expect(listed("~/.claude-personal")).toEqual([["default", standard]]);
  });

  it("tells directories apart by case only where the file system does", () => {
    const extra = ["~/.Claude-Personal", "~/.claude-personal"];
    expect(listed(extra, { platform: "darwin" })).toHaveLength(2);
    expect(listed(extra, { platform: "win32" })).toHaveLength(2);
    expect(listed(extra, { platform: "linux" })).toHaveLength(3);
  });

  it("lists a directory reached through a link once", () => {
    const real = tempConfigDir();
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lookout-link-")), ".claude-linked");
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    fs.symlinkSync(real, link, "junction");
    try {
      expect(resolveConfigDirs({ home, env: {}, extra: [real, link] }).map((dir) => dir.dir)).toEqual([standard, real]);
    } finally {
      fs.rmSync(path.dirname(link), { recursive: true, force: true });
    }
  });
});

describe("labelOf", () => {
  it("names a directory after itself, less a leading .claude- or .claude_", () => {
    expect(labelOf(standard, home)).toBe("default");
    expect(labelOf("/x/.claude-personal", home)).toBe("personal");
    expect(labelOf("/x/.claude_work", home)).toBe("work");
    expect(labelOf("/x/claude-team", home)).toBe("team");
    expect(labelOf("/srv/.claude", home)).toBe("claude");
    expect(labelOf("/x/.claude-", home)).toBe("claude");
    expect(labelOf("/x/My Claude", home)).toBe("My-Claude");
  });
});

describe("sameDirs", () => {
  const dirs: ClaudeDir[] = resolveConfigDirs({ home, env: {}, extra: ["personal=~/.claude-personal"] });

  it("says whether the directories, their spelling or their labels changed", () => {
    expect(sameDirs(dirs, resolveConfigDirs({ home, env: {}, extra: ["personal=~/.claude-personal"] }))).toBe(true);
    expect(sameDirs(dirs, resolveConfigDirs({ home, env: {}, extra: ["private=~/.claude-personal"] }))).toBe(false);
    expect(sameDirs(dirs, resolveConfigDirs({ home, env: {}, extra: ["personal=~/.claude-personal/"] }))).toBe(false);
    expect(sameDirs(dirs, resolveConfigDirs({ home, env: {} }))).toBe(false);
  });
});
