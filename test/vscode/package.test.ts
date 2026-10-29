import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// .vscodeignore is an allowlist: a bundle or stylesheet a webview loads must be let through, or the view comes up blank once installed;
// so must the reading thread's bundle, or the search reads in the extension host.
describe("the package allowlist", () => {
  it("lets through every bundle and stylesheet the webviews load, and the reading thread's bundle", () => {
    const root = path.join(__dirname, "..", "..");
    const allowed = fs
      .readFileSync(path.join(root, ".vscodeignore"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1).trim());
    const loaded = new Set<string>();
    for (const file of ["vscode/board.ts", "vscode/findings.ts", "vscode/searchPage.ts", "extension.ts"]) {
      const source = fs.readFileSync(path.join(root, "src", file), "utf8");
      for (const match of source.matchAll(/"(dist|media)",\s*"([^"]+)"/g)) loaded.add(`${match[1]}/${match[2]}`);
    }
    expect([...loaded].sort()).toEqual(["dist/board.js", "dist/findings.js", "dist/reader.js", "dist/search.js", "media/board.css", "media/findings.css", "media/search.css"]);
    for (const file of loaded) expect(allowed, `${file} is not in .vscodeignore`).toContain(file);
  });
});

// A card's context menu lists the extension's card commands, each one VS Code may show: named, kept out of the
// Command Palette (they need a card), and shown only on the board's cards.
describe("the card menu", () => {
  const root = path.join(__dirname, "..", "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    contributes: { commands: { command: string; title: string }[]; menus: Record<string, { command: string; when?: string }[]> };
  };
  const cardCommands = pkg.contributes.commands.filter((c) => c.command.startsWith("lookout.card."));

  it("offers every card command on the board's cards only, and none in the Command Palette", () => {
    expect(cardCommands.map((c) => c.command).sort()).toEqual(
      [
        "lookout.card.addNote",
        "lookout.card.archive",
        "lookout.card.conversation",
        "lookout.card.forget",
        "lookout.card.jump",
        "lookout.card.keep",
        "lookout.card.park",
        "lookout.card.rename",
        "lookout.card.restore",
        "lookout.card.resume",
        "lookout.card.seen",
        "lookout.card.showNotes",
        "lookout.card.star",
        "lookout.card.unarchive",
        "lookout.card.unkeep",
        "lookout.card.unpark",
        "lookout.card.unstar",
      ].sort(),
    );
    const menu = pkg.contributes.menus["webview/context"] ?? [];
    for (const { command } of cardCommands) {
      const entry = menu.find((m) => m.command === command);
      expect(entry?.when, command).toMatch(/^webviewId == 'lookout\.board' && webviewSection == 'card'/);
      expect(pkg.contributes.menus.commandPalette?.find((m) => m.command === command)?.when, command).toBe("false");
    }
  });

  it("gives each context key the menu asks about a value on every card", () => {
    const keys = new Set((pkg.contributes.menus["webview/context"] ?? []).flatMap((m) => m.when?.match(/lookout[A-Z]\w+/g) ?? []));
    const board = fs.readFileSync(path.join(root, "src", "webview", "board.ts"), "utf8");
    for (const key of keys) expect(board, `${key} is never set on a card`).toMatch(new RegExp(`\\b${key}:`));
  });
});

// The Claude Code directories are where Claude Code keeps its sign-ins: one machine's, never a workspace's to choose.
describe("the Claude Code directory settings", () => {
  const root = path.join(__dirname, "..", "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    contributes: { configuration: { properties: Record<string, { type?: string; items?: { type?: string }; default?: unknown; scope?: string; order?: number }> }[] };
  };
  const settings = Object.assign({}, ...pkg.contributes.configuration.map((section) => section.properties)) as (typeof pkg.contributes.configuration)[number]["properties"];

  it("lists more directories as strings, for the machine, right after the primary one", () => {
    const dirs = settings["lookout.claudeConfigDirs"];
    expect(dirs).toMatchObject({ type: "array", items: { type: "string" }, default: [], scope: "machine" });
    expect(settings["lookout.claudeConfigDir"]?.scope).toBe("machine");
    expect(dirs?.order).toBe((settings["lookout.claudeConfigDir"]?.order ?? 0) + 1);
  });
});
