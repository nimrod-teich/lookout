import type { HistoryMessage, LineFacts, LineReader } from "../../history";
import { INTERRUPT } from "./transcript";

interface Block {
  type?: unknown;
  text?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * The message a transcript line holds, when the user or the agent wrote it.
 * Tool calls and their results are not messages, nor are slash-command
 * echoes, interrupts, or subagent traffic.
 */
export function messageOf(line: string): HistoryMessage | undefined {
  return factsOf(line)?.message;
}

/** The input fields of a tool call that name what it works on. */
const PATH_FIELDS = ["file_path", "path", "pattern", "notebook_path"];

/**
 * What a transcript line holds for the search: the message you or the agent
 * wrote, and the paths the main chain's tool calls worked on. Tool results
 * are skipped unread.
 */
export function factsOf(line: string): LineFacts | undefined {
  // Cheap gates before parsing: most of a transcript's bytes are tool results.
  const user = line.includes('"type":"user"');
  if (!user && !line.includes('"type":"assistant"')) return undefined;
  if (user && line.includes('"type":"tool_result"')) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  if ((e.type !== "user" && e.type !== "assistant") || e.isSidechain === true || e.isMeta === true) return undefined;
  const content = (e.message as { content?: unknown } | undefined)?.content;
  const facts: LineFacts = {};
  if (e.type === "assistant" && Array.isArray(content)) {
    const paths: string[] = [];
    for (const block of content as { type?: unknown; input?: unknown }[]) {
      if (block?.type !== "tool_use" || typeof block.input !== "object" || block.input === null) continue;
      for (const field of PATH_FIELDS) {
        const value = (block.input as Record<string, unknown>)[field];
        if (typeof value === "string" && value.trim() !== "") paths.push(value);
      }
    }
    if (paths.length) facts.paths = paths;
  }
  const text = textOf(content).trim();
  if (text !== "" && !text.startsWith(INTERRUPT) && !text.startsWith("<command-") && !text.startsWith("<local-command-")) {
    const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    facts.message = { role: e.type === "user" ? "you" : "agent", at: Number.isFinite(at) ? at : undefined, text };
  }
  return facts.message || facts.paths ? facts : undefined;
}

/** How Claude Code starts the records it writes besides the conversation's entries: their type first. */
const TYPE_FIRST = Buffer.from('{"type":"');
const USER_VALUE = Buffer.from('user"');
const ASSISTANT_VALUE = Buffer.from('assistant"');
const USER = Buffer.from('"type":"user"');
const TOOL_RESULT = Buffer.from('"type":"tool_result"');
const ASSISTANT = Buffer.from('"type":"assistant"');
const TEXT = Buffer.from('"type":"text"');
const TOOL_USE = Buffer.from('"type":"tool_use"');
const STRING_CONTENT = Buffer.from('"content":"');
/** A tool call's input field that names a path, as it is written: a tool call without one names no path. */
const PATH_NEEDLES = PATH_FIELDS.map((field) => Buffer.from(`"${field}":"`));

/**
 * Whether a transcript line can hold what `factsOf` takes, judged on its
 * bytes: a line of yours that is not a tool result, or a reply with text,
 * plain string content, or a tool call naming a path. A reply of thinking
 * alone, or of a command, holds neither words nor paths. Request records,
 * attachments and tool results, most of a transcript, are ruled out without
 * being decoded; a record that names another type in its first key, from its
 * first bytes alone.
 */
export function mayHoldFacts(line: Buffer): boolean {
  // A record whose first key is its type says so in its first bytes: a request record, a title, a snapshot.
  if (line.subarray(0, TYPE_FIRST.length).equals(TYPE_FIRST)) {
    const value = line.subarray(TYPE_FIRST.length);
    if (!startsWith(value, USER_VALUE) && !startsWith(value, ASSISTANT_VALUE)) return false;
  }
  if (line.includes(USER)) return !line.includes(TOOL_RESULT);
  if (!line.includes(ASSISTANT)) return false;
  return line.includes(TEXT) || line.includes(STRING_CONTENT) || (line.includes(TOOL_USE) && PATH_NEEDLES.some((needle) => line.includes(needle)));
}

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

/** How the search reads a transcript. */
export const TRANSCRIPT_LINES: LineReader = { mayHold: mayHoldFacts, facts: factsOf };
