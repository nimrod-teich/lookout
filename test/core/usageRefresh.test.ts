import { spawn as realSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseResponse, readDebugLog, refreshEnv, refreshUsage } from "../../src/core/usageRefresh";
import { tempConfigDir } from "./helpers";

const RESPONSE = {
  type: "control_response",
  response: {
    subtype: "success",
    request_id: "lookout-usage",
    response: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 18 }, seven_day: { utilization: 31 }, limits: [{ kind: "session", percent: 18 }, { kind: "weekly_all", percent: 31 }] } },
  },
};

/** A stand-in for the Claude Code binary: a Node script that reads the request and answers. */
function fakeBinary(script: string): { binary: string; spawn: typeof import("node:child_process").spawn } {
  const file = path.join(tempConfigDir(), "fake-claude.js");
  fs.writeFileSync(file, script);
  // The fake is `node fake-claude.js <args>`; the binary path stands in for `node`.
  const spawn = ((binary: string, args: readonly string[], options: never) => realSpawn(binary, [file, ...args], options)) as typeof realSpawn;
  return { binary: process.execPath, spawn };
}

/** The answer with another payload, as the binary words it. */
function answering(payload: Record<string, unknown>): string {
  return JSON.stringify({ ...RESPONSE, response: { ...RESPONSE.response, response: payload } });
}

describe("parseResponse", () => {
  it("reads the numbers in the answer to Lookout's own request, and nothing else", () => {
    expect(parseResponse(JSON.stringify(RESPONSE), 5)).toMatchObject({ kind: "numbers", snapshot: { fetchedAt: 5, meters: [{ key: "session", percent: 18 }, { key: "weekly_all", percent: 31 }] } });
    expect(parseResponse(JSON.stringify({ ...RESPONSE, response: { ...RESPONSE.response, request_id: "other" } }), 5)).toBeUndefined();
    expect(parseResponse(JSON.stringify({ type: "system", subtype: "init" }), 5)).toBeUndefined();
    expect(parseResponse("{garbage", 5)).toBeUndefined();
  });

  it("tells a sign-in without plan limits from a fetch that failed, and keeps an error's message", () => {
    expect(parseResponse(answering({ subscription_type: null, rate_limits_available: false, rate_limits: null }), 5)).toEqual({ kind: "no plan limits" });
    expect(parseResponse(answering({ subscription_type: "max", rate_limits_available: true, rate_limits: null }), 5)).toEqual({ kind: "no numbers" });
    const error = JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "lookout-usage", error: "Unsupported control request subtype: get_usage" } });
    expect(parseResponse(error, 5)).toEqual({ kind: "error", message: "Unsupported control request subtype: get_usage" });
  });
});

describe("readDebugLog", () => {
  it("takes the wait a 429 asks for, as Claude Code logs it", () => {
    const log = [
      "2026-10-19T09:11:15.954Z [DEBUG] fetchUtilization: GET /api/oauth/usage (attempt 1)",
      "2026-10-19T09:11:16.120Z [DEBUG] fetchUtilization: 429 remembered for this bearer; not asking again for 1800s",
      "2026-10-19T09:11:16.121Z [ERROR] Failed to load usage data: Request failed with status code 429",
    ].join("\n");
    expect(readDebugLog(log)).toEqual({ retryAfterMs: 1_800_000, failure: "Request failed with status code 429" });
  });

  it("holds off for no other refusal, and says nothing about a log without the lines", () => {
    expect(readDebugLog("x [DEBUG] fetchUtilization: 403 remembered for this bearer; not asking again for 300s")).toEqual({ failure: "the usage endpoint answered 403" });
    expect(readDebugLog("x [DEBUG] fetchUtilization: 200 after 1 attempt(s)\n")).toEqual({});
    expect(readDebugLog("")).toEqual({});
  });
});

describe("refreshEnv", () => {
  it("names an overridden config directory, and leaves the standard one to the binary's default", () => {
    const home = path.join(path.sep, "home", "u");
    expect(refreshEnv({ PATH: "/bin" }, path.join(home, ".claude-work"), path.join(home, ".claude"))).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: path.join(home, ".claude-work") });
    // With CLAUDE_CONFIG_DIR set, Claude Code keeps its config file inside the folder: the standard one must go unnamed.
    expect(refreshEnv({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/elsewhere" }, path.join(home, ".claude"), path.join(home, ".claude"))).toEqual({ PATH: "/bin" });
  });
});

describe("refreshUsage", () => {
  it("sends the request, reads the answer, and exits", async () => {
    const { binary, spawn } = fakeBinary(`
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (input += c));
      process.stdin.on("end", () => {
        const request = JSON.parse(input.trim());
        if (request.request.subtype !== "get_usage") process.exit(2);
        process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
        process.stdout.write(${JSON.stringify(JSON.stringify(RESPONSE))} + "\\n");
      });
    `);
    const result = await refreshUsage({ binary, spawn, now: () => 77 });
    expect(result).toMatchObject({ answer: { kind: "numbers", snapshot: { fetchedAt: 77, meters: [{ key: "session", percent: 18 }, { key: "weekly_all", percent: 31 }] } } });
    expect(result.failure).toBeUndefined();
  });

  it("has the binary write its debug log to a folder of its own, reads the 429's wait from it, and removes the folder", async () => {
    const seen = path.join(tempConfigDir(), "debug-file");
    const { binary, spawn } = fakeBinary(`
      const fs = require("fs");
      const file = process.argv[process.argv.indexOf("--debug-file") + 1];
      fs.writeFileSync(${JSON.stringify(seen)}, file);
      fs.writeFileSync(file, "t [DEBUG] fetchUtilization: 429 remembered for this bearer; not asking again for 600s\\n");
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write(${JSON.stringify(answering({ rate_limits_available: true, rate_limits: null }))} + "\\n");
        process.exit(0);
      });
    `);
    const result = await refreshUsage({ binary, spawn });
    expect(result).toEqual({ answer: { kind: "no numbers" }, retryAfterMs: 600_000 });
    const file = fs.readFileSync(seen, "utf8");
    expect(path.dirname(path.dirname(file))).toBe(path.resolve(os.tmpdir()));
    await vi.waitFor(() => expect(fs.existsSync(path.dirname(file))).toBe(false));
  });

  it("runs a binary that refuses the debug flag again without it, and from then on", async () => {
    const runs = path.join(tempConfigDir(), "runs");
    const { binary: node, spawn } = fakeBinary(`
      const fs = require("fs");
      fs.appendFileSync(${JSON.stringify(runs)}, process.argv.includes("--debug-file") ? "d" : "-");
      if (process.argv.includes("--debug-file")) {
        process.stderr.write("error: unknown option '--debug-file'\\n");
        process.exit(1);
      }
      process.stdin.resume();
      process.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(RESPONSE))} + "\\n"));
    `);
    // A path of its own, as the binary of one install is remembered by its path.
    const binary = path.join(tempConfigDir(), "old-claude");
    const run = (options: Parameters<typeof refreshUsage>[0]) => refreshUsage({ ...options, spawn: ((_: string, args: readonly string[], opts: never) => spawn(node, args, opts)) as typeof spawn });
    expect((await run({ binary })).answer?.kind).toBe("numbers");
    expect((await run({ binary })).answer?.kind).toBe("numbers");
    expect(fs.readFileSync(runs, "utf8")).toBe("d--");
  });

  it("says why a binary gave no answer: the end of what it wrote to stderr, or the timeout", async () => {
    const failing = fakeBinary(`process.stderr.write("Error: something broke\\n  at somewhere\\n"); process.exit(3);`);
    expect(await refreshUsage(failing)).toEqual({ failure: "it exited with code 3 and no answer: Error: something broke at somewhere" });
    const hanging = fakeBinary(`process.stdin.resume(); setInterval(() => {}, 1000);`);
    expect(await refreshUsage({ ...hanging, timeoutMs: 300 })).toEqual({ failure: "no answer within 0.3 s" });
  });

  it("gives up when the binary answers nothing useful or hangs", async () => {
    const silent = fakeBinary(`process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write('{"type":"system"}\\n'); });`);
    expect((await refreshUsage({ ...silent, timeoutMs: 5_000 })).answer).toBeUndefined();

    const hanging = fakeBinary(`process.stdin.resume(); setInterval(() => {}, 1000);`);
    const started = Date.now();
    expect((await refreshUsage({ ...hanging, timeoutMs: 300 })).answer).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("runs the binary with the config directory the numbers are read from, and lets it finish writing its cache", async () => {
    const dir = tempConfigDir();
    const { binary, spawn } = fakeBinary(`
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write(${JSON.stringify(JSON.stringify(RESPONSE))} + "\\n");
        // The cache is written after the answer, as a slow disk might.
        setTimeout(() => {
          require("fs").writeFileSync(require("path").join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), "{}");
          process.exit(0);
        }, 300);
      });
    `);
    const { answer } = await refreshUsage({ binary, spawn, env: refreshEnv(process.env, dir, "/home/nobody/.claude") });
    expect(answer?.kind === "numbers" && answer.snapshot.meters[0]).toMatchObject({ key: "session", percent: 18 });
    expect(fs.existsSync(path.join(dir, ".claude.json"))).toBe(true);
  });

  it("stops a binary that does not exit after answering, after a short grace", async () => {
    const lingering = fakeBinary(`
      process.stdin.resume();
      process.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(RESPONSE))} + "\\n"));
      setInterval(() => {}, 1000);
    `);
    const started = Date.now();
    const { answer } = await refreshUsage({ ...lingering, exitGraceMs: 200, timeoutMs: 10_000 });
    expect(answer?.kind === "numbers" && answer.snapshot.meters).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("says a binary that does not exist could not start", async () => {
    const result = await refreshUsage({ binary: path.join(tempConfigDir(), "missing-claude"), timeoutMs: 2_000 });
    expect(result.answer).toBeUndefined();
    expect(result.failure).toMatch(/^could not start the binary: /);
  });
});
