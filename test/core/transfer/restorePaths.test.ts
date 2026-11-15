import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeProjectDir } from "../../../src/core/agents/claude/paths";
import { inside, isFolderName, isSessionId, layOf, makeFolders, mapCovered, mapFolderName, mapPath, mapPathKey, segmentsOf, under } from "../../../src/core/transfer/restorePaths";
import { sessionId, tempConfigDir } from "../helpers";

describe("the backup's names, checked", () => {
  it("takes a relative path of plain parts and refuses anything that could leave its root", () => {
    expect(segmentsOf("-home-a-proj/00000000-0000-4000-8000-000000000001.jsonl")).toEqual(["-home-a-proj", "00000000-0000-4000-8000-000000000001.jsonl"]);
    expect(segmentsOf("a/b c/d.txt")).toEqual(["a", "b c", "d.txt"]);
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a/./b", "a/..", "a\\b", "..\\x", "a//b", "a/", "C:/x", "C:x", "a\0b", "a\nb", 7, undefined, "x".repeat(256)]) expect(segmentsOf(bad), String(bad)).toBeUndefined();
    // Names Windows reads as something else.
    for (const bad of ["CON", "nul.txt", "a/COM1/b", "LPT9.jsonl", "trailing.", "trailing "]) expect(segmentsOf(bad), bad).toBeUndefined();
    expect(segmentsOf("console/null.txt")).toEqual(["console", "null.txt"]);
  });

  it("knows a session id and a project folder's name", () => {
    expect(isSessionId(sessionId(1))).toBe(true);
    expect(isSessionId("01A14EE5-6F70-7B02-A9CB-7AD01294B026")).toBe(true);
    for (const bad of ["", "abc", `${sessionId(1)}x`, `../${sessionId(1)}`, sessionId(1).replace(/-/g, "")]) expect(isSessionId(bad), bad).toBe(false);
    expect(isFolderName("-home-alice-proj")).toBe(true);
    expect(isFolderName("a.b_c-d")).toBe(true);
    for (const bad of ["", ".", "..", "a b", "a/b", "a\\b", "ä"]) expect(isFolderName(bad), bad).toBe(false);
  });

  it("puts checked parts under a root and nowhere else", () => {
    const root = tempConfigDir();
    expect(under(root, ["a", "b.txt"])).toBe(path.join(root, "a", "b.txt"));
    expect(under(root, ["..", "b.txt"])).toBeUndefined();
    expect(under(root, ["a/../../b"])).toBeUndefined();
    expect(under(root, [])).toBeUndefined();
    // A name that starts with two dots is a name, not a step up.
    expect(inside(root, path.join(root, "..foo"))).toBe(true);
    expect(inside(root, path.join(root, "..", "x"))).toBe(false);
    expect(inside(root, path.dirname(root))).toBe(false);
  });
});

describe("the folder mapping", () => {
  const mapping = [
    { from: "/home/alice", to: "/Users/bob" },
    { from: "/home/alice/work", to: "/Volumes/code" },
  ];

  it("maps a path by the longest prefix that holds it, whole folders only", () => {
    expect(mapPath("/home/alice/proj", mapping, "linux")).toBe(path.join("/Users/bob", "proj"));
    expect(mapPath("/home/alice/work/api/src", mapping, "linux")).toBe(path.join("/Volumes/code", "api", "src"));
    expect(mapPath("/home/alice", mapping, "linux")).toBe(path.normalize("/Users/bob"));
    expect(mapPath("/home/alicea/x", mapping, "linux")).toBe("/home/alicea/x");
    expect(mapPath("/srv/data", mapping, "linux")).toBe("/srv/data");
  });

  it("refuses a path that is not absolute or that climbs", () => {
    for (const bad of ["", "relative/path", "/home/alice/../../etc", "/home/alice/./x", "/a\0b", 3, null]) expect(mapPath(bad, mapping, "linux"), String(bad)).toBeUndefined();
  });

  it("reads a Windows machine's paths with either slash and any case, and a Mac's in any case", () => {
    const windows = [{ from: "C:\\Users\\Alice", to: "/home/bob" }];
    expect(mapPath("c:\\users\\alice\\proj\\api", windows, "win32")).toBe(path.join("/home/bob", "proj", "api"));
    expect(mapPath("C:/Users/Alice/proj", windows, "win32")).toBe(path.join("/home/bob", "proj"));
    expect(mapPath("/Users/Alice/proj", [{ from: "/Users/alice", to: "/home/bob" }], "darwin")).toBe(path.join("/home/bob", "proj"));
    expect(mapPath("/Users/Alice/proj", [{ from: "/Users/alice", to: "/home/bob" }], "linux")).toBe("/Users/Alice/proj");
  });

  it("maps a project folder's name the way its folder maps, at a part's boundary", () => {
    expect(mapFolderName("-home-alice-proj", mapping)).toBe("-Users-bob-proj");
    expect(mapFolderName("-home-alice-work-api", mapping)).toBe("-Volumes-code-api");
    expect(mapFolderName("-home-alice", mapping)).toBe("-Users-bob");
    expect(mapFolderName("-home-alicea-x", mapping)).toBe("-home-alicea-x");
    expect(mapFolderName("..", mapping)).toBeUndefined();
    expect(mapFolderName("a/b", mapping)).toBeUndefined();
  });

  it("compares a Windows machine's folder names without case, its drive letter written either way, and a Linux machine's with it", () => {
    const windows = [{ from: "C:\\Users\\Alice", to: "/home/bob" }];
    expect(mapFolderName("c--Users-Alice-proj", windows, "win32")).toBe("-home-bob-proj");
    expect(mapFolderName("C--users-alice-proj", windows, "win32")).toBe("-home-bob-proj");
    expect(mapFolderName("c--Users-Alice-proj", windows, "linux")).toBe("c--Users-Alice-proj");
    expect(mapFolderName("-Home-Alice-proj", mapping, "linux")).toBe("-Home-Alice-proj");
  });

  it("maps a cut folder name by its start, keeping its hash, and cuts one the mapping makes too long", () => {
    const deep = "/home/alice/" + "d".repeat(250);
    const cut = encodeProjectDir(deep);
    const mapped = mapFolderName(cut, [{ from: "/home/alice", to: "/Users/robert" }])!;
    // Claude Code finds it by its first 200 characters, which are those of the new place's name.
    expect(mapped.slice(0, 200)).toBe(encodeProjectDir("/Users/robert/" + "d".repeat(250)).slice(0, 200));
    expect(mapped.slice(200)).toBe(cut.slice(200));
    expect(isFolderName(mapped)).toBe(true);
    const grown = mapFolderName("-home-alice-" + "e".repeat(180), [{ from: "/home/alice", to: "/Volumes/a-much-longer-home-folder" }])!;
    expect(grown.slice(0, 200)).toBe(("-Volumes-a-much-longer-home-folder-" + "e".repeat(180)).slice(0, 200));
    expect(grown).toMatch(/^.{200}-[0-9a-z]+$/);
  });

  it("maps a path a click acts on only where a mapping covers it, every part after it one a restore takes", () => {
    expect(mapCovered("/home/alice/proj/x", mapping, "linux", "linux")).toBe(path.join("/Users/bob", "proj", "x"));
    expect(mapCovered("/home/alice", mapping, "linux", "linux")).toBe(path.normalize("/Users/bob"));
    for (const bad of ["/srv/proj", "/home/alicea/x", "relative/x", "/home/alice/../etc", "/home/alice/a\0b", "/home/alice/CON/x", "/home/alice/a:b", 5]) expect(mapCovered(bad, mapping, "linux", "linux"), String(bad)).toBeUndefined();
    // A backslash is part of a Linux name between two Linux machines, and a name a restore does not take.
    expect(mapCovered("/home/alice/a\\b", mapping, "linux", "linux")).toBeUndefined();
    // Where either machine is Windows it parts the path, and what it parts is checked.
    expect(mapCovered("/home/alice/a\\b", mapping, "linux", "win32")).toBe(path.join("/Users/bob", "a", "b"));
    expect(mapCovered("/home/alice/a\\..\\..\\etc", mapping, "linux", "win32")).toBeUndefined();
    const windows = [{ from: "C:\\Users\\Alice", to: "/home/bob" }];
    expect(mapCovered("c:\\users\\alice\\wt\\a", windows, "win32", "linux")).toBe(path.join("/home/bob", "wt", "a"));
    expect(mapCovered("C:\\Users\\Alice\\..\\Bob", windows, "win32", "linux")).toBeUndefined();
    expect(mapCovered("D:\\work", windows, "win32", "linux")).toBeUndefined();
  });

  it("maps the paths the history keys, lowercased", () => {
    expect(mapPathKey("/home/alice/proj/src/a.ts", mapping)).toBe("/users/bob/proj/src/a.ts");
    expect(mapPathKey("/home/alice/work/x", mapping)).toBe("/volumes/code/x");
    expect(mapPathKey("/elsewhere/x", mapping)).toBe("/elsewhere/x");
  });
});

describe("what is on disk where a restore would write", () => {
  it("tells a file from nothing, and a link or a folder from either, on the way or at the end", () => {
    const root = tempConfigDir();
    const outside = tempConfigDir();
    fs.mkdirSync(path.join(root, "a"));
    fs.writeFileSync(path.join(root, "a", "f.txt"), "x");
    expect(layOf(root, ["a", "f.txt"])).toBe("file");
    expect(layOf(root, ["a", "g.txt"])).toBe("missing");
    expect(layOf(root, ["b", "g.txt"])).toBe("missing");
    expect(layOf(root, ["a"])).toBe("unsafe");
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(root, "a", "link.txt"));
    expect(layOf(root, ["a", "link.txt"])).toBe("unsafe");
    fs.symlinkSync(outside, path.join(root, "linked"), "dir");
    expect(layOf(root, ["linked", "x.txt"])).toBe("unsafe");
    expect(layOf(root, ["a", "f.txt", "x"])).toBe("unsafe");
  });

  it("makes folders one at a time and stops at a link", async () => {
    const root = tempConfigDir();
    const outside = tempConfigDir();
    expect(await makeFolders(root, ["x", "y"])).toBe(true);
    expect(fs.statSync(path.join(root, "x", "y")).isDirectory()).toBe(true);
    fs.symlinkSync(outside, path.join(root, "linked"), "dir");
    expect(await makeFolders(root, ["linked", "deeper"])).toBe(false);
    expect(fs.existsSync(path.join(outside, "deeper"))).toBe(false);
  });
});
