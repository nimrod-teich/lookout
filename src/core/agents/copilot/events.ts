// What a Copilot CLI session's events say, read line by line.
//
// `<COPILOT_HOME>/session-state/<id>/events.jsonl` is one event per line:
// `{ type, data, id, timestamp, parentId }`. Lookout reads:
//
// - `session.start`: the cwd and Copilot's version.
// - `user.message` (`content`): what you wrote.
// - `assistant.message` (`content`, `toolRequests`, `model`): what Copilot
//   replied, and the tools it asked for.
// - `tool.execution_start` / `tool.execution_complete`: a tool call running.
// - `permission.requested` (`permissionRequest`: `kind` "shell" with
//   `fullCommandText`, "write" with `fileName`, and Copilot's `intention`) and
//   `permission.completed` (same `requestId`): an approval prompt, open until
//   answered.
// - `session.usage_record` (`usage`: model, input, output and cache tokens,
//   `maxPromptTokens`, `reasoningEffort`): one call of the session's model, its
//   tokens, how many input tokens the model takes, and the effort. (The
//   `model.*` events are Copilot's helper models, such as the one that names
//   the session, and are left out.)
import { readerOf, toolReaderOf, toolText, type HistoryMessage, type LineFacts, type ToolText } from "../../history";
import { quoteAsk } from "../../asks";
import type { Reason } from "../../types";

export interface CopilotState {
  cwd?: string;
  firstPrompt?: string;
  /** Epoch ms of the last message you wrote. */
  promptAt?: number;
  /** Copilot's last reply with text, and when. */
  lastReply?: { text: string; at: number };
  /** Approval prompts not answered yet, by request id. */
  permissions: Map<string, { at: number; reason: Reason }>;
  /** Tool calls without their end yet, by call id. */
  tools: Map<string, { name: string; at: number; summary?: string }>;
  model?: string;
  effort?: string;
  contextTokens?: number;
  /** How many input tokens the model takes, at its last call. */
  contextWindow?: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** When Copilot called tools, newest last. */
  toolCallTimes: number[];
  /** Epoch ms of the last turn's end. */
  turnEndAt?: number;
  lastEventAt?: number;
}

const MAX_TOOL_TIMES = 400;

export function emptyCopilot(): CopilotState {
  return { permissions: new Map(), tools: new Map(), tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCallTimes: [] };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** What a tool call works on, for the activity line: a shell command, a path. */
function summaryOf(args: unknown): string | undefined {
  if (typeof args === "string") return /\*\*\* (?:Add|Update|Delete) File: (.+)/.exec(args)?.[1]?.trim();
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  return str(a.command) ?? str(a.path) ?? str(a.file_path) ?? str(a.pattern);
}

/** The ask of an approval prompt, quoted, and Copilot's own words for it. */
function permissionReason(request: Record<string, unknown>): Reason {
  const intention = str(request.intention);
  const ask = str(request.fullCommandText) ?? str(request.fileName) ?? str(request.url) ?? intention ?? str(request.kind) ?? "permission";
  return { kind: "permission", ask: quoteAsk(ask), raw: intention ? quoteAsk(intention) : undefined };
}

export function applyCopilotLine(state: CopilotState, line: string): void {
  if (line.length === 0) return;
  let event: { type?: unknown; data?: unknown; timestamp?: unknown };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return;
  }
  if (!event || typeof event !== "object") return;
  const at = Date.parse(str(event.timestamp) ?? "");
  const when = Number.isFinite(at) ? at : undefined;
  const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;
  if (when !== undefined) state.lastEventAt = when;
  switch (event.type) {
    case "session.start":
    case "session.resume": {
      const cwd = str((data.context as { cwd?: unknown } | undefined)?.cwd);
      if (cwd) state.cwd = cwd;
      return;
    }
    case "user.message": {
      const text = str(data.content)?.trim();
      if (!text) return;
      state.firstPrompt ??= text;
      state.promptAt = when;
      return;
    }
    case "assistant.message": {
      state.model = str(data.model) ?? state.model;
      const text = str(data.content)?.trim();
      if (text && when !== undefined) state.lastReply = { text, at: when };
      return;
    }
    case "assistant.turn_end":
      state.turnEndAt = when;
      return;
    case "tool.execution_start": {
      const id = str(data.toolCallId);
      if (when !== undefined) {
        state.toolCallTimes.push(when);
        if (state.toolCallTimes.length > MAX_TOOL_TIMES) state.toolCallTimes.splice(0, state.toolCallTimes.length - MAX_TOOL_TIMES);
      }
      if (id && when !== undefined) state.tools.set(id, { name: str(data.toolName) ?? "tool", at: when, summary: summaryOf(data.arguments) });
      return;
    }
    case "tool.execution_complete": {
      const id = str(data.toolCallId);
      if (id) state.tools.delete(id);
      return;
    }
    case "permission.requested": {
      const id = str(data.requestId);
      const request = data.permissionRequest as Record<string, unknown> | undefined;
      if (id && request && when !== undefined) state.permissions.set(id, { at: when, reason: permissionReason(request) });
      return;
    }
    case "permission.completed": {
      const id = str(data.requestId);
      if (id) state.permissions.delete(id);
      return;
    }
    case "session.usage_record": {
      const usage = data.usage as Record<string, unknown> | undefined;
      if (!usage) return;
      state.model = str(usage.model) ?? state.model;
      state.effort = str(usage.reasoningEffort) ?? state.effort;
      state.contextTokens = num(usage.inputTokens) || state.contextTokens;
      state.contextWindow = num(usage.maxPromptTokens) || state.contextWindow;
      state.tokens.input += num(usage.inputTokens);
      state.tokens.output += num(usage.outputTokens);
      state.tokens.cacheRead += num(usage.cacheReadTokens);
      state.tokens.cacheWrite += num(usage.cacheWriteTokens);
      return;
    }
  }
}

/** The approval prompt waiting longest, when one waits. */
export function openPermission(state: CopilotState): { at: number; reason: Reason } | undefined {
  return [...state.permissions.values()].sort((a, b) => a.at - b.at)[0];
}

/** What a working session does now: its newest tool call without an end ("bash · npm test"). */
export function activityOf(state: CopilotState): string | undefined {
  const tool = [...state.tools.values()].at(-1);
  if (!tool) return undefined;
  return tool.summary ? `${tool.name} · ${tool.summary}` : tool.name;
}

/** Paths a tool call names: its `path`-like arguments, an `apply_patch`'s files, a shell command's `possiblePaths`. */
function pathsOf(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const args = data.arguments;
  if (typeof args === "string") for (const match of args.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+)/g)) out.push(match[1]!.trim());
  else if (args && typeof args === "object") {
    for (const key of ["path", "file_path", "filePath"]) {
      const value = (args as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) out.push(value);
    }
  }
  const possible = (data.shellToolInfo as { possiblePaths?: unknown } | undefined)?.possiblePaths;
  if (Array.isArray(possible)) for (const p of possible) if (typeof p === "string" && p.trim()) out.push(p);
  return out;
}

const USER_MESSAGE = '"type":"user.message"';
const REPLY = '"type":"assistant.message"';
const TOOL_START = '"type":"tool.execution_start"';

/** The message or paths an events line holds, for the search and the conversation tab. */
export function factsOf(line: string): LineFacts | undefined {
  // Cheap gates before parsing: most lines are model telemetry.
  const user = line.includes(USER_MESSAGE);
  const reply = line.includes(REPLY);
  const tool = line.includes(TOOL_START);
  if (!user && !reply && !tool) return undefined;
  let event: { type?: unknown; data?: Record<string, unknown>; timestamp?: unknown };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return undefined;
  }
  if (!event?.data) return undefined;
  const at = Date.parse(str(event.timestamp) ?? "");
  const when = Number.isFinite(at) ? at : undefined;
  if (event.type === "tool.execution_start") {
    const paths = pathsOf(event.data);
    return paths.length ? { paths } : undefined;
  }
  const text = str(event.data.content)?.trim();
  if (!text) return undefined;
  const message: HistoryMessage = { role: event.type === "user.message" ? "you" : "agent", at: when, text };
  return { message };
}

const TOOL_DONE = '"type":"tool.execution_complete"';

/**
 * The tool calls and results of an events line: a call's arguments (a
 * command as it was run, else their JSON) with the tool's name, and a
 * completion's result or error, cut to their first and last 2 KB.
 */
export function toolFactsOf(line: string): ToolText[] | undefined {
  let event: { type?: unknown; data?: Record<string, unknown>; timestamp?: unknown };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return undefined;
  }
  if (!event?.data) return undefined;
  const parsed = Date.parse(str(event.timestamp) ?? "");
  const at = Number.isFinite(parsed) ? { at: parsed } : {};
  if (event.type === "tool.execution_start") {
    const args = event.data.arguments;
    const command = typeof args === "object" && args !== null ? str((args as { command?: unknown }).command) : undefined;
    const text = toolText(command ?? (typeof args === "string" ? args : JSON.stringify(args ?? {})));
    const name = str(event.data.toolName);
    return text ? [{ ...(name ? { name } : {}), text, ...at }] : undefined;
  }
  if (event.type === "tool.execution_complete") {
    const result = event.data.result as { content?: unknown } | undefined;
    const error = event.data.error as { message?: unknown } | undefined;
    const text = toolText([str(result?.content), str(error?.message)].filter(Boolean).join("\n"));
    return text ? [{ text, ...at }] : undefined;
  }
  return undefined;
}

/** How the search reads an events file: a line without one of `factsOf`'s needles is never decoded. */
export const EVENTS_LINES = { ...readerOf("copilot-events", [USER_MESSAGE, REPLY, TOOL_START], factsOf), tools: toolReaderOf([TOOL_START, TOOL_DONE], toolFactsOf) };
