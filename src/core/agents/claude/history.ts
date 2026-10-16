import type { HistoryMessage } from "../../history";
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
  const text = textOf((e.message as { content?: unknown } | undefined)?.content).trim();
  if (text === "" || text.startsWith(INTERRUPT) || text.startsWith("<command-") || text.startsWith("<local-command-")) return undefined;
  const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  return { role: e.type === "user" ? "you" : "agent", at: Number.isFinite(at) ? at : undefined, text };
}
