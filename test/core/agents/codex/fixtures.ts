import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";

/** Rollouts of real Codex 0.163.0 sessions, anonymised (test/fixtures/codex). */
export const FIXTURES = path.join(__dirname, "..", "..", "..", "fixtures", "codex");
const DAY = path.join("sessions", "2026", "10", "18");

/** Thread ids of the fixtures, by what their session was doing when copied. */
export const IDLE = "01a14ee5-6f70-7b02-a9cb-7ad01294b026";
export const APPROVAL = "01a14ee6-c111-70e2-9f36-f32a6f1197e4";
export const WORKING = "01a14ee7-9316-79e0-b436-42f35d3b5fb3";
export const QUESTION = "01a14ee8-0965-7292-b784-1fa20762eae5";
export const ASKED_IN_REPLY = "01a14ee8-0983-7592-bcc8-8e4e81aed496";

/** A moment shortly after the fixtures were written: 2026-10-18 12:30 UTC. */
export const NOW = Date.parse("2026-10-18T12:30:00.000Z");
/** When their processes started, a little before their threads. */
export const STARTED = Date.parse("2026-10-18T12:03:00.000Z");

export function fixtureFile(id: string): string {
  const name = fs.readdirSync(path.join(FIXTURES, DAY)).find((n) => n.includes(id));
  if (!name) throw new Error(`no fixture for ${id}`);
  return path.join(FIXTURES, DAY, name);
}

export function fixtureLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway CODEX_HOME holding the fixtures' sessions and thread names, each rollout last written at `writtenAt`. */
export function tempCodexHome(writtenAt: number = NOW - 60_000): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-codex-"));
  created.push(home);
  fs.cpSync(path.join(FIXTURES, "sessions"), path.join(home, "sessions"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "session_index.jsonl"), path.join(home, "session_index.jsonl"));
  for (const name of fs.readdirSync(path.join(home, DAY))) fs.utimesSync(path.join(home, DAY, name), writtenAt / 1000, writtenAt / 1000);
  return home;
}

export function homeFile(home: string, id: string): string {
  const name = fs.readdirSync(path.join(home, DAY)).find((n) => n.includes(id))!;
  return path.join(home, DAY, name);
}
