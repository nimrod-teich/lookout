import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lowerSettingsFiles, managedRetention, managedSettingsFiles, readRetention, repoRootOf, retentionIn, writeRetention } from "../../../../src/core/agents/claude/retention";

let dir: string;
let configDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-retention-"));
  configDir = path.join(dir, "claude");
  fs.mkdirSync(configDir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

const posix = process.platform !== "win32";

describe("the settings files", () => {
  it("are the managed file and its drop-ins on each platform, then each folder's local files, root first, then the shared ones, then the user's", () => {
    expect(managedSettingsFiles("linux")).toEqual(["/etc/claude-code/managed-settings.json"]);
    expect(managedSettingsFiles("darwin")[0]).toBe("/Library/Application Support/ClaudeCode/managed-settings.json");
    expect(managedSettingsFiles("win32")[0]).toBe("C:\\Program Files\\ClaudeCode\\managed-settings.json");
    const root = path.join(dir, "repo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const sub = path.join(root, "packages", "api");
    fs.mkdirSync(sub, { recursive: true });
    const lib = path.join(dir, "lib");
    fs.mkdirSync(lib);
    expect(lowerSettingsFiles(configDir, [sub, lib])).toEqual([
      { file: path.join(root, ".claude", "settings.local.json"), level: "local" },
      { file: path.join(sub, ".claude", "settings.local.json"), level: "local" },
      { file: path.join(lib, ".claude", "settings.local.json"), level: "local" },
      { file: path.join(sub, ".claude", "settings.json"), level: "project" },
      { file: path.join(lib, ".claude", "settings.json"), level: "project" },
      { file: path.join(configDir, "settings.json"), level: "user" },
    ]);
  });
});

describe("repoRootOf", () => {
  it("is the repository a folder is in, the main checkout for a worktree, and nothing outside one", () => {
    const root = path.join(dir, "repo");
    fs.mkdirSync(path.join(root, ".git", "worktrees", "wt"), { recursive: true });
    const sub = path.join(root, "a", "b");
    fs.mkdirSync(sub, { recursive: true });
    expect(repoRootOf(sub)).toBe(root);
    expect(repoRootOf(root)).toBe(root);
    const worktree = path.join(dir, "elsewhere", "wt");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "wt")}\n`);
    expect(repoRootOf(path.join(worktree))).toBe(root);
    expect(repoRootOf(path.join(dir, "loose"))).toBeUndefined();
  });
});

describe("retentionIn", () => {
  it("says what a file holds: missing, unreadable, unset, set to whole days of one or more, or invalid", () => {
    const file = path.join(configDir, "settings.json");
    expect(retentionIn(file)).toEqual({ kind: "missing" });
    write(file, "{ not json");
    expect(retentionIn(file)).toEqual({ kind: "unreadable" });
    write(file, [1, 2]);
    expect(retentionIn(file)).toEqual({ kind: "unreadable" });
    write(file, { model: "opus" });
    expect(retentionIn(file)).toEqual({ kind: "unset" });
    for (const days of [30, 3650, 1]) {
      write(file, { cleanupPeriodDays: days });
      expect(retentionIn(file)).toEqual({ kind: "set", days });
    }
    for (const value of [0, -5, 2.5, "30", null]) {
      write(file, { cleanupPeriodDays: value });
      expect(retentionIn(file), String(value)).toEqual({ kind: "invalid", value });
    }
  });
});

describe("managedRetention", () => {
  it("takes the cached server-managed settings when they hold anything, else the files with a later one replacing an earlier", () => {
    const remote = path.join(configDir, "remote-settings.json");
    expect(managedRetention(configDir, "linux")).toEqual({ in: { kind: "missing" } });
    write(remote, {});
    expect(managedRetention(configDir, "linux")).toEqual({ in: { kind: "missing" } });
    write(remote, { permissions: {} });
    expect(managedRetention(configDir, "linux")).toEqual({ file: remote, in: { kind: "unset" } });
    write(remote, { cleanupPeriodDays: 3 });
    expect(managedRetention(configDir, "linux")).toEqual({ file: remote, in: { kind: "set", days: 3 } });
    write(remote, "{ broken");
    expect(managedRetention(configDir, "linux")).toEqual({ file: remote, in: { kind: "unreadable" } });
  });
});

describe("readRetention", () => {
  it("is Claude Code's default of 30 days when no file sets it, and the first file that does otherwise", () => {
    const folder = path.join(dir, "app");
    expect(readRetention(configDir, [folder], "linux")).toEqual({ days: 30, level: "default" });
    const user = path.join(configDir, "settings.json");
    write(user, { cleanupPeriodDays: 90 });
    expect(readRetention(configDir, [folder], "linux")).toEqual({ days: 90, level: "user", file: user });
    const project = path.join(folder, ".claude", "settings.json");
    write(project, { cleanupPeriodDays: 7 });
    expect(readRetention(configDir, [folder], "linux")).toEqual({ days: 7, level: "project", file: project });
    const local = path.join(folder, ".claude", "settings.local.json");
    write(local, { cleanupPeriodDays: 14 });
    expect(readRetention(configDir, [folder], "linux")).toEqual({ days: 14, level: "local", file: local });
    // The server-managed copy Claude Code caches stands above them all.
    const remote = path.join(configDir, "remote-settings.json");
    write(remote, { cleanupPeriodDays: 3 });
    expect(readRetention(configDir, [folder], "linux")).toEqual({ days: 3, level: "managed", file: remote });
  });

  it("reads a project's local file at the repository's root, as Claude Code does for a window on a sub-folder", () => {
    const root = path.join(dir, "repo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const sub = path.join(root, "packages", "api");
    fs.mkdirSync(sub, { recursive: true });
    const local = path.join(root, ".claude", "settings.local.json");
    write(local, { cleanupPeriodDays: 365 });
    expect(readRetention(configDir, [sub], "linux")).toEqual({ days: 365, level: "local", file: local });
  });

  it("is unknown, not the default, over a file that does not parse or a value Claude Code refuses: it pauses its sweep then", () => {
    const folder = path.join(dir, "app");
    const user = path.join(configDir, "settings.json");
    write(user, { cleanupPeriodDays: 0 });
    expect(readRetention(configDir, [folder], "linux")).toEqual({ level: "unknown", file: user });
    write(user, { cleanupPeriodDays: 30 });
    const project = path.join(folder, ".claude", "settings.json");
    write(project, "{ broken");
    expect(readRetention(configDir, [folder], "linux")).toEqual({ level: "unknown", file: project });
    // A managed value stands whatever the lower files hold.
    const remote = path.join(configDir, "remote-settings.json");
    write(remote, { cleanupPeriodDays: 3 });
    expect(readRetention(configDir, [folder], "linux")).toEqual({ days: 3, level: "managed", file: remote });
    write(remote, { cleanupPeriodDays: "3" });
    expect(readRetention(configDir, [folder], "linux")).toEqual({ level: "unknown", file: remote });
  });
});
describe("writeRetention", () => {
  it("creates the user settings file with the retention alone when there is none", () => {
    const configDir2 = path.join(dir, "fresh");
    const outcome = writeRetention(configDir2, 3650);
    expect(outcome).toEqual({ ok: true, file: path.join(configDir2, "settings.json") });
    expect(JSON.parse(fs.readFileSync(path.join(configDir2, "settings.json"), "utf8"))).toEqual({ cleanupPeriodDays: 3650 });
    expect(fs.readdirSync(configDir2)).toEqual(["settings.json"]);
  });

  it("keeps every other key, the file's own indentation and line ending, and a copy of the file as it was", () => {
    const file = path.join(configDir, "settings.json");
    fs.writeFileSync(file, '{\r\n    "$schema": "https://json.schemastore.org/claude-code-settings.json",\r\n    "model": "opus",\r\n    "permissions": {\r\n        "allow": ["Bash(npm test)"]\r\n    },\r\n    "cleanupPeriodDays": 30\r\n}\r\n');
    const now = Date.UTC(2026, 9, 26, 10, 5, 0);
    const outcome = writeRetention(configDir, 3650, now);
    expect(outcome).toEqual({ ok: true, file, backup: `${file}.2026-10-26T10-05-00-000Z.before-lookout` });
    const after = fs.readFileSync(file, "utf8");
    expect(JSON.parse(after)).toEqual({ $schema: "https://json.schemastore.org/claude-code-settings.json", model: "opus", permissions: { allow: ["Bash(npm test)"] }, cleanupPeriodDays: 3650 });
    expect(after.startsWith('{\r\n    "$schema"')).toBe(true);
    expect(after.endsWith("\r\n")).toBe(true);
    expect(Object.keys(JSON.parse(after))[0]).toBe("$schema");
    expect(JSON.parse(fs.readFileSync((outcome as { backup: string }).backup, "utf8"))).toMatchObject({ cleanupPeriodDays: 30 });
    expect(retentionIn(file)).toEqual({ kind: "set", days: 3650 });
    expect(fs.readdirSync(configDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.runIf(posix)("writes through a link to the file it names, keeps the file's permissions, and refuses a hard link", () => {
    const real = path.join(dir, "dotfiles", "claude-settings.json");
    write(real, { env: { ANTHROPIC_AUTH_TOKEN: "secret" } });
    fs.chmodSync(real, 0o600);
    const file = path.join(configDir, "settings.json");
    fs.symlinkSync(real, file);
    const outcome = writeRetention(configDir, 3650);
    // The file the link names, as the file system names it: on macOS the temp folder is itself a link.
    expect(outcome).toMatchObject({ ok: true, file, target: fs.realpathSync(real) });
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8"))).toEqual({ env: { ANTHROPIC_AUTH_TOKEN: "secret" }, cleanupPeriodDays: 3650 });
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
    expect(fs.existsSync((outcome as { backup: string }).backup)).toBe(true);
    // Hard-linked: a rewrite would part the two, so it is refused and both stay as they were.
    const other = path.join(dir, "other.json");
    fs.unlinkSync(file);
    write(file, { model: "opus" });
    fs.linkSync(file, other);
    expect(writeRetention(configDir, 3650)).toEqual({ ok: false, file, why: "is hard-linked elsewhere, and a rewrite would part the two" });
    expect(JSON.parse(fs.readFileSync(other, "utf8"))).toEqual({ model: "opus" });
  });

  it("refuses a file that does not parse, or is not a settings object, and leaves it as it was", () => {
    const file = path.join(configDir, "settings.json");
    write(file, "{ not json");
    expect(writeRetention(configDir, 3650)).toEqual({ ok: false, file, why: "does not parse as JSON" });
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
    write(file, [1, 2]);
    expect(writeRetention(configDir, 3650)).toEqual({ ok: false, file, why: "does not hold a settings object" });
    expect(fs.readdirSync(configDir)).toEqual(["settings.json"]);
  });
});
