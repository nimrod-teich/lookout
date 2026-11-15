// What the backup page works out without the DOM: its sections, what a
// choice takes in, what stands before a save in the passphrase fields, and a
// choice read back from a message.
import { SECTIONS, type SectionId } from "../core/transfer/types";
import type { BackupChoice, Days, Level, SectionRow } from "./backupProtocol";

/** "1 session", "1,204 sessions". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** The time of day, "17:42". */
export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface SectionInfo {
  title: string;
  about: string;
  /** What its count counts, when it counts one kind of thing. */
  unit?: readonly [one: string, many: string];
}

/** What each section is called on the page and what it holds. */
export const SECTION_INFO: Record<SectionId, SectionInfo> = {
  transcripts: {
    title: "Transcripts",
    about: "Claude Code's conversations, from every config directory Lookout watches. Claude's memory folders never go in.",
    unit: ["session", "sessions"],
  },
  subagents: { title: "Include subagent transcripts", about: "The conversations of the agents each session started.", unit: ["file", "files"] },
  toolResults: { title: "Include tool outputs", about: "Long tool results Claude Code keeps beside a transcript.", unit: ["file", "files"] },
  history: {
    title: "Conversation history",
    about: "Lookout's own database of what was said, the conversations whose transcripts are gone among them.",
    unit: ["file", "files"],
  },
  vault: { title: "Kept transcripts", about: "The transcripts you asked Lookout to keep.", unit: ["kept transcript", "kept transcripts"] },
  notes: { title: "Notes", about: "Your notes on sessions.", unit: ["note", "notes"] },
  state: { title: "Stars, archive and parking", about: "Starred, archived and parked sessions, the board's order and grouping, and account names." },
  tabs: { title: "Open Claude tabs", about: "The Claude tabs open in each window, to open again after a restore.", unit: ["tab", "tabs"] },
  usage: { title: "Usage records", about: "What Lookout recorded of your plans' usage.", unit: ["file", "files"] },
  worktreesLog: { title: "Removed worktrees", about: "The list of worktrees removed from the worktrees page.", unit: ["file", "files"] },
};

/** The transcripts' own inclusions: they go in only with the transcripts. */
export const TRANSCRIPT_PARTS: readonly SectionId[] = ["subagents", "toolResults"];

/** The sections listed on their own, in the page's order; the transcripts' parts sit inside the transcripts. */
export const PAGE_SECTIONS: readonly SectionId[] = ["transcripts", "history", "vault", "notes", "state", "tabs", "usage", "worktreesLog"];

/** The sections that hold what was said: with one of them in, a file in the clear holds conversations. */
export const CONVERSATION_SECTIONS: readonly SectionId[] = ["transcripts", "history", "vault"];

/** The age filter's choices, by when a session's transcript was last written. */
export const AGES: readonly { days?: Days; label: string }[] = [{ label: "All" }, { days: 7, label: "Last 7 days" }, { days: 30, label: "Last 30 days" }, { days: 90, label: "Last 90 days" }];

export const LEVELS: readonly { level: Level; label: string; about: string }[] = [
  { level: "fast", label: "Fast", about: "zstd 3" },
  { level: "smaller", label: "Smaller", about: "zstd 9, slower" },
];

/** Every section in, every repository, every age, fast, encrypted. */
export function defaultChoice(): BackupChoice {
  return { sections: [...SECTIONS], skipRepos: [], level: "fast", encrypt: true };
}

/** The sections a choice takes, in their order: the transcripts' parts only with the transcripts. */
export function effectiveSections(choice: Pick<BackupChoice, "sections">): SectionId[] {
  const on = new Set(choice.sections);
  return SECTIONS.filter((id) => on.has(id) && (!TRANSCRIPT_PARTS.includes(id) || on.has("transcripts")));
}

/** A conversation goes in: a section that holds them is ticked and has something in it. */
export function holdsConversations(choice: Pick<BackupChoice, "sections">, rows: readonly SectionRow[]): boolean {
  const on = new Set(effectiveSections(choice));
  return rows.some((row) => CONVERSATION_SECTIONS.includes(row.id) && on.has(row.id) && row.count > 0);
}

/** What "Don't encrypt" leaves anyone with a copy of the file able to read, in a sentence. */
export function plainWarning(choice: Pick<BackupChoice, "sections">, rows: readonly SectionRow[]): string {
  return holdsConversations(choice, rows)
    ? "The file then holds your conversations in the clear: anyone with a copy of it can read them."
    : "The file is then in the clear: anyone with a copy of it can read what it holds.";
}

/** Below this many characters a passphrase is called short. */
export const SHORT_PASSPHRASE = 10;
/** The longest passphrase taken. */
export const MAX_PASSPHRASE = 1024;
/** What an encrypted backup without a passphrase is told, on the page and by the extension. */
export const NO_PASSPHRASE = "Type a passphrase, or tick Don't encrypt.";

/** What stands between the passphrase fields and a save, in a sentence; none when they are fine. Unless "Don't encrypt" is ticked, a passphrase is wanted, whatever goes in. */
export function passphraseProblem(fields: { encrypt: boolean; passphrase: string; confirm: string }): string | undefined {
  if (!fields.encrypt) return undefined;
  if (fields.passphrase === "" && fields.confirm === "") return NO_PASSPHRASE;
  if ([...fields.passphrase].length > MAX_PASSPHRASE) return `The passphrase is longer than ${MAX_PASSPHRASE} characters.`;
  if (fields.confirm === "") return "Type the passphrase again to confirm it.";
  if (fields.passphrase !== fields.confirm) return "The two passphrases differ.";
  return undefined;
}

/** The section row's count, in words: "1,204 sessions", "52 notes on 31 sessions"; empty for a row with nothing. */
export function countText(row: SectionRow): string {
  if (row.count === 0) return "";
  if (row.detail) return row.detail;
  const unit = SECTION_INFO[row.id].unit;
  return unit ? count(row.count, unit[0], unit[1]) : "";
}

const DAYS: readonly Days[] = [7, 30, 90];

/** A choice as a message carries it, with anything it should not hold dropped; none for what is not one. */
export function readChoice(raw: unknown): BackupChoice | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const listed = Array.isArray(record.sections) ? record.sections : [];
  const days = DAYS.find((d) => d === record.days);
  return {
    sections: SECTIONS.filter((id) => listed.includes(id)),
    ...(days ? { days } : {}),
    skipRepos: Array.isArray(record.skipRepos) ? [...new Set(record.skipRepos.filter((repo): repo is string => typeof repo === "string"))] : [],
    level: record.level === "smaller" ? "smaller" : "fast",
    encrypt: record.encrypt !== false,
  };
}

/** A repository's folder name, for one named by its path. */
export function repoName(repo: string): string {
  const parts = repo.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? repo;
}
