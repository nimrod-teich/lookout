import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { BackgroundReads } from "./background";
import { firstMatchOf, holds, inRange, matchRanges, termsOf, type TimeRange } from "./terms";

export { termsOf, type TimeRange };

/** What one line of a conversation file holds for the search: a message, the paths a tool call worked on, or both; and, when asked for, what its tool calls ran and returned. */
export interface LineFacts {
  message?: HistoryMessage;
  paths?: string[];
  tools?: ToolText[];
}

/** A tool call's input, or its result, as the search keeps it: cut to its first and last 2 KB. */
export interface ToolText {
  /** The tool's name, for a call; none for a result. */
  name?: string;
  text: string;
  /** Epoch ms, when known. */
  at?: number;
}

/** The characters a tool text keeps at each end: an error is often at the end of long output, a command at the start. */
const TOOL_TEXT_END = 2048;

/** A tool's text as the search keeps it: whole when short, else its first and last 2 KB around an ellipsis; nothing for blank text. */
export function toolText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return trimmed.length <= 2 * TOOL_TEXT_END ? trimmed : `${trimmed.slice(0, TOOL_TEXT_END)} … ${trimmed.slice(-TOOL_TEXT_END)}`;
}

/**
 * How an agent's conversation files are read for the search. Most of a
 * file's bytes are lines that hold neither a message nor a path: requests,
 * tool output, attachments. `mayHold` rules those out on their raw bytes, so
 * they are never decoded nor parsed.
 */
export interface LineReader {
  /** Names the reader for the thread that reads in the background (see `LINE_READERS`); a reader without one is read where it is asked. */
  name?: string;
  /** The line can hold facts: false only for a line `facts` would find nothing in. */
  mayHold(line: Buffer): boolean;
  /** What a line holds. */
  facts(line: string): LineFacts | undefined;
  /** The tool calls and results of a line, read only when the search is asked to keep them: `mayHold` rules lines out on their bytes, as above. */
  tools?: { mayHold(line: Buffer): boolean; facts(line: string): ToolText[] | undefined };
}

/** A tool reader (see `LineReader.tools`) for files whose lines with tool calls or results each contain one of the needles. */
export function toolReaderOf(needles: readonly string[], facts: (line: string) => ToolText[] | undefined): NonNullable<LineReader["tools"]> {
  const bytes = needles.map((needle) => Buffer.from(needle));
  return { mayHold: (line) => bytes.some((needle) => line.includes(needle)), facts };
}

/** A reader for files whose lines with facts each contain one of the needles. */
export function readerOf(name: string, needles: readonly string[], facts: (line: string) => LineFacts | undefined): LineReader {
  const bytes = needles.map((needle) => Buffer.from(needle));
  return { name, mayHold: (line) => bytes.some((needle) => line.includes(needle)), facts };
}

/** A read of what a conversation file gained, as the thread that reads in the background gets it. */
export interface Scan {
  file: string;
  /** The reader's name. */
  reader: string;
  /** Where the last read stopped: after its last complete line. */
  from: number;
  /** The file's identity at the last read; another one means the file was replaced, and is read from its start. */
  identity: string;
  /**
   * For a file never read: where a window saved the places of its messages
   * (see `SavedPositions`), to read only those and what came after, and the
   * build of the reading code they must come from.
   */
  saved?: { entry: string; build: string };
  /**
   * The store the conversation goes into as it is read (see
   * `ConversationStore`): a file the store already holds is read from where
   * the store stopped, and the build of the reading code the rows must come
   * from.
   */
  store?: { file: string; build: string };
  /**
   * The index keeps no messages: they are in the store, which the read
   * writes, and the answer says only how far the file was read. A read the
   * store could not take is answered with nothing, and tried again.
   */
  lean?: boolean;
  /** Read the tool calls and their results too, into the store (see `LineReader.tools`). */
  tools?: boolean;
}

/** A line that holds facts, and where it sits in its file. */
export interface FactLine {
  facts: LineFacts;
  /** Its first byte in the file. */
  start: number;
  length: number;
  /**
   * For a line of paths alone: where each path is written in the file, as a
   * JSON string, start and length in turn, in the order of `facts.paths`;
   * none when one of them is not written as a plain string.
   */
  pathAt?: number[];
}

/** What a scan found. */
export interface Scanned {
  identity: string;
  /** The file's size when it was looked at. */
  size: number;
  /** Its modified time when it was looked at. */
  mtimeMs?: number;
  /** The file was replaced or cut short, or is read for the first time: `lines` hold its whole conversation, and what was read before goes. */
  reset: boolean;
  /** Where the next read starts. */
  end: number;
  lines: FactLine[];
  /** Its messages up to here were taken from the places a window saved, and only what came after was read. */
  restored?: number;
  /** What the file holds just before `end` (see `tailOf`); none when the file could not be read. */
  tail?: string;
  /**
   * A lean read the store could not take (it refused the write, or could
   * not be opened): the file was read whole, its lines are here, and the
   * index keeps them in memory from now on, so the conversation is still
   * found.
   */
  inMemory?: boolean;
}

/** Where a conversation's messages and paths sit in its file, as a window saved them: positions, no text. */
export interface SavedEntry extends Places {
  /** The build of the reading code that found them: another build may find more, and reads the file whole. */
  build: string;
}

/** Where an index found its messages and paths, and how far it read the file. */
export interface Places {
  v: 1;
  file: string;
  reader: string;
  identity: string;
  /** How far the file was read. */
  end: number;
  /** What the file held just before `end`: a file rewritten in place since does not match. */
  tail: string;
  /** Each message's line, start and length in turn, in the conversation's order. */
  messages: number[];
  /** Each path that a line of paths alone named, where it is written as a JSON string, start and length in turn. */
  paths: number[];
  /** The lines of paths alone whose paths are not all written as plain strings, start and length in turn. */
  pathLines: number[];
}

/**
 * Reads a conversation file from `from`, as the reader sees it; nothing when
 * the file cannot be read. A file never read (`from` 0, no identity) whose
 * `saved` places still fit it is read at those places, and from where they
 * end; a file that does not fit them is read whole.
 */
export function scanFile(file: string, reader: LineReader, from: number, identity: string, saved?: Places, tools = false): Scanned | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return undefined;
  }
  const now = `${st.ino}:${st.birthtimeMs}`;
  if (saved && from === 0 && identity === "" && saved.identity === now && saved.end <= st.size && saved.tail === tailOf(file, saved.end)) {
    const restored = restoreLines(file, reader, saved);
    if (restored) {
      const after = scanFile(file, reader, saved.end, now);
      if (after && !after.reset) return { identity: now, size: after.size, mtimeMs: after.mtimeMs, reset: true, end: after.end, lines: [...restored, ...after.lines], restored: saved.end, tail: after.tail };
    }
  }
  const reset = now !== identity || st.size < from;
  const start = reset ? 0 : from;
  const lines: FactLine[] = [];
  if (st.size === start) return { identity: now, size: st.size, mtimeMs: st.mtimeMs, reset, end: start, lines, tail: tailOf(file, start) };
  try {
    const end = readLines(file, start, reader, (line) => lines.push(line), tools);
    return { identity: now, size: st.size, mtimeMs: st.mtimeMs, reset, end, lines, tail: tailOf(file, end) };
  } catch {
    // A file that cannot be read (not ours to read, held by another process) is tried again once it changes,
    // not at every look; a replaced one is at least emptied of what was read before.
    return { identity: now, size: st.size, mtimeMs: st.mtimeMs, reset, end: start, lines: [] };
  }
}

/** The bytes a file's tail is known by: those just before `end`. */
const TAIL_BYTES = 4096;

/** A digest of what the file holds just before `end`; none when that cannot be read. */
export function tailOf(file: string, end: number): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const length = Math.min(end, TAIL_BYTES);
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, end - length) !== length) return undefined;
      return crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 20);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

const NEWLINE_BYTE = 0x0a;
/** What JSON writes just before a string (a value, an array item, a key) and just after it. */
const BEFORE_STRING = new Set([0x3a, 0x2c, 0x5b, 0x7b]);
const AFTER_STRING = new Set([0x2c, 0x7d, 0x5d, 0x3a]);

/** The lines at the saved places, read again; none when one of them no longer holds what it held. */
function restoreLines(file: string, reader: LineReader, saved: Places): FactLine[] | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  /** The bytes at the place, with the one before and the one after it to check where it sits. */
  const read = (start: number, length: number): { bytes: Buffer; before: number | undefined; after: number } | undefined => {
    const from = Math.max(0, start - 1);
    const buffer = Buffer.allocUnsafe(start - from + length + 1);
    if (fs.readSync(fd, buffer, 0, buffer.length, from) !== buffer.length) return undefined;
    return { bytes: buffer.subarray(start - from, start - from + length), before: start > 0 ? buffer[0] : undefined, after: buffer[buffer.length - 1]! };
  };
  /** A whole line sits there: it starts the file or follows a line's end, and a line's end follows it. */
  const line = (start: number, length: number): Buffer | undefined => {
    const at = read(start, length);
    return at && (at.before === undefined || at.before === NEWLINE_BYTE) && at.after === NEWLINE_BYTE ? at.bytes : undefined;
  };
  try {
    const lines: FactLine[] = [];
    for (let i = 0; i < saved.messages.length; i += 2) {
      const [start, length] = [saved.messages[i]!, saved.messages[i + 1]!];
      const bytes = line(start, length);
      const facts = bytes && reader.facts(bytes.toString("utf8"));
      if (!facts?.message) return undefined;
      lines.push({ facts, start, length });
    }
    for (let i = 0; i < saved.paths.length; i += 2) {
      const [start, length] = [saved.paths[i]!, saved.paths[i + 1]!];
      const at = read(start, length);
      // A string where JSON puts one: after a colon, a comma or an opening bracket, before a comma, a colon or a closing one.
      if (!at || at.before === undefined || !BEFORE_STRING.has(at.before) || !AFTER_STRING.has(at.after)) return undefined;
      let written: unknown;
      try {
        written = JSON.parse(at.bytes.toString("utf8"));
      } catch {
        return undefined;
      }
      if (typeof written !== "string" || written === "") return undefined;
      lines.push({ facts: { paths: [written] }, start, length, pathAt: [start, length] });
    }
    for (let i = 0; i < saved.pathLines.length; i += 2) {
      const [start, length] = [saved.pathLines[i]!, saved.pathLines[i + 1]!];
      const bytes = line(start, length);
      const facts = bytes && reader.facts(bytes.toString("utf8"));
      if (!facts?.paths?.length) return undefined;
      lines.push({ facts, start, length });
    }
    return lines;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Where each path is written in the line as a JSON string, start and length in turn; none when one is not written so. */
function pathsAt(line: Buffer, start: number, paths: readonly string[]): number[] | undefined {
  const at: number[] = [];
  for (const p of paths) {
    const written = Buffer.from(JSON.stringify(p));
    const found = line.indexOf(written);
    if (found < 0) return undefined;
    at.push(start + found, written.length);
  }
  return at;
}

const NEWLINE = 0x0a;
const CHUNK_BYTES = 1024 * 1024;

/** The reading code every index reads through, with the store the conversations go into, while a store is open. */
export interface ReadThrough {
  scan(job: Scan): Scanned | undefined;
  store: { file: string; build: string };
  /**
   * A conversation's messages from the store, oldest first. With this, the
   * indexes made from now on keep no messages of their own: the store is
   * the index, searched and read from where it is.
   */
  messages?(file: string): HistoryMessage[] | undefined;
  /** The lean indexes read the tool calls and their results too (see `LineReader.tools`). */
  tools?: boolean;
}

let through: ReadThrough | undefined;

/** Has every index read through the store from now on, or, with nothing, on its own again: a read on its own would leave the store behind. */
export function readThroughStore(next: ReadThrough | undefined): void {
  through = next;
}

/** A path as the index keeps it: lowercased, with forward slashes. */
function pathKey(p: string): string {
  return p.toLowerCase().replace(/\\/g, "/");
}

/** One message of a conversation, as the search sees it. */
export interface HistoryMessage {
  /** Who wrote it. */
  role: "you" | "agent";
  /** Epoch ms, when known. */
  at?: number;
  text: string;
}

export interface SearchHit {
  /** Position of the message in the conversation (for a tool's text, the message it follows); none for the session's note, which is no message. */
  index?: number;
  /** Who wrote it: the user, the agent, the user's note on the session, or a tool call or its result. */
  role: "you" | "agent" | "note" | "tool";
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
  // The earliest match of any term; of two at the same place, the longer.
  let first: [number, number] | undefined;
  for (const term of terms) {
    const match = firstMatchOf(lower, term);
    if (match && (!first || match[0] < first[0] || (match[0] === first[0] && match[1] > first[1]))) first = match;
  }
  const start = first ? Math.max(0, first[0] - size.before) : 0;
  // At least to the end of the first match: a long phrase is shown whole.
  const end = Math.min(text.length, first ? Math.max(first[0] + size.after, first[1]) : size.after);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return { snippet, ranges: matchRanges(snippet, terms) };
}

/**
 * Hands every complete line from `from` that holds facts to `onLine`, with
 * where it sits, reading in chunks so a large file never sits in memory
 * whole; a line the reader rules out is skipped undecoded. Returns the
 * offset after the last complete line; an unfinished last line is read again
 * next time.
 */
function readLines(file: string, from: number, reader: LineReader, onLine: (line: FactLine) => void, tools = false): number {
  const toolReader = tools ? reader.tools : undefined;
  const take = (line: Buffer, start: number) => {
    const holds = reader.mayHold(line);
    const holdsTools = toolReader?.mayHold(line) ?? false;
    if (!holds && !holdsTools) return;
    let facts: LineFacts | undefined;
    try {
      const text = line.toString("utf8");
      facts = holds ? reader.facts(text) : undefined;
      const found = holdsTools ? toolReader!.facts(text) : undefined;
      if (found?.length) facts = { ...(facts ?? {}), tools: found };
    } catch {
      // A line the reader cannot take is skipped, not the rest of the file.
      return;
    }
    if (!facts) return;
    const found: FactLine = { facts, start, length: line.length };
    if (!facts.message && facts.paths?.length) {
      const at = pathsAt(line, start, facts.paths);
      if (at) found.pathAt = at;
    }
    onLine(found);
  };
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let offset = from;
    // The start of a line that runs on past the chunks read: copies, since the chunk is read into again.
    let carried: Buffer[] = [];
    let carriedBytes = 0;
    let carriedStart = 0;
    for (;;) {
      const chunkStart = offset;
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
        take(Buffer.concat([...carried, data.subarray(0, nl)]), carriedStart);
        carried = [];
        carriedBytes = 0;
        lineStart = nl + 1;
        nl = data.indexOf(NEWLINE, lineStart);
      }
      for (; nl >= 0; nl = data.indexOf(NEWLINE, lineStart)) {
        take(data.subarray(lineStart, nl), chunkStart + lineStart);
        lineStart = nl + 1;
      }
      if (lineStart < got) {
        carried = [Buffer.from(data.subarray(lineStart))];
        carriedBytes = got - lineStart;
        carriedStart = chunkStart + lineStart;
      }
    }
    return offset - carriedBytes;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The messages of one conversation file, for searching. The file is read
 * once, then only what was appended; a replaced or truncated file is read
 * again from the start. While the store is the index (see `ReadThrough`),
 * the index keeps only how far the file was read, and its messages are the
 * store's; else it keeps them in memory.
 */
export class HistoryIndex {
  private readonly held: HistoryMessage[] = [];
  /** Each message's text lowercased, whitespace runs made one space, once, for matching. */
  private readonly lowered: string[] = [];
  /** The messages are the store's, read from it when asked for; none are kept here. */
  private leanNow: boolean;
  /** The store's messages as last read, until the next read changes them. */
  private fromStore: HistoryMessage[] | undefined;
  /** The store could not take a read of this file: the index keeps it in memory, and is searched there. */
  private fellBack = false;
  /** The file's modified time at the last read. */
  private seenMtimeMs: number | undefined;
  /** The last read took the tool calls and their results too. */
  private readTools = false;
  /** The paths the conversation's tool calls worked on, lowercased, with forward slashes. */
  readonly paths = new Set<string>();
  private offset = 0;
  private identity = "";
  /** The file's size at the last read: a file whose last line is unfinished is not read again until it changes. */
  private seenSize = -1;
  /** Where each message's line sits, start and length in turn, in the order of `messages`. */
  private readonly messageAt: number[] = [];
  /** Where each path that a line of paths alone named first is written, start and length in turn. */
  private readonly pathAt: number[] = [];
  /** The lines of paths alone whose new paths are not all written as plain strings, start and length in turn. */
  private readonly pathLineAt: number[] = [];
  /** What the file held just before `offset`, at the last read. */
  private tail: string | undefined;

  constructor(
    readonly file: string,
    private readonly reader: LineReader,
  ) {
    this.leanNow = through?.messages !== undefined && reader.name !== undefined;
  }

  /** The messages are the store's, read from it when asked for; none are kept here. False from the moment the store could not take a read of the file. */
  get lean(): boolean {
    return this.leanNow;
  }

  /** The store could not take a read of the file, and the index keeps it in memory instead: search it there, not in what the store holds of it. */
  get keptInMemory(): boolean {
    return this.fellBack;
  }

  /** The conversation's messages, oldest first: the store's for a lean index (read once until the next read changes them), else the ones read into memory. */
  get messages(): HistoryMessage[] {
    if (!this.lean) return this.held;
    this.fromStore ??= through?.messages?.(this.file);
    return this.fromStore ?? [];
  }

  /** The file was read at least once, as the store wants it read now; before that a refresh reads it (whole, or for its tool output). */
  get ready(): boolean {
    return this.identity !== "" && !this.toolsBehind;
  }

  /** The tool output is wanted and the last read did not take it, or the other way round. */
  private get toolsBehind(): boolean {
    return this.lean && (through?.tools === true) !== this.readTools;
  }

  /** Reads what the file gained since the last call, here and now: through the store while one is open, so the store follows. */
  refresh(): void {
    const job = this.scan();
    if (through && job) {
      job.store = through.store;
      const scanned = through.scan(job);
      if (scanned) this.apply(scanned, job);
      return;
    }
    const direct = { file: this.file, reader: this.reader.name ?? "", from: this.offset, identity: this.identity };
    const scanned = scanFile(this.file, this.reader, this.offset, this.identity);
    if (scanned) this.apply(scanned, direct);
  }

  /**
   * Reads what the file gained: in the background when `background` is given
   * and the reader has a name, else here and now. A file that did not change
   * since it was last read is not read. `urgent` (a live session's, or one in
   * view) goes ahead of the reads already waiting.
   */
  update(background?: BackgroundReads, urgent = false): void {
    if (!background || !this.reader.name) {
      this.refresh();
      return;
    }
    if ((urgent || !background.has(this)) && this.changed()) background.read(this, urgent);
  }

  /**
   * The file was read, and was last written when the read saw it: a list
   * that says when each file was last written tells which need a look
   * without one being taken here.
   */
  seenAt(modifiedAt: number | undefined): boolean {
    return this.ready && modifiedAt !== undefined && this.seenMtimeMs !== undefined && Math.round(this.seenMtimeMs) === modifiedAt;
  }

  /** Forgets how far the file was read: the next read takes it from its start. */
  forgetPlace(): void {
    this.fromStore = undefined;
    this.replaceMessages([]);
    this.paths.clear();
    this.messageAt.length = 0;
    this.pathAt.length = 0;
    this.pathLineAt.length = 0;
    this.offset = 0;
    this.identity = "";
    this.seenSize = -1;
    this.seenMtimeMs = undefined;
    this.tail = undefined;
    this.readTools = false;
  }

  /** The file is not as it was at the last read: replaced, grown or cut short, or never read. */
  changed(): boolean {
    if (this.toolsBehind) return true;
    try {
      const st = fs.statSync(this.file);
      return `${st.ino}:${st.birthtimeMs}` !== this.identity || st.size !== this.seenSize;
    } catch {
      return false;
    }
  }

  /** The read that takes the index from where it is; none for a reader without a name. */
  scan(): Scan | undefined {
    if (!this.reader.name) return undefined;
    const job: Scan = { file: this.file, reader: this.reader.name, from: this.offset, identity: this.identity };
    if (this.lean) job.lean = true;
    if (this.lean && through?.tools === true) job.tools = true;
    return job;
  }

  /** Takes in what a scan found, unless the index moved since the scan was asked for; true when it did. */
  apply(scanned: Scanned, job: Scan): boolean {
    if (job.from !== this.offset || job.identity !== this.identity) return false;
    this.fromStore = undefined;
    // The store could not take the read: this conversation is kept in memory from now on.
    if (scanned.inMemory && this.leanNow) {
      this.leanNow = false;
      this.fellBack = true;
    }
    if (scanned.reset) {
      this.replaceMessages([]);
      this.paths.clear();
      this.messageAt.length = 0;
      this.pathAt.length = 0;
      this.pathLineAt.length = 0;
    }
    // A lean index takes no lines: they went into the store.
    if (!this.lean) for (const line of scanned.lines) this.record(line);
    this.offset = scanned.end;
    this.identity = scanned.identity;
    this.seenSize = scanned.size;
    this.seenMtimeMs = scanned.mtimeMs;
    this.tail = scanned.tail;
    this.readTools = job.tools === true;
    return true;
  }

  private record({ facts, start, length, pathAt }: FactLine): void {
    if (facts.message) {
      this.add(facts.message);
      this.messageAt.push(start, length);
    }
    const paths = facts.paths ?? [];
    // A message's line is read again for its message, and gives its paths back with it.
    const fresh = facts.message ? [] : paths.map((p, i) => ({ key: pathKey(p), i })).filter(({ key }, n, all) => !this.paths.has(key) && all.findIndex((other) => other.key === key) === n);
    if (fresh.length > 0) {
      if (pathAt) for (const { i } of fresh) this.pathAt.push(pathAt[2 * i]!, pathAt[2 * i + 1]!);
      else this.pathLineAt.push(start, length);
    }
    for (const p of paths) this.paths.add(pathKey(p));
  }

  /** Where its messages and paths sit in the file, for the next window; none before the file is read, or after a read that failed. */
  places(): Places | undefined {
    if (!this.reader.name || !this.ready || this.tail === undefined) return undefined;
    return { v: 1, file: this.file, reader: this.reader.name, identity: this.identity, end: this.offset, tail: this.tail, messages: [...this.messageAt], paths: [...this.pathAt], pathLines: [...this.pathLineAt] };
  }

  /** Holds these messages instead of the ones it held. */
  protected replaceMessages(messages: readonly HistoryMessage[]): void {
    this.held.length = 0;
    this.lowered.length = 0;
    for (const message of messages) this.add(message);
  }

  private add(message: HistoryMessage): void {
    this.held.push(message);
    this.lowered.push(message.text.toLowerCase().replace(/\s+/g, " "));
  }

  /** The messages containing every term, written within `range`, newest first; `limit` of them cut into snippets. */
  search(terms: string[], limit: number, range?: TimeRange, size?: SnippetSize): { count: number; hits: SearchHit[] } {
    if (terms.length === 0) return { count: 0, hits: [] };
    let count = 0;
    const hits: SearchHit[] = [];
    for (let i = this.held.length - 1; i >= 0; i--) {
      const message = this.held[i]!;
      if (!inRange(message.at, range)) continue;
      const lower = this.lowered[i]!;
      if (!terms.every((term) => (term.includes(" ") ? holds(lower, term) : lower.includes(term)))) continue;
      count++;
      if (hits.length < limit) hits.push({ index: i, role: message.role, at: message.at, ...snippetOf(message.text, terms, size) });
    }
    return { count, hits };
  }

  /** A message was written within the range. */
  hasMessageIn(range: TimeRange): boolean {
    return this.held.some((message) => inRange(message.at, range));
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
