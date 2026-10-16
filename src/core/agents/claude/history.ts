import type { HistoryMessage, LineFacts } from "../../history";
import { INTERRUPT } from "./transcript";

interface Block {
  type?: unknown;
  text?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
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
