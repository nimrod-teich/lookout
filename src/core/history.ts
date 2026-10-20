import * as fs from "node:fs";
import { inRange, matchRanges, termsOf, type TimeRange } from "./terms";

export { termsOf, type TimeRange };

/** What one line of a conversation file holds for the search: a message, the paths a tool call worked on, or both. */
export interface LineFacts {
  message?: HistoryMessage;
  paths?: string[];
}

/**
 * How an agent's conversation files are read for the search. Most of a
 * file's bytes are lines that hold neither a message nor a path: requests,
 * tool output, attachments. `mayHold` rules those out on their raw bytes, so
 * they are never decoded nor parsed.
 */
export interface LineReader {
  /** The line can hold facts: false only for a line `facts` would find nothing in. */
  mayHold(line: Buffer): boolean;
  /** What a line holds. */
  facts(line: string): LineFacts | undefined;
}

/** A reader for files whose lines with facts each contain one of the needles. */
export function readerOf(needles: readonly string[], facts: (line: string) => LineFacts | undefined): LineReader {
  const bytes = needles.map((needle) => Buffer.from(needle));
  return { mayHold: (line) => bytes.some((needle) => line.includes(needle)), facts };
}

const NEWLINE = 0x0a;
const CHUNK_BYTES = 1024 * 1024;

/** One message of a conversation, as the search sees it. */
export interface HistoryMessage {
  /** Who wrote it. */
  role: "you" | "agent";
  /** Epoch ms, when known. */
  at?: number;
  text: string;
}

export interface SearchHit {
  /** Position of the message in the conversation. */
  index: number;
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

/** Characters a snippet keeps before and after the first match. */
export interface SnippetSize {
  before: number;
  after: number;
}

/** For a card: few before, so the match sits on the first line of a narrow card. */
export const CARD_SNIPPET: SnippetSize = { before: 24, after: 96 };
/** For the search page, which has the width for the sentence around a match. */
export const PAGE_SNIPPET: SnippetSize = { before: 120, after: 360 };

/** Cuts a message around its first match and marks every term in the cut. */
export function snippetOf(text: string, terms: string[], size: SnippetSize = CARD_SNIPPET): { snippet: string; ranges: [number, number][] } {
  const lower = text.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  const start = first < 0 ? 0 : Math.max(0, first - size.before);
  const end = Math.min(text.length, (first < 0 ? 0 : first) + size.after);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return { snippet, ranges: matchRanges(snippet, terms) };
}

/**
 * Hands the facts of every complete line from `from` to `onFacts`, reading
 * in chunks so a large file never sits in memory whole; a line the reader
 * rules out is skipped undecoded. Returns the offset after the last complete
 * line; an unfinished last line is read again next time.
 */
function readLines(file: string, from: number, reader: LineReader, onFacts: (facts: LineFacts) => void): number {
  const take = (line: Buffer) => {
    if (!reader.mayHold(line)) return;
    let facts: LineFacts | undefined;
    try {
      facts = reader.facts(line.toString("utf8"));
    } catch {
      // A line the reader cannot take is skipped, not the rest of the file.
      return;
    }
    if (facts) onFacts(facts);
  };
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let offset = from;
    // The start of a line that runs on past the chunks read: copies, since the chunk is read into again.
    let carried: Buffer[] = [];
    let carriedBytes = 0;
    for (;;) {
      const got = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (got === 0) break;
      offset += got;
      const data = chunk.subarray(0, got);
      let lineStart = 0;
      let nl = data.indexOf(NEWLINE);
      if (carriedBytes > 0) {
        if (nl < 0) {
          carried.push(Buffer.from(data));
          carriedBytes += got;
          continue;
        }
        // Only the line that began in an earlier chunk is put together; the rest is read where it lies.
        take(Buffer.concat([...carried, data.subarray(0, nl)]));
        carried = [];
        carriedBytes = 0;
        lineStart = nl + 1;
        nl = data.indexOf(NEWLINE, lineStart);
      }
      for (; nl >= 0; nl = data.indexOf(NEWLINE, lineStart)) {
        take(data.subarray(lineStart, nl));
        lineStart = nl + 1;
      }
      if (lineStart < got) {
        carried = [Buffer.from(data.subarray(lineStart))];
        carriedBytes = got - lineStart;
      }
    }
    return offset - carriedBytes;
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
  /** Each message's text lowercased, once, for matching. */
  private readonly lowered: string[] = [];
  /** The paths the conversation's tool calls worked on, lowercased, with forward slashes. */
  readonly paths = new Set<string>();
  private offset = 0;
  private identity = "";

  constructor(
    private readonly file: string,
    private readonly reader: LineReader,
  ) {}

  /** The file was read at least once; before that a refresh reads it whole. */
  get ready(): boolean {
    return this.identity !== "";
  }

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
      this.replaceMessages([]);
      this.paths.clear();
      this.offset = 0;
      this.identity = identity;
    }
    if (st.size === this.offset) return;
    try {
      this.offset = readLines(this.file, this.offset, this.reader, (facts) => {
        if (facts.message) this.add(facts.message);
        for (const p of facts.paths ?? []) this.paths.add(p.toLowerCase().replace(/\\/g, "/"));
      });
    } catch {
      // Read again next time.
    }
  }

  /** Holds these messages instead of the ones it held. */
  protected replaceMessages(messages: readonly HistoryMessage[]): void {
    this.messages.length = 0;
    this.lowered.length = 0;
    for (const message of messages) this.add(message);
  }

  private add(message: HistoryMessage): void {
    this.messages.push(message);
    this.lowered.push(message.text.toLowerCase());
  }

  /** The messages containing every term, written within `range`, newest first; `limit` of them cut into snippets. */
  search(terms: string[], limit: number, range?: TimeRange, size?: SnippetSize): { count: number; hits: SearchHit[] } {
    if (terms.length === 0) return { count: 0, hits: [] };
    let count = 0;
    const hits: SearchHit[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!;
      if (!inRange(message.at, range)) continue;
      const lower = this.lowered[i]!;
      if (!terms.every((term) => lower.includes(term))) continue;
      count++;
      if (hits.length < limit) hits.push({ index: i, role: message.role, at: message.at, ...snippetOf(message.text, terms, size) });
    }
    return { count, hits };
  }

  /** A message was written within the range. */
  hasMessageIn(range: TimeRange): boolean {
    return this.messages.some((message) => inRange(message.at, range));
  }

  /** A tool call worked on a path that contains any of the parts (lowercased, forward slashes). */
  touched(parts: readonly string[]): boolean {
    for (const p of this.paths) if (parts.some((part) => p.includes(part))) return true;
    return false;
  }
}

/**
 * An agent's conversation indexes, one per file, whether its session runs or
 * not: a session that ends or is resumed keeps what was read of it.
 */
export class HistoryIndexes {
  private readonly byFile = new Map<string, HistoryIndex>();

  constructor(private readonly reader: LineReader) {}

  /** The file's index, made on first use. */
  of(file: string): HistoryIndex {
    let index = this.byFile.get(file);
    if (!index) {
      index = new HistoryIndex(file, this.reader);
      this.byFile.set(file, index);
    }
    return index;
  }

  /** Forgets every index but those of these files: the sessions running or listed. */
  keepOnly(files: Iterable<string>): void {
    const kept = new Set(files);
    for (const file of [...this.byFile.keys()]) if (!kept.has(file)) this.byFile.delete(file);
  }
}
