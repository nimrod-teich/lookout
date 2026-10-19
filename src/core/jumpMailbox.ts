import * as fs from "node:fs";
import * as path from "node:path";

/** Mail older than this is ignored and removed: the user has moved on. */
export const MAIL_TTL_MS = 10_000;

/** A request from one window to another to bring a session it hosts to the front. */
export interface JumpRequest {
  sessionId: string;
  /** Extension host pid of the window that asks. */
  fromPid: number;
  /** Epoch ms it was sent. */
  at: number;
}

/** How a jump went, as the window that hosts the session tells the one that asked. */
export interface JumpReply {
  sessionId: string;
  /** Extension host pid of the window that answers. */
  fromPid: number;
  /** It had the session and brought its tab or terminal to the front. */
  found: boolean;
  /** It came to the front of the desktop itself. */
  raised: boolean;
  at: number;
}

/** From one window to the one that hosts these sessions: the user marked their finished turns seen there. */
export interface SeenNote {
  ids: string[];
  /** Extension host pid of the window that sends it. */
  fromPid: number;
  at: number;
}

const REQUEST = /^jump-(\d+)-(\d+)\.json$/;
const REPLY = /^jumped-(\d+)-(\d+)\.json$/;
const SEEN = /^seen-(\d+)-(\d+)\.json$/;

/**
 * Jumps between the VS Code windows on one host, as files in the directory
 * their registry shares: `jump-<pid>-<time>.json` asks the window whose
 * extension host has that pid to bring a session to the front, and
 * `jumped-<pid>-<time>.json` tells the asking window how it went, and
 * `seen-<pid>-<time>.json` tells the window that hosts some sessions that the
 * user marked their finished turns seen in another window. Each file
 * is created exclusively and taken once; mail older than ten seconds is
 * ignored and removed by whoever reads the directory.
 */
export class JumpMailbox {
  constructor(private readonly dir: string) {}

  /** Asks window `toPid` to bring a session to the front; the letter's name, to withdraw it, or undefined when it could not be sent. */
  send(toPid: number, request: Omit<JumpRequest, "at">, now: number): string | undefined {
    return this.post("jump", toPid, { ...request, at: now }, now);
  }

  /** Tells window `toPid` how its request went. */
  reply(toPid: number, reply: Omit<JumpReply, "at">, now: number): boolean {
    return this.post("jumped", toPid, { ...reply, at: now }, now) !== undefined;
  }

  /** Tells window `toPid` that the user marked some of its sessions seen. */
  sendSeen(toPid: number, note: Omit<SeenNote, "at">, now: number): boolean {
    return this.post("seen", toPid, { ...note, at: now }, now) !== undefined;
  }

  /** Takes back a letter nobody took: the window that sent it stopped waiting. */
  withdraw(name: string): void {
    try {
      fs.rmSync(path.join(this.dir, path.basename(name)), { force: true });
    } catch {
      // Taken meanwhile, or not removable: it expires.
    }
  }

  /**
   * The requests for window `selfPid`, oldest first, each taken once. Those
   * older than `maxAgeMs` are taken and dropped: the window that sent them
   * has given up on them.
   */
  takeRequests(selfPid: number, now: number, maxAgeMs: number = MAIL_TTL_MS): JumpRequest[] {
    return this.take(REQUEST, selfPid, now, (raw) => (typeof raw.sessionId === "string" && typeof raw.fromPid === "number" && typeof raw.at === "number" ? (raw as unknown as JumpRequest) : undefined)).filter(
      (request) => now - request.at <= maxAgeMs,
    );
  }

  /** The replies for window `selfPid`, oldest first, each taken once. */
  takeReplies(selfPid: number, now: number): JumpReply[] {
    return this.take(REPLY, selfPid, now, (raw) =>
      typeof raw.sessionId === "string" && typeof raw.fromPid === "number" && typeof raw.found === "boolean" && typeof raw.raised === "boolean" ? (raw as unknown as JumpReply) : undefined,
    );
  }

  /** The notes for window `selfPid`, oldest first, each taken once. */
  takeSeen(selfPid: number, now: number): SeenNote[] {
    return this.take(SEEN, selfPid, now, (raw) =>
      Array.isArray(raw.ids) && typeof raw.fromPid === "number" && typeof raw.at === "number" ? { ids: raw.ids.filter((id): id is string => typeof id === "string"), fromPid: raw.fromPid, at: raw.at } : undefined,
    );
  }

  private post(kind: "jump" | "jumped" | "seen", toPid: number, body: object, now: number): string | undefined {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      return undefined;
    }
    const data = JSON.stringify(body);
    // Two letters in one millisecond: the second takes the next one.
    for (let time = now; time < now + 50; time++) {
      const name = `${kind}-${toPid}-${time}.json`;
      try {
        fs.writeFileSync(path.join(this.dir, name), data, { flag: "wx" });
        return name;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      }
    }
    return undefined;
  }

  /**
   * Takes the letters of one kind for `selfPid`, and removes every letter in
   * the directory that has expired, whoever it was for.
   */
  private take<T>(pattern: RegExp, selfPid: number, now: number, parse: (raw: Record<string, unknown>) => T | undefined): T[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const taken: { time: number; letter: T }[] = [];
    for (const name of names) {
      const match = REQUEST.exec(name) ?? REPLY.exec(name) ?? SEEN.exec(name);
      if (!match) continue;
      const file = path.join(this.dir, name);
      const time = Number(match[2]);
      if (now - time > MAIL_TTL_MS) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // Held open, or not a file: the next look tries again; the rest of the mail still goes.
        }
        continue;
      }
      if (!pattern.test(name) || Number(match[1]) !== selfPid) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        // Being written: the next look takes it.
        continue;
      }
      // Whoever removes it takes it: two looks at once never take one letter twice.
      try {
        fs.rmSync(file);
      } catch {
        continue;
      }
      const letter = typeof raw === "object" && raw !== null ? parse(raw as Record<string, unknown>) : undefined;
      if (letter !== undefined) taken.push({ time, letter });
    }
    return taken.sort((a, b) => a.time - b.time).map((entry) => entry.letter);
  }
}
