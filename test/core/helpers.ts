import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";
import type { ProcessInfo, ProcessTable } from "../../src/core/proc";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway Claude Code config directory with empty `sessions/` and `projects/`. */
export function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-test-"));
  created.push(dir);
  fs.mkdirSync(path.join(dir, "sessions"));
  fs.mkdirSync(path.join(dir, "projects"));
  return dir;
}

export const DOMAIN = "linux:feedfacefeedfacefeedfacefeedface:pid:[4026531836]";

export class FakeProc implements ProcessTable {
  readonly procs = new Map<number, ProcessInfo>();
  domain: string | undefined = DOMAIN;

  get(pid: number): ProcessInfo | null {
    return this.procs.get(pid) ?? null;
  }

  pidDomain(): string | undefined {
    return this.domain;
  }
}

export interface SessionFixture {
  pid: number;
  sessionId: string;
  cwd?: string;
  [key: string]: unknown;
}

export function sessionId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Writes `sessions/<pid>.json` the way Claude Code does, with a matching live process. */
export function writeSession(configDir: string, proc: FakeProc, fixture: SessionFixture, ppid = 1000): void {
  const record = {
    cwd: "/work/app",
    startedAt: 1_000,
    procStart: `${fixture.pid}00`,
    kind: "interactive",
    entrypoint: "claude-vscode",
    pidDomain: DOMAIN,
    status: "idle",
    statusUpdatedAt: 2_000,
    ...fixture,
  };
  fs.writeFileSync(path.join(configDir, "sessions", `${fixture.pid}.json`), JSON.stringify(record));
  proc.procs.set(fixture.pid, { ppid, startTicks: record.procStart });
}

export function transcriptPath(configDir: string, cwd: string, id: string): string {
  const dir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.jsonl`);
}

export function appendEntries(file: string, entries: unknown[]): void {
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e) + "\n").join(""));
}
