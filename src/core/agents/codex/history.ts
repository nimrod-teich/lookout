// What a rollout line holds for the search and the conversation tab: what you
// wrote, what Codex replied, and the files its commands read or changed.
import { readerOf, toolReaderOf, toolText, type LineFacts, type ToolText } from "../../history";
import { isContext } from "./rollout";

interface Part {
  type?: unknown;
  text?: unknown;
}

function textOf(content: unknown, kind: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return "";
  return (content as Part[])
    .filter((part) => part?.type === kind && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

const MESSAGE = '"type":"message"';
const FILE_CHANGE = '"FileChange"';
const COMMAND = '"CommandExecution"';

/**
 * The message or the paths a rollout line holds. Messages are the
 * `response_item` messages: yours (without the context Codex adds, such as
 * `<environment_context>`) and Codex's, its progress notes and its answers.
 * Paths come from `item_completed` items: a `FileChange`'s changed files and
 * the paths of the commands Codex parsed as reads, listings and searches
 * (`parsed_cmd`). Tool output is never read for paths.
 */
export function factsOf(line: string): LineFacts | undefined {
  // Cheap gates before parsing: most of a rollout's bytes are context, tool calls and their output.
  const message = line.includes(MESSAGE);
  const change = line.includes(FILE_CHANGE);
  const command = line.includes(COMMAND);
  if (!message && !change && !command) return undefined;
  let record: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object" || !record.payload) return undefined;
  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  const when = Number.isFinite(at) ? at : undefined;
  const payload = record.payload;
  if (record.type === "response_item" && payload.type === "message") {
    if (payload.role === "user") {
      const text = textOf(payload.content, "input_text").trim();
      return text && !isContext(text) ? { message: { role: "you", at: when, text } } : undefined;
    }
    if (payload.role === "assistant") {
      const text = textOf(payload.content, "output_text").trim();
      return text ? { message: { role: "agent", at: when, text } } : undefined;
    }
    return undefined;
  }
  if (record.type !== "event_msg" || payload.type !== "item_completed") return undefined;
  const item = payload.item as { type?: unknown; changes?: unknown; parsed_cmd?: unknown } | undefined;
  const paths: string[] = [];
  if (item?.type === "FileChange" && item.changes && typeof item.changes === "object") paths.push(...Object.keys(item.changes));
  if (item?.type === "CommandExecution" && Array.isArray(item.parsed_cmd)) {
    for (const parsed of item.parsed_cmd as { path?: unknown }[]) if (typeof parsed?.path === "string" && parsed.path.trim()) paths.push(parsed.path);
  }
  return paths.length ? { paths } : undefined;
}

const TOOL_CALL = '"type":"custom_tool_call"';
const FUNCTION_CALL = '"type":"function_call"';
const TOOL_OUTPUT = '"type":"custom_tool_call_output"';
const FUNCTION_OUTPUT = '"type":"function_call_output"';

/** An output's text: a string, or its text parts. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return (output as Part[])
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * The tool calls and results of a rollout line: a call's input or
 * arguments with the tool's name, and an output's text, cut to their first
 * and last 2 KB.
 */
export function toolFactsOf(line: string): ToolText[] | undefined {
  let record: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return undefined;
  }
  if (!record || record.type !== "response_item" || !record.payload) return undefined;
  const parsed = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  const at = Number.isFinite(parsed) ? { at: parsed } : {};
  const payload = record.payload;
  if (payload.type === "custom_tool_call" || payload.type === "function_call") {
    const input = payload.type === "custom_tool_call" ? payload.input : payload.arguments;
    const text = toolText(typeof input === "string" ? input : JSON.stringify(input ?? {}));
    const name = typeof payload.name === "string" ? payload.name : undefined;
    return text ? [{ ...(name ? { name } : {}), text, ...at }] : undefined;
  }
  if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
    const text = toolText(outputText(payload.output));
    return text ? [{ text, ...at }] : undefined;
  }
  return undefined;
}

/** How the search reads a rollout: a line without one of `factsOf`'s needles is never decoded. */
export const ROLLOUT_LINES = { ...readerOf("codex-rollout", [MESSAGE, FILE_CHANGE, COMMAND], factsOf), tools: toolReaderOf([TOOL_CALL, FUNCTION_CALL, TOOL_OUTPUT, FUNCTION_OUTPUT], toolFactsOf) };
