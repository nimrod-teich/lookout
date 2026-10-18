import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// .vscodeignore is an allowlist: a bundle or stylesheet a webview loads must be let through, or the view comes up blank once installed.
describe("the package allowlist", () => {
  it("lets through every bundle and stylesheet the webviews load", () => {
    const root = path.join(__dirname, "..", "..");
    const allowed = fs
      .readFileSync(path.join(root, ".vscodeignore"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1).trim());
    const loaded = new Set<string>();
    for (const file of ["board.ts", "findings.ts", "searchPage.ts"]) {
      const source = fs.readFileSync(path.join(root, "src", "vscode", file), "utf8");
      for (const match of source.matchAll(/"(dist|media)",\s*"([^"]+)"/g)) loaded.add(`${match[1]}/${match[2]}`);
    }
    expect([...loaded].sort()).toEqual(["dist/board.js", "dist/findings.js", "dist/search.js", "media/board.css", "media/findings.css", "media/search.css"]);
    for (const file of loaded) expect(allowed, `${file} is not in .vscodeignore`).toContain(file);
  });
});
