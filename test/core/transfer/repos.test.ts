import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { describeRepos, findLocalRepos, readRepoRecords, remoteKey, remoteUrls, repoAt, repoMappings, type LocalRepo, type RepoRecord } from "../../../src/core/transfer/repos";
import { suggestMapping } from "../../../src/core/transfer/restore";
import type { BundleManifest } from "../../../src/core/transfer/types";
import { linkWorktree, tempConfigDir } from "../helpers";

/** A clone at `dir` with these remotes, as git writes its config. */
function clone(dir: string, ...urls: string[]): string {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  const remotes = urls.map((url, i) => `[remote "${i === 0 ? "origin" : `r${i}`}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`).join("");
  fs.writeFileSync(path.join(dir, ".git", "config"), `[core]\n\tbare = false\n${remotes}[branch "main"]\n\tremote = origin\n`);
  return dir;
}

const root = () => fs.realpathSync.native(tempConfigDir());

describe("remoteKey", () => {
  it("reduces every spelling of a remote to its path, lowercased, without .git", () => {
    for (const url of [
      "git@github.com:Magma-Devs/smart-router.git",
      "git@github-work:Magma-Devs/smart-router.git",
      "ssh://git@github.com/Magma-Devs/smart-router",
      "ssh://git@github.com:22/Magma-Devs/smart-router.git/",
      "https://github.com/Magma-Devs/smart-router.git",
      "https://x-access-token:ghs_secret@github.com/magma-devs/Smart-Router",
      "git+ssh://git@github.com/Magma-Devs/smart-router.git",
    ]) {
      expect(remoteKey(url), url).toBe("magma-devs/smart-router");
    }
    expect(remoteKey("https://gitlab.example.com/group/sub/repo.git")).toBe("group/sub/repo");
  });

  it("keeps no part of a token, and matches nothing for a local path or a URL with no owner", () => {
    expect(remoteKey("https://user:ghp_token@github.com/o/r")).not.toContain("ghp_token");
    expect(remoteKey("/srv/git/repo.git")).toBeUndefined();
    expect(remoteKey("../other")).toBeUndefined();
    expect(remoteKey("file:///srv/git/repo.git")).toBeUndefined();
    expect(remoteKey("https://github.com/")).toBeUndefined();
    expect(remoteKey("https://github.com/solo")).toBeUndefined();
    expect(remoteKey("https://github.com/o/../r")).toBeUndefined();
    expect(remoteKey("not a url")).toBeUndefined();
  });
});

describe("remoteUrls", () => {
  it("reads url and pushurl of every remote section, and nothing of the others", () => {
    const config = '[core]\n\turl = nope\n[remote "origin"]\n\turl = git@h:o/a.git\n\tpushurl = "git@h:o/b.git"\n[branch "main"]\n\turl = nope2\n[Remote "up"]\n  URL = https://h/o/c\n';
    expect(remoteUrls(config)).toEqual(["git@h:o/a.git", "git@h:o/b.git", "https://h/o/c"]);
  });
});

describe("repoAt", () => {
  it("finds the repository a folder is in, its remotes, and whether it is a linked worktree", () => {
    const dir = root();
    const repo = clone(path.join(dir, "app"), "git@github.com:o/app.git", "https://github.com/up/app");
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    expect(repoAt(path.join(repo, "src", "deep"))).toEqual({ root: repo, linked: false, remotes: ["o/app", "up/app"] });
    const wt = path.join(dir, "app-wt");
    linkWorktree(repo, wt);
    expect(repoAt(wt)).toEqual({ root: wt, linked: true, remotes: ["o/app", "up/app"], main: repo });
    expect(repoAt(path.join(dir, "nowhere"))).toBeUndefined();
  });

  it("names no main checkout for a worktree of a bare repository", () => {
    const dir = root();
    const bare = path.join(dir, "app.git");
    const own = path.join(bare, "worktrees", "wt");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(bare, "config"), '[core]\n\tbare = true\n[remote "origin"]\n\turl = git@h:o/app.git\n');
    fs.writeFileSync(path.join(own, "commondir"), "../..\n");
    const wt = path.join(dir, "wt");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${own}\n`);
    expect(repoAt(wt)).toEqual({ root: wt, linked: true, remotes: ["o/app"] });
  });

  it("reads a .git file that names its folder without a commondir as the repository's own", () => {
    const dir = root();
    const modules = clone(path.join(dir, "store", "mod"), "git@h:o/mod.git");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", ".git"), `gitdir: ${path.join(modules, ".git")}\n`);
    expect(repoAt(path.join(dir, "sub"))).toEqual({ root: path.join(dir, "sub"), linked: false, remotes: ["o/mod"] });
  });
});

describe("describeRepos", () => {
  it("records each repository once, with remotes only, never a URL", () => {
    const dir = root();
    const repo = clone(path.join(dir, "app"), "https://bot:secret@github.com/o/app.git");
    fs.mkdirSync(path.join(repo, "web"));
    fs.mkdirSync(path.join(dir, "plain"));
    const local = clone(path.join(dir, "local"), "/srv/git/local.git");
    const records = describeRepos([repo, path.join(repo, "web"), path.join(dir, "plain"), local, "", repo]);
    expect(records).toEqual([{ root: repo, linked: false, remotes: ["o/app"] }]);
    expect(JSON.stringify(records)).not.toContain("secret");
  });

  it("records a linked worktree's main checkout with it, though no session worked in the main checkout", () => {
    const dir = root();
    const repo = clone(path.join(dir, "app"), "git@github.com:o/app.git");
    const inside = path.join(repo, ".claude", "worktrees", "feat");
    const beside = path.join(dir, "app-fix");
    linkWorktree(repo, inside);
    linkWorktree(repo, beside);
    const records = describeRepos([inside, beside]);
    expect(records.filter((record) => !record.linked)).toEqual([{ root: repo, linked: false, remotes: ["o/app"] }]);
    expect(records.filter((record) => record.linked).map((record) => record.root).sort()).toEqual([inside, beside].sort());
  });
});

describe("readRepoRecords", () => {
  it("keeps only records in the shape a backup writes", () => {
    const good = { root: "/home/a/app", linked: false, remotes: ["o/app"] };
    expect(
      readRepoRecords([
        good,
        { root: "/x", linked: "no", remotes: ["o/x"] },
        { root: 7, linked: false, remotes: ["o/x"] },
        { root: "/x", linked: false, remotes: ["https://h/o/x", "no-slash", "o/../x", "o/ x", 3] },
        { root: "/x\0y", linked: false, remotes: ["o/x"] },
        null,
        "text",
      ]),
    ).toEqual([good]);
    expect(readRepoRecords("not a list")).toEqual([]);
    expect(readRepoRecords(undefined)).toEqual([]);
  });
});

describe("findLocalRepos", () => {
  it("finds clones of the wanted remotes from the folders given and a few folders under home, leaving hidden and tool folders out", () => {
    const home = root();
    const sri = clone(path.join(home, "code", "sri"), "git@github.com:o/smart-router-infrastructure.git");
    clone(path.join(home, "code", "other"), "git@github.com:o/other.git");
    clone(path.join(home, ".cache", "sri"), "git@github.com:o/smart-router-infrastructure.git");
    clone(path.join(home, "node_modules", "sri"), "git@github.com:o/smart-router-infrastructure.git");
    clone(path.join(home, "a", "b", "c", "too-deep"), "git@github.com:o/smart-router-infrastructure.git");
    const elsewhere = clone(path.join(root(), "far", "away"), "git@github.com:o/smart-router-infrastructure.git");
    const wanted = new Set(["o/smart-router-infrastructure"]);
    const roots = (repos: LocalRepo[]) => repos.map((repo) => repo.root).sort();
    expect(roots(findLocalRepos([], home, wanted))).toEqual([sri]);
    expect(roots(findLocalRepos([path.join(elsewhere, "src")], home, wanted))).toEqual([elsewhere, sri].sort());
    expect(findLocalRepos([elsewhere], home, new Set())).toEqual([]);
  });

  it("looks past a home folder kept in git, and never inside another repository", () => {
    const home = root();
    clone(home, "git@github.com:me/dotfiles.git");
    const app = clone(path.join(home, "projects", "app"), "git@github.com:o/app.git");
    clone(path.join(app, "vendor", "app"), "git@github.com:o/app.git");
    const roots = (wanted: string[]) => findLocalRepos([], home, new Set(wanted)).map((repo) => repo.root).sort();
    expect(roots(["o/app"])).toEqual([app]);
    expect(roots(["me/dotfiles", "o/app"])).toEqual([home, app].sort());
  });

  it("stops after as many folders as it may read", () => {
    const home = root();
    for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(home, `d${i}`));
    clone(path.join(home, "zz", "repo"), "git@h:o/r.git");
    expect(findLocalRepos([], home, new Set(["o/r"]), { maxDirs: 5 })).toEqual([]);
    expect(findLocalRepos([], home, new Set(["o/r"]))).toHaveLength(1);
  });
});

describe("repoMappings", () => {
  const source = (root: string, ...remotes: string[]): RepoRecord => ({ root, linked: false, remotes });
  const local = (root: string, remotes: string[], linked = false): LocalRepo => ({ root, linked, remotes });
  const home = "/Users/me";
  const nowhere = (p: string) => p.replace("/home/old", home);

  it("maps a repository that moved to its one clone here", () => {
    const out = repoMappings([source("/home/old/projects/smart-router-infrastructure", "o/sri")], [local("/Users/me/code/sri", ["o/sri"])], nowhere, home, "linux");
    expect(out).toEqual({ mapping: [{ from: "/home/old/projects/smart-router-infrastructure", to: "/Users/me/code/sri", by: "repo" }], ambiguous: [] });
  });

  it("prefers a main checkout, then the same name, then one under the home folder, and asks when clones are still alike", () => {
    const from = "/home/old/projects/app";
    const pick = (repos: LocalRepo[]) => repoMappings([source(from, "o/app")], repos, nowhere, home, "linux");
    expect(pick([local("/Users/me/wt/app", ["o/app"], true), local("/Users/me/code/main", ["o/app"])]).mapping[0]!.to).toBe("/Users/me/code/main");
    expect(pick([local("/Users/me/code/fork", ["o/app"]), local("/Users/me/x/App", ["o/app"])]).mapping[0]!.to).toBe("/Users/me/x/App");
    expect(pick([local("/opt/app", ["o/app"]), local("/Users/me/src/app", ["o/app"])]).mapping[0]!.to).toBe("/Users/me/src/app");
    expect(pick([local("/Users/me/a/app", ["o/app"]), local("/Users/me/b/app", ["o/app"])])).toEqual({ mapping: [], ambiguous: [{ from, choices: ["/Users/me/a/app", "/Users/me/b/app"] }] });
    // No clone here: nothing to say; the summary lists the folder as not on this machine.
    expect(pick([local("/Users/me/code/other", ["o/other"])])).toEqual({ mapping: [], ambiguous: [] });
  });

  it("leaves a repository the mapping already puts on a clone of it, and a linked worktree, which its main checkout carries", () => {
    const home = root();
    const there = clone(path.join(home, "projects", "app"), "git@h:o/app.git");
    const mapped = (p: string) => p.replace("/home/old", home);
    const elsewhere = local(path.join(home, "other", "app"), ["o/app"]);
    // Another clone found elsewhere does not move it.
    expect(repoMappings([source("/home/old/projects/app", "o/app")], [elsewhere], mapped, home, "linux").mapping).toEqual([]);
    expect(repoAt(there)?.remotes).toEqual(["o/app"]);
    expect(repoMappings([{ root: "/home/old/wt/x", linked: true, remotes: ["o/app"] }], [elsewhere], mapped, home, "linux").mapping).toEqual([]);
    // A folder in the mapped place that is another repository is not the place.
    clone(path.join(home, "projects", "lib"), "git@h:o/something-else.git");
    expect(repoMappings([source("/home/old/projects/lib", "o/lib")], [local(path.join(home, "x", "lib"), ["o/lib"])], mapped, home, "linux").mapping).toEqual([{ from: "/home/old/projects/lib", to: path.join(home, "x", "lib"), by: "repo" }]);
  });

  it("compares a Windows repository's name the Windows way", () => {
    const out = repoMappings([source("C:\\Users\\old\\src\\App", "o/app")], [local("/Users/me/a/other", ["o/app"]), local("/Users/me/b/app", ["o/app"])], () => undefined, home, "win32");
    expect(out.mapping).toEqual([{ from: "C:\\Users\\old\\src\\App", to: "/Users/me/b/app", by: "repo" }]);
  });
});

describe("suggestMapping", () => {
  const manifest = (home: string, repos: RepoRecord[]): BundleManifest =>
    ({ source: { host: "old", platform: "linux", home, wsl: false }, repos }) as unknown as BundleManifest;

  it("adds the moved repositories to the home folder's mapping, and looks for none when every one is in place", () => {
    const home = root();
    const sri = clone(path.join(home, "code", "sri"), "git@github.com:o/smart-router-infrastructure.git");
    clone(path.join(home, "projects", "app"), "git@github.com:o/app.git");
    const repos = [
      { root: "/home/old/projects/smart-router-infrastructure", linked: false, remotes: ["o/smart-router-infrastructure"] },
      { root: "/home/old/projects/app", linked: false, remotes: ["o/app"] },
      { root: "/home/old/projects/app/.claude/worktrees/x", linked: true, remotes: ["o/app"] },
    ];
    expect(suggestMapping(manifest("/home/old", repos), home, [])).toEqual({
      mapping: [
        { from: "/home/old", to: home },
        { from: "/home/old/projects/smart-router-infrastructure", to: sri, by: "repo" },
      ],
      ambiguous: [],
    });
    expect(suggestMapping(manifest("/home/old", [repos[1]!]), home, [])).toEqual({ mapping: [{ from: "/home/old", to: home }], ambiguous: [] });
    // A backup of 0.1.6 records no repositories: the home folder's mapping alone.
    expect(suggestMapping(manifest("/home/old", undefined as unknown as RepoRecord[]), home, [])).toEqual({ mapping: [{ from: "/home/old", to: home }], ambiguous: [] });
  });

  it("finds a moved repository whose sessions all worked in its linked worktrees", () => {
    const old = root();
    const main = clone(path.join(old, "projects", "app"), "git@github.com:o/app.git");
    const worktree = path.join(main, ".claude", "worktrees", "feat");
    linkWorktree(main, worktree);
    const home = root();
    const renamed = clone(path.join(home, "code", "app-renamed"), "git@github.com:o/app.git");
    const source = { ...manifest(old, describeRepos([worktree])), source: { host: "old", platform: process.platform, home: old, wsl: false } } as unknown as BundleManifest;
    expect(suggestMapping(source, home, [])).toEqual({
      mapping: [
        { from: old, to: home },
        { from: main, to: renamed, by: "repo" },
      ],
      ambiguous: [],
    });
  });

  it("maps no repository outside the old home folder, nor the home folder itself, whatever the backup says", () => {
    const home = root();
    clone(path.join(home, "code", "app"), "git@github.com:o/app.git");
    const hostile = [
      { root: "/", linked: false, remotes: ["o/app"] },
      { root: "/opt/app", linked: false, remotes: ["o/app"] },
      { root: "/home/old", linked: false, remotes: ["o/app"] },
      { root: "/home/old/../evil", linked: false, remotes: ["o/app"] },
      { root: "/home/older/app", linked: false, remotes: ["o/app"] },
    ];
    expect(suggestMapping(manifest("/home/old", hostile), home, [])).toEqual({ mapping: [{ from: "/home/old", to: home }], ambiguous: [] });
  });
});
