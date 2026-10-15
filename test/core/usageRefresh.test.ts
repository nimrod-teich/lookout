import { spawn as realSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseResponse, refreshUsage } from "../../src/core/usageRefresh";
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

describe("parseResponse", () => {
  it("accepts only a successful answer to Lookout's own request", () => {
    expect(parseResponse(JSON.stringify(RESPONSE), 5)).toMatchObject({ fetchedAt: 5, meters: [{ key: "session", percent: 18 }, { key: "weekly_all", percent: 31 }] });
    expect(parseResponse(JSON.stringify({ ...RESPONSE, response: { ...RESPONSE.response, request_id: "other" } }), 5)).toBeUndefined();
    expect(parseResponse(JSON.stringify({ ...RESPONSE, response: { ...RESPONSE.response, subtype: "error" } }), 5)).toBeUndefined();
    expect(parseResponse(JSON.stringify({ type: "system", subtype: "init" }), 5)).toBeUndefined();
    expect(parseResponse("{garbage", 5)).toBeUndefined();
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
    const snapshot = await refreshUsage({ binary, spawn, now: () => 77 });
    expect(snapshot).toMatchObject({ fetchedAt: 77, meters: [{ key: "session", percent: 18 }, { key: "weekly_all", percent: 31 }] });
  });

  it("gives up when the binary answers nothing useful or hangs", async () => {
    const silent = fakeBinary(`process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write('{"type":"system"}\\n'); });`);
    expect(await refreshUsage({ ...silent, timeoutMs: 5_000 })).toBeUndefined();

    const hanging = fakeBinary(`process.stdin.resume(); setInterval(() => {}, 1000);`);
    const started = Date.now();
    expect(await refreshUsage({ ...hanging, timeoutMs: 300 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("resolves undefined for a binary that does not exist", async () => {
    expect(await refreshUsage({ binary: path.join(tempConfigDir(), "missing-claude"), timeoutMs: 2_000 })).toBeUndefined();
  });
});
