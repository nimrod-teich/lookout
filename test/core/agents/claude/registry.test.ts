import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../../../../src/core/agents/claude/registry";
import { parseSessionFile } from "../../../../src/core/agents/claude/sessionFile";
import { DOMAIN, FakeProc, sessionId, tempConfigDir, writeSession } from "../../helpers";

function setup() {
  const configDir = tempConfigDir();
  const proc = new FakeProc();
  const registry = new SessionRegistry(path.join(configDir, "sessions"), proc);
  return { configDir, proc, registry, sessions: path.join(configDir, "sessions") };
}

describe("parseSessionFile", () => {
  it("keeps known fields and drops an unknown status", () => {
    const file = parseSessionFile(JSON.stringify({ pid: 5, sessionId: "s", cwd: "/w", status: "exploded", waitingFor: "permission prompt" }));
    expect(file).toMatchObject({ pid: 5, sessionId: "s", cwd: "/w", waitingFor: "permission prompt", spare: false });
    expect(file?.status).toBeUndefined();
  });

  it("returns null for torn, empty, and incomplete content", () => {
    expect(parseSessionFile("")).toBeNull();
    expect(parseSessionFile('{"pid":5,"sessionId":"s","cw')).toBeNull();
    expect(parseSessionFile("[]")).toBeNull();
    expect(parseSessionFile(JSON.stringify({ pid: 5, cwd: "/w" }))).toBeNull();
    expect(parseSessionFile(JSON.stringify({ pid: -1, sessionId: "s", cwd: "/w" }))).toBeNull();
  });
});

describe("SessionRegistry", () => {
  it("lists a live session", () => {
    const { configDir, proc, registry } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "busy" });
    expect(registry.scan()).toEqual([expect.objectContaining({ pid: 11, sessionId: sessionId(1), status: "busy" })]);
  });

  it("returns nothing when the sessions directory is missing", () => {
    expect(new SessionRegistry("/nonexistent/lookout", new FakeProc()).scan()).toEqual([]);
  });

  it("skips a file whose process is gone", () => {
    const { configDir, proc, registry } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1) });
    proc.procs.delete(11);
    expect(registry.scan()).toEqual([]);
  });

  it("skips a file whose pid now belongs to a process with another start time", () => {
    const { configDir, proc, registry } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1) });
    proc.procs.set(11, { ppid: 1, startTicks: "999999" });
    expect(registry.scan()).toEqual([]);
  });

  it("skips a file whose pid now belongs to a process that started after the session", () => {
    const { configDir, proc, registry } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), procStart: undefined, startedAt: 50_000 });
    proc.procs.set(11, { ppid: 1, startedMs: 49_000 });
    expect(registry.scan()).toHaveLength(1);

    writeSession(configDir, proc, { pid: 12, sessionId: sessionId(2), procStart: undefined, startedAt: 50_000 });
    proc.procs.set(12, { ppid: 1, startedMs: 90_000 });
    expect(registry.scan().map((f) => f.pid)).toEqual([11]);
  });

  it("lists a session while the process details are still unknown", () => {
    const { configDir, proc, registry } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), procStart: undefined });
    proc.procs.set(11, {});
    expect(registry.scan()).toHaveLength(1);
  });

  it("accepts an older file without procStart or status when the pid is alive", () => {
    const { configDir, proc, registry } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), procStart: undefined, status: undefined });
    expect(registry.scan()).toEqual([expect.objectContaining({ pid: 11 })]);
    expect(registry.scan()[0]?.status).toBeUndefined();
  });

  it("does not revive a dead session when its pid is reused, until the file is rewritten", () => {
    const { configDir, proc, registry } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), procStart: undefined });
    proc.procs.delete(11);
    expect(registry.scan()).toEqual([]);
    proc.procs.set(11, { ppid: 1, startTicks: "777" });
    expect(registry.scan()).toEqual([]);

    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(2), startedAt: 5_000 });
    expect(registry.scan()).toEqual([expect.objectContaining({ sessionId: sessionId(2) })]);
  });

  it("skips a session from another pid namespace", () => {
    const { configDir, proc, registry } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), pidDomain: "linux:other:pid:[1]" });
    expect(registry.scan()).toEqual([]);
    proc.domain = undefined;
    expect(registry.scan()).toHaveLength(1);
  });

  it("ignores key files, spare sessions, daemons, and mismatched file names", () => {
    const { configDir, proc, registry, sessions } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), spare: true });
    writeSession(configDir, proc, { pid: 12, sessionId: sessionId(2), kind: "daemon" });
    writeSession(configDir, proc, { pid: 13, sessionId: sessionId(3) });
    fs.renameSync(path.join(sessions, "13.json"), path.join(sessions, "14.json"));
    proc.procs.set(14, { ppid: 1, startTicks: "1300" });
    fs.writeFileSync(path.join(sessions, "11.abcdef.key"), "secret");
    fs.writeFileSync(path.join(sessions, "notes.json"), "{}");
    expect(registry.scan()).toEqual([]);
  });

  it("keeps the newest live record when a session id appears twice", () => {
    const { configDir, proc, registry } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "busy", statusUpdatedAt: 100 });
    writeSession(configDir, proc, { pid: 12, sessionId: sessionId(1), status: "idle", statusUpdatedAt: 200 });
    expect(registry.scan()).toEqual([expect.objectContaining({ pid: 12, status: "idle" })]);
    proc.procs.delete(12);
    expect(registry.scan()).toEqual([expect.objectContaining({ pid: 11, status: "busy" })]);
  });

  it("keeps the last good record through a torn rewrite and picks up the next one", () => {
    const { configDir, proc, registry, sessions } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "idle" });
    expect(registry.scan()[0]?.status).toBe("idle");

    fs.writeFileSync(path.join(sessions, "11.json"), '{"pid":11,"sessionId":"');
    expect(registry.scan()[0]?.status).toBe("idle");

    fs.writeFileSync(path.join(sessions, "11.json"), "");
    expect(registry.scan()[0]?.status).toBe("idle");

    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1), status: "waiting", waitingFor: "permission prompt", pidDomain: DOMAIN });
    expect(registry.scan()[0]).toMatchObject({ status: "waiting", waitingFor: "permission prompt" });
  });

  it("forgets a session whose file is removed", () => {
    const { configDir, proc, registry, sessions } = setup();
    writeSession(configDir, proc, { pid: 11, sessionId: sessionId(1) });
    expect(registry.scan()).toHaveLength(1);
    fs.rmSync(path.join(sessions, "11.json"));
    expect(registry.scan()).toEqual([]);
  });
});
