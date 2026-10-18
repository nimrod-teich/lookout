import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";

/** Two real Copilot CLI 1.0.98 sessions, anonymised (test/fixtures/copilot). */
export const FIXTURES = path.join(__dirname, "..", "..", "..", "fixtures", "copilot");
/** Answered "What is 2+2?" with "Four"; its process held lock 4001. */
export const ANSWERED = "3380237f-4e26-46e0-9e70-e80680d92355";
/** Asked to run `touch approval-test.txt`, copied while the approval prompt was open; lock 4002. */
export const ASKING = "8f542a94-ca17-429a-abba-0e27af58a035";
export const NOW = Date.parse("2026-10-18T13:20:00.000Z");
export const STARTED = Date.parse("2026-10-18T13:10:00.000Z");

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway COPILOT_HOME with the fixtures' sessions and, when given, Copilot's open-sessions flags. */
export function tempCopilotHome(working?: Record<string, boolean>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-copilot-"));
  created.push(home);
  fs.cpSync(path.join(FIXTURES, "session-state"), path.join(home, "session-state"), { recursive: true });
  if (working) writeOpen(home, working);
  return home;
}

export function writeOpen(home: string, working: Record<string, boolean>): void {
  const entries = Object.fromEntries(Object.entries(working).map(([id, flag]) => [id, { schemaVersion: 1, openedAt: "2026-10-18T13:10:58.864Z", refreshedAt: "2026-10-18T13:13:18.400Z", working: flag }]));
  fs.writeFileSync(path.join(home, "open-sessions-state.json"), JSON.stringify(entries, null, 2));
}

export function events(home: string, id: string): string {
  return path.join(home, "session-state", id, "events.jsonl");
}

export function lines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}
