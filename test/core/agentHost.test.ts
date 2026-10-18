import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostSessions } from "../../src/core/agentHost";
import { loadSqlite } from "../../src/core/sqlite";

const sqlite = loadSqlite();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An `agentSessionData` folder with one session per entry: VS Code's id, the agent's id it names (Copilot's way, or Codex's `threadId`), when it was made. */
function agentSessionData(sessions: { vscodeId: string; agentId?: string; threadId?: string; at: number; noDb?: boolean }[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-agenthost-"));
  dirs.push(root);
  for (const session of sessions) {
    const dir = path.join(root, session.vscodeId);
    fs.mkdirSync(dir);
    if (!session.noDb) {
      const db = new sqlite!.DatabaseSync(path.join(dir, "session.db"), { readOnly: false });
      db.prepare("CREATE TABLE session_metadata (key TEXT PRIMARY KEY, value TEXT)").all();
      db.prepare("INSERT INTO session_metadata VALUES ('isRead', 'true')").all();
      if (session.agentId) db.prepare("INSERT INTO session_metadata VALUES ('defaultChatProviderData', ?)").all(JSON.stringify({ sdkSessionId: session.agentId, model: { id: "auto" } }));
      if (session.threadId) {
        db.prepare("INSERT INTO session_metadata VALUES ('defaultChatProviderData', ?)").all(JSON.stringify({ model: { id: "gpt-6.1-sol" } }));
        db.prepare("INSERT INTO session_metadata VALUES ('codex.threadId', ?)").all(session.threadId);
      }
      db.close();
    }
    fs.utimesSync(dir, session.at / 1000, session.at / 1000);
  }
  return root;
}

const VS1 = "f7b4f52e-06e8-4a0d-9d38-4e01ebedf33e";
const VS2 = "0b2bbdb2-7784-4bbf-953f-e449496b8428";
const AGENT1 = "446903d1-680e-4e30-9fb0-fd984da6590b";
const AGENT2 = "6ffb2ea3-339a-472a-9353-0f80009828b2";
const AT = Date.parse("2026-10-18T16:31:47.548Z");

describe.skipIf(!sqlite)("VS Code's agent host sessions", () => {
  it("finds VS Code's id for an agent's session in the session databases, and keeps what it read", () => {
    const root = agentSessionData([
      { vscodeId: VS1, agentId: AGENT1, at: AT },
      { vscodeId: VS2, agentId: AGENT2, at: AT - 3_600_000 },
      { vscodeId: "c18b6f46-900d-45fe-b90f-d8c0e8fbee75", at: AT },
      { vscodeId: "9c8a7209-70bf-4c76-869c-faf93ea904fd", at: AT, noDb: true },
    ]);
    fs.mkdirSync(path.join(root, `${VS1}----z----i---`));
    const sessions = new AgentHostSessions(root);
    expect(sessions.available).toBe(true);
    expect(sessions.idOf(AGENT1, AT)).toBe(VS1);
    expect(sessions.idOf(AGENT2)).toBe(VS2);
    // Read once: a database gone since is not read again.
    fs.rmSync(path.join(root, VS1, "session.db"));
    expect(sessions.idOf(AGENT1, AT)).toBe(VS1);
    expect(sessions.idOf("01a14ee5-6f70-7b02-a9cb-7ad01294b026")).toBeUndefined();
  });

  it("finds VS Code's id for a Codex thread by the thread id its database names", () => {
    const thread = "01a15028-b94b-78e2-850b-f79bd50efebb";
    const root = agentSessionData([
      { vscodeId: VS1, threadId: thread, at: AT },
      { vscodeId: VS2, agentId: AGENT2, at: AT },
    ]);
    const sessions = new AgentHostSessions(root);
    expect(sessions.idOf(thread, AT)).toBe(VS1);
    expect(sessions.idOf(AGENT2, AT)).toBe(VS2);
  });

  it("reads a folder made in the last minute again until it names its agent's id", () => {
    const thread = "01a15030-0682-7070-95cf-25324ca61d58";
    const root = agentSessionData([{ vscodeId: VS1, at: Date.now() }]);
    const sessions = new AgentHostSessions(root);
    expect(sessions.idOf(thread)).toBeUndefined();
    const db = new sqlite!.DatabaseSync(path.join(root, VS1, "session.db"), { readOnly: false });
    db.prepare("INSERT INTO session_metadata VALUES ('codex.threadId', ?)").all(thread);
    db.close();
    expect(sessions.idOf(thread)).toBe(VS1);
  });

  it("looks only at the folders made since the session, when told when that was", () => {
    const root = agentSessionData([{ vscodeId: VS2, agentId: AGENT2, at: AT - 3_600_000 }]);
    const sessions = new AgentHostSessions(root);
    expect(sessions.idOf(AGENT2, AT)).toBeUndefined();
    expect(sessions.idOf(AGENT2, AT - 3_600_000)).toBe(VS2);
  });

  it("finds nothing without a folder or without sqlite", () => {
    expect(new AgentHostSessions(undefined).idOf(AGENT1)).toBeUndefined();
    expect(new AgentHostSessions(path.join(os.tmpdir(), "lookout-no-such-dir")).idOf(AGENT1)).toBeUndefined();
    const root = agentSessionData([{ vscodeId: VS1, agentId: AGENT1, at: AT }]);
    const blind = new AgentHostSessions(root, null);
    expect(blind.available).toBe(false);
    expect(blind.idOf(AGENT1)).toBeUndefined();
  });
});
