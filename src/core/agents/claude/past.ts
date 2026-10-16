import * as fs from "node:fs";
import * as path from "node:path";
import { findLastLine, readLineAt } from "../../jsonlTail";
import { INTERRUPT } from "./transcript";
import { encodeProjectDir } from "./paths";

/** A session that is not running: its transcript is all there is. */
export interface PastTranscript {
  id: string;
  file: string;
  cwd: string;
  title: string;
  /** Epoch ms the transcript was last written. */
  modifiedAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The generated title and the first prompt are within the first lines. */
const HEAD_BYTES = 64 * 1024;
/** Titles are stamped again on resume, and renames appended, at the end. */
const TAIL_SEARCH_BYTES = 256 * 1024;
const PROMPT_MAX = 80;

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const entry: unknown = JSON.parse(line);
    return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function titleIn(entry: Record<string, unknown>, key: "customTitle" | "aiTitle"): string | undefined {
  const value = entry[key];
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() || undefined : undefined;
}

function promptIn(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) return undefined;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") return undefined;
  const text = content.trim();
  if (text === "" || text.startsWith("<") || text.startsWith(INTERRUPT)) return undefined;
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > PROMPT_MAX ? `${line.slice(0, PROMPT_MAX - 1)}…` : line;
}

/** Reads the first lines of a transcript. */
function head(file: string): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const got = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const lines = buffer.toString("utf8", 0, got).split("\n");
    if (got === HEAD_BYTES) lines.pop();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A transcript's title: a rename, else the generated title, else the first
 * prompt; nothing for a transcript that holds no conversation. The head is
 * read for the early stamps, the tail for the latest ones.
 */
export function transcriptTitle(file: string): string | undefined {
  let custom: string | undefined;
  let ai: string | undefined;
  let prompt: string | undefined;
  for (const line of head(file)) {
    const entry = parse(line);
    if (!entry) continue;
    if (entry.type === "custom-title") custom = titleIn(entry, "customTitle") ?? custom;
    else if (entry.type === "ai-title") ai = titleIn(entry, "aiTitle") ?? ai;
    else if (prompt === undefined) prompt = promptIn(entry);
  }
  for (const [type, key] of [
    ["custom-title", "customTitle"],
    ["ai-title", "aiTitle"],
  ] as const) {
    const at = findLastLine(file, `"type":"${type}"`, TAIL_SEARCH_BYTES);
    if (at === undefined) continue;
    const line = readLineAt(file, at);
    const entry = line === undefined ? undefined : parse(line);
    if (!entry || entry.type !== type) continue;
    const title = titleIn(entry, key);
    // The latest stamp wins, even when it clears a rename.
    if (key === "customTitle") custom = title;
    else if (title) ai = title;
  }
  return custom ?? ai ?? prompt;
}

/** The transcripts of a project that are not running, with their titles; titles are read once per file version. */
export class PastTranscripts {
  private readonly titles = new Map<string, { mtimeMs: number; size: number; title: string | undefined }>();

  constructor(private readonly configDir: string) {}

  /** Newest first, without the ids in `exclude` (the live and the archived) and without transcripts that hold no conversation. */
  list(cwds: readonly string[], exclude: ReadonlySet<string>): PastTranscript[] {
    const out: PastTranscript[] = [];
    const seen = new Set<string>();
    for (const cwd of cwds) {
      const dir = path.join(this.configDir, "projects", encodeProjectDir(cwd));
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -".jsonl".length);
        if (!UUID.test(id) || exclude.has(id) || seen.has(id)) continue;
        const file = path.join(dir, name);
        let st: fs.Stats;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile() || st.size === 0) continue;
        let cached = this.titles.get(file);
        if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
          let title: string | undefined;
          try {
            title = transcriptTitle(file);
          } catch {
            title = undefined;
          }
          cached = { mtimeMs: st.mtimeMs, size: st.size, title };
          this.titles.set(file, cached);
        }
        if (!cached.title) continue;
        seen.add(id);
        out.push({ id, file, cwd, title: cached.title, modifiedAt: Math.round(st.mtimeMs) });
      }
    }
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }
}
