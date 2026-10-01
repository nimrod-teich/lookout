import type { SessionView } from "../../src/core/types";
import type { Log } from "../../src/vscode/log";

export function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    agent: "claude-code",
    pid: 11,
    title: "Wire the cache",
    state: "idle",
    since: 0,
    project: "app",
    cwd: "/work/app",
    host: "panel",
    ...overrides,
  };
}

export function fakeLog(): Log & { errors: string[] } {
  const errors: string[] = [];
  return { errors, info: () => {}, errorOnce: (message) => void errors.push(message), dispose: () => {} };
}

/** Lets promise callbacks that are already queued run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
