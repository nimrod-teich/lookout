import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { WindowRegistry } from "../../src/core/windows";
import { FakeProc, tempConfigDir } from "./helpers";

function setup() {
  const dir = path.join(tempConfigDir(), "windows");
  const proc = new FakeProc();
  return { dir, proc, registry: new WindowRegistry(dir, proc) };
}

describe("WindowRegistry", () => {
  it("lists the other live windows and not itself", () => {
    const { dir, proc, registry } = setup();
    registry.register(100, "me");
    new WindowRegistry(dir, proc).register(200, "other");
    proc.procs.set(100, {}).set(200, {});
    expect([...registry.read(100, 0)]).toEqual([[200, { label: "other", terminals: [] }]]);
    expect([...new WindowRegistry(dir, proc).read(200, 0)]).toEqual([[100, { label: "me", terminals: [] }]]);
  });

  it("removes the record of a window whose process is gone", () => {
    const { dir, proc, registry } = setup();
    registry.register(200, "gone");
    expect(registry.read(100, 0).size).toBe(0);
    expect(fs.existsSync(path.join(dir, "200.json"))).toBe(false);
    proc.procs.set(300, {});
    fs.writeFileSync(path.join(dir, "300.json"), '{"pid":300,"label":"late"}');
    expect([...registry.read(100, 10_000)]).toEqual([[300, { label: "late", terminals: [] }]]);
  });

  it("publishes each window's folders, for the sessions VS Code runs in its Chat", () => {
    const { dir, proc, registry } = setup();
    proc.procs.set(200, {});
    const other = new WindowRegistry(dir, proc);
    other.register(200, "api", [71], ["/work/api", "/work/shared"]);
    expect(registry.read(100, 0).get(200)).toEqual({ label: "api", terminals: [71], folders: ["/work/api", "/work/shared"] });
    fs.writeFileSync(path.join(dir, "200.json"), '{"pid":200,"label":"api","folders":["/work/api",3]}');
    expect(registry.read(100, 10_000).get(200)).toEqual({ label: "api", terminals: [], folders: ["/work/api"] });
  });

  it("publishes each window's finished sessions, so the others show them as finished", () => {
    const { dir, proc, registry } = setup();
    proc.procs.set(200, {});
    const other = new WindowRegistry(dir, proc);
    other.register(200, "api", [], [], ["s1", "s2"]);
    expect(registry.read(100, 0).get(200)).toEqual({ label: "api", terminals: [], done: ["s1", "s2"] });
    other.register(200, "api");
    expect(registry.read(100, 10_000).get(200)).toEqual({ label: "api", terminals: [] });
    fs.writeFileSync(path.join(dir, "200.json"), '{"pid":200,"label":"api","done":["s1",7,null]}');
    expect(registry.read(100, 20_000).get(200)).toEqual({ label: "api", terminals: [], done: ["s1"] });
  });

  it("publishes each window's terminals, and their changes", () => {
    const { dir, proc, registry } = setup();
    proc.procs.set(200, {});
    const other = new WindowRegistry(dir, proc);
    other.register(200, "other", new Set([77, 71]));
    expect(registry.read(100, 0).get(200)).toEqual({ label: "other", terminals: [71, 77] });
    other.register(200, "other", [71]);
    expect(registry.read(100, 10_000).get(200)).toEqual({ label: "other", terminals: [71] });
    // Only the record itself is left behind: written whole under another name first.
    expect(fs.readdirSync(dir)).toEqual(["200.json"]);
    fs.writeFileSync(path.join(dir, "200.json"), '{"pid":200,"label":"other","terminals":[71,"x",-3,2.5]}');
    expect(registry.read(100, 20_000).get(200)).toEqual({ label: "other", terminals: [71] });
  });

  it("ignores files that are not window records", () => {
    const { dir, proc, registry } = setup();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.json"), "{}");
    fs.writeFileSync(path.join(dir, "400.json"), '{"pid":401,"label":"mismatch"}');
    fs.writeFileSync(path.join(dir, "500.json"), "{torn");
    proc.procs.set(400, {}).set(401, {}).set(500, {});
    expect(registry.read(100, 0).size).toBe(0);
  });

  it("reuses a recent listing and reads again later", () => {
    const { dir, proc, registry } = setup();
    proc.procs.set(200, {});
    expect(registry.read(100, 0).size).toBe(0);
    new WindowRegistry(dir, proc).register(200, "other");
    expect(registry.read(100, 1_000).size).toBe(0);
    expect(registry.read(100, 6_000).size).toBe(1);
  });

  it("works without a registry directory and unregisters cleanly", () => {
    const { dir, registry } = setup();
    expect(registry.read(100, 0).size).toBe(0);
    registry.register(100, "me");
    registry.unregister(100);
    registry.unregister(100);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
