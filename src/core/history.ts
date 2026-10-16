import * as fs from "node:fs";

const NEWLINE = 0x0a;

/** One message of a conversation, as the search sees it. */
export interface HistoryMessage {
  /** Who wrote it. */
  role: "you" | "agent";
  /** Epoch ms, when known. */
  at?: number;
  text: string;
}

export interface SearchHit {
  role: "you" | "agent";
  at?: number;
  /** The matching message, cut around its first match, whitespace collapsed. */
  snippet: string;
  /** [start, end) of every term in the snippet, in order, none overlapping. */
  ranges: [number, number][];
}

export interface SearchResult {
  /** Session id. */
  id: string;
  /** How many messages match. */
  count: number;
  /** The newest matching messages, up to the limit asked for. */
  hits: SearchHit[];
}

/** The words of a query, lowercased. A message matches when it contains every one of them. */
export function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Characters kept before and after the first match: few before, so the match sits on the first line of a narrow card. */
const BEFORE = 24;
const AFTER = 96;

/** Cuts a message around its first match and marks every term in the cut. */
export function snippetOf(text: string, terms: string[]): { snippet: string; ranges: [number, number][] } {
  const lower = text.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  const start = first < 0 ? 0 : Math.max(0, first - BEFORE);
  const end = Math.min(text.length, (first < 0 ? 0 : first) + AFTER);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  const snippetLower = snippet.toLowerCase();
  const found: [number, number][] = [];
  for (const term of terms) {
    for (let at = snippetLower.indexOf(term); at >= 0; at = snippetLower.indexOf(term, at + term.length)) found.push([at, at + term.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const ranges: [number, number][] = [];
  for (const range of found) {
    const last = ranges.at(-1);
    if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([range[0], range[1]]);
  }
  return { snippet, ranges };
}

/**
 * Hands every complete line from `from` to `onLine`, reading in chunks so a
 * large file never sits in memory whole. Returns the offset after the last
 * complete line; an unfinished last line is read again next time.
 */
function readLines(file: string, from: number, onLine: (line: string) => void): number {
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let offset = from;
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const got = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (got === 0) break;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, got)]) : Buffer.from(chunk.subarray(0, got));
      let lineStart = 0;
      for (let nl = data.indexOf(NEWLINE); nl >= 0; nl = data.indexOf(NEWLINE, lineStart)) {
        onLine(data.toString("utf8", lineStart, nl));
        lineStart = nl + 1;
      }
      carry = Buffer.from(data.subarray(lineStart));
      offset += got;
    }
    return offset - carry.length;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The messages of one conversation file, kept in memory for searching. The
 * file is read once, then only what was appended; a replaced or truncated
 * file is read again from the start.
 */
export class HistoryIndex {
  readonly messages: HistoryMessage[] = [];
  private offset = 0;
  private identity = "";

  constructor(
    private readonly file: string,
    /** Turns one line into a message, or nothing for lines that hold none. */
    private readonly parse: (line: string) => HistoryMessage | undefined,
  ) {}

  /** Reads what the file gained since the last call. */
  refresh(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      return;
    }
    const identity = `${st.ino}:${st.birthtimeMs}`;
    if (identity !== this.identity || st.size < this.offset) {
      this.messages.length = 0;
      this.offset = 0;
      this.identity = identity;
    }
    if (st.size === this.offset) return;
    try {
      this.offset = readLines(this.file, this.offset, (line) => {
        const message = this.parse(line);
        if (message) this.messages.push(message);
      });
    } catch {
      // Read again next time.
    }
  }

  /** The messages containing every term, newest first; `limit` of them cut into snippets. */
  search(terms: string[], limit: number): { count: number; hits: SearchHit[] } {
    if (terms.length === 0) return { count: 0, hits: [] };
    let count = 0;
    const hits: SearchHit[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!;
      const lower = message.text.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      count++;
      if (hits.length < limit) hits.push({ role: message.role, at: message.at, ...snippetOf(message.text, terms) });
    }
    return { count, hits };
  }
}
