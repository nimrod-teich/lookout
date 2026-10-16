/** What an OS notification is about. */
export type NoticeKind = "waiting" | "finished";

export interface Notice {
  /** Session id. */
  id: string;
  kind: NoticeKind;
  title: string;
  body: string;
}

export interface OsMessage {
  title: string;
  body: string;
  /** What the notification is about; a newer one with the same tag can replace it. */
  tag?: string;
}

/** From this many sessions that need the user, one summary stands in for the notification of each. */
export const SUMMARY_FROM = 3;

/**
 * Decides which OS notifications go out: at most one per session and kind
 * per cooldown, and while several sessions need the user, one summary of
 * them instead of one each, itself at most once per cooldown.
 */
export class NotifyGate {
  private readonly sentAt = new Map<string, number>();

  constructor(private cooldownMs: number) {}

  setCooldown(ms: number): void {
    this.cooldownMs = Math.max(0, ms);
  }

  /**
   * The notification to send for `notice`, or nothing. `needYou` holds the
   * titles of the sessions that need the user now; `hint` ends the body.
   */
  decide(notice: Notice, needYou: readonly string[], hint: string, now: number): OsMessage | undefined {
    for (const [key, at] of this.sentAt) if (now - at >= this.cooldownMs) this.sentAt.delete(key);
    const key = `${notice.kind}:${notice.id}`;
    if (this.sentAt.has(key)) return undefined;
    this.sentAt.set(key, now);
    if (needYou.length >= SUMMARY_FROM) {
      if (this.sentAt.has("summary")) return undefined;
      this.sentAt.set("summary", now);
      return { title: `${needYou.length} sessions need you`, body: `${needYou.join(", ")}\n${hint}`, tag: "summary" };
    }
    return { title: notice.title, body: `${notice.body}\n${hint}`, tag: notice.id };
  }
}
