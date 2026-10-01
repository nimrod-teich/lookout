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
    expect([...registry.read(100, 0)]).toEqual([[200, "other"]]);
    expect([...new WindowRegistry(dir, proc).read(200, 0)]).toEqual([[100, "me"]]);
  });

  it("removes the record of a window whose process is gone", () => {
    const { dir, proc, registry } = setup();
    registry.register(200, "gone");
    expect(registry.read(100, 0).size).toBe(0);
    expect(fs.existsSync(path.join(dir, "200.json"))).toBe(false);
    proc.procs.set(300, {});
    fs.writeFileSync(path.join(dir, "300.json"), '{"pid":300,"label":"late"}');
    expect([...registry.read(100, 10_000)]).toEqual([[300, "late"]]);
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
