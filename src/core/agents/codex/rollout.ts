// What a Codex rollout says about its session, read line by line.
//
// A rollout (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`) is
// one JSON object per line: `{ timestamp, type, payload }`. Codex keeps no
// state file per session, so the state is inferred from the last records:
//
// - `session_meta` (the first line): id, cwd, originator, cli_version.
// - `turn_context`: the model and reasoning effort of the turn.
// - `event_msg` `task_started` / `task_complete` / `turn_aborted`: a turn
//   begins, ends, or is interrupted.
// - `response_item` `custom_tool_call` named `exec` / `custom_tool_call_output`:
//   a command (Codex writes JavaScript calling `tools.exec_command({cmd, …})`)
//   and its result. One that asked for `sandbox_permissions:
//   "require_escalated"` and has no result yet waits for the user's approval:
//   Codex writes no approval event, and an approved command's result follows
//   within about a second, while it runs on in the background.
// - `response_item` `function_call` `request_user_input_async`: a question
//   with options; it is accepted at once and stays open until the next user
//   message, after the turn has ended.
// - `event_msg` `item_completed` with an `AgentMessage`: what Codex said.
// - `event_msg` `token_count`: the context window and the tokens in it, the
//   thread's token totals, and the account's limits (`rate_limits`: a primary
//   and a secondary window, each with `used_percent`, `window_minutes` and
//   `resets_at` in epoch seconds).
// - `token_usage_record`: one reply's tokens, for its API-equivalent price.
import { quoteAsk } from "../../asks";
import type { Reason } from "../../types";
import { replyCost } from "./pricing";

/** A command or tool call with no result yet. */
export interface OpenCall {
  name: string;
  at: number;
  /** The shell command, for `exec`. */
  command?: string;
  /** It asked to run outside the sandbox: Codex shows the user an approval prompt. */
  escalated: boolean;
  /** Why, in Codex's words. */
  justification?: string;
}

/** One of the account's limits, as the last `token_count` gave it. */
export interface RateWindow {
  usedPercent: number;
  windowMinutes?: number;
  /** Epoch ms the window resets. */
  resetsAt?: number;
}

export interface RolloutState {
  id?: string;
  cwd?: string;
  /** Epoch ms of `session_meta`: when the thread was created. */
  createdAt?: number;
  originator?: string;
  model?: string;
  effort?: string;
  contextWindow?: number;
  contextTokens?: number;
  /** A turn is running; undefined until a turn's start or end was read. */
  turnOpen?: boolean;
  /** Epoch ms of the last turn start or end. */
  turnAt?: number;
  /** Calls without a result yet, by call id, oldest first. */
  openCalls: Map<string, OpenCall>;
  /** A question asked through `request_user_input_async`, open until the next user message. */
  question?: { title: string; options: string[]; at: number };
  /** The first prompt the user wrote. */
  firstPrompt?: string;
  /** Codex's last message, while the turn that said it is the last one. */
  lastReply?: { text: string; at: number; final: boolean };
  /** When Codex called tools, newest last. */
  toolCallTimes: number[];
  /** The account's limits at the last `token_count` that carried them, and when that was. */
  rateLimits?: { at: number; primary?: RateWindow; secondary?: RateWindow };
  /** The thread's tokens so far, from the last `token_count`. */
  totals?: { input: number; cached: number; cacheWrite: number; output: number };
  /** The replies priced so far (by response id), and their sum; `unpriced` once a reply's model had no price. */
  priced: Set<string>;
  costUsd: number;
  unpriced: boolean;
  /** Epoch ms of the last record read. */
  lastRecordAt?: number;
  /** Type of the last record read, `type` or `type/payload.type`. */
  lastRecord?: string;
}

const MAX_TOOL_TIMES = 400;
/** Records whose user messages are Codex's own context, not the user's words. */
const CONTEXT_PREFIXES = ["<environment_context>", "<user_instructions>", "# AGENTS.md instructions", "<turn_aborted>", "<permissions instructions>"];

export function emptyRollout(): RolloutState {
  return { openCalls: new Map(), toolCallTimes: [], priced: new Set(), costUsd: 0, unpriced: false };
}

/** A limit window from `rate_limits`; `resets_in_seconds` (older Codex) counts from the record's time. */
function windowOf(raw: unknown, at: number | undefined): RateWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const usedPercent = num(o.used_percent);
  if (usedPercent === undefined) return undefined;
  const resetsAtS = num(o.resets_at);
  const resetsIn = num(o.resets_in_seconds);
  return {
    usedPercent,
    windowMinutes: num(o.window_minutes),
    resetsAt: resetsAtS !== undefined ? resetsAtS * 1000 : resetsIn !== undefined && at !== undefined ? at + resetsIn * 1000 : undefined,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A string literal in Codex's tool-call JavaScript: `key:"…"`, JSON-escaped. */
function literal(code: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(code);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]!) as string;
  } catch {
    return undefined;
  }
}

/** The command a code-mode `exec` call runs, and whether it asks to leave the sandbox. */
export function execCall(input: string): { command?: string; escalated: boolean; justification?: string } {
  return {
    command: literal(input, "cmd"),
    escalated: /sandbox_permissions\s*:\s*"require_escalated"/.test(input),
    justification: literal(input, "justification"),
  };
}

/** The text of a message's content parts. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" ? (str((part as { text?: unknown }).text) ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** A user message Codex adds for context, rather than one the user wrote. */
export function isContext(text: string): boolean {
  const start = text.trimStart();
  return CONTEXT_PREFIXES.some((prefix) => start.startsWith(prefix));
}

/** Applies one rollout line; lines that do not parse are skipped. */
export function applyRolloutLine(state: RolloutState, line: string): void {
  if (line.length === 0) return;
  let record: { timestamp?: unknown; type?: unknown; payload?: unknown };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return;
  }
  if (!record || typeof record !== "object") return;
  const at = Date.parse(str(record.timestamp) ?? "");
  const when = Number.isFinite(at) ? at : undefined;
  const payload = (record.payload && typeof record.payload === "object" ? record.payload : {}) as Record<string, unknown>;
  const kind = str(payload.type);
  if (when !== undefined) state.lastRecordAt = when;
  state.lastRecord = kind ? `${str(record.type)}/${kind}` : str(record.type);
  switch (record.type) {
    case "session_meta": {
      state.id = str(payload.id) ?? state.id;
      state.cwd = str(payload.cwd) ?? state.cwd;
      state.originator = str(payload.originator) ?? state.originator;
      const created = Date.parse(str(payload.timestamp) ?? "");
      state.createdAt = Number.isFinite(created) ? created : (state.createdAt ?? when);
      return;
    }
    case "turn_context": {
      state.model = str(payload.model) ?? state.model;
      state.cwd = str(payload.cwd) ?? state.cwd;
      const settings = (payload.collaboration_mode as { settings?: { reasoning_effort?: unknown } } | undefined)?.settings;
      state.effort = str(settings?.reasoning_effort) ?? str(payload.effort) ?? undefined;
      return;
    }
    case "event_msg":
      applyEvent(state, kind, payload, when);
      return;
    case "token_usage_record": {
      // One reply's tokens, priced once: a record can be written again on resume.
      const response = str(payload.response_id);
      const usage = payload.usage as Record<string, unknown> | undefined;
      if (!response || !usage || state.priced.has(response)) return;
      state.priced.add(response);
      const cost = replyCost(state.model, { input: num(usage.input_tokens) ?? 0, cached: num(usage.cached_input_tokens) ?? 0, cacheWrite: num(usage.cache_write_input_tokens) ?? 0, output: num(usage.output_tokens) ?? 0 });
      if (cost === undefined) state.unpriced = true;
      else state.costUsd += cost;
      return;
    }
    case "response_item":
      applyItem(state, kind, payload, when);
      return;
  }
}

function applyEvent(state: RolloutState, kind: string | undefined, payload: Record<string, unknown>, at: number | undefined): void {
  switch (kind) {
    case "task_started":
      state.turnOpen = true;
      state.turnAt = at;
      state.lastReply = undefined;
      return;
    case "task_complete":
    case "turn_aborted":
      state.turnOpen = false;
      state.turnAt = at;
      // Nothing of the turn runs on: its calls are over, answered or not.
      state.openCalls.clear();
      return;
    case "token_count": {
      const info = payload.info as { last_token_usage?: { total_tokens?: unknown }; total_token_usage?: Record<string, unknown>; model_context_window?: unknown } | null | undefined;
      state.contextTokens = num(info?.last_token_usage?.total_tokens) ?? state.contextTokens;
      state.contextWindow = num(info?.model_context_window) ?? state.contextWindow;
      const total = info?.total_token_usage;
      if (total) state.totals = { input: num(total.input_tokens) ?? 0, cached: num(total.cached_input_tokens) ?? 0, cacheWrite: num(total.cache_write_input_tokens) ?? 0, output: num(total.output_tokens) ?? 0 };
      const limits = payload.rate_limits as { primary?: unknown; secondary?: unknown } | null | undefined;
      if (limits && at !== undefined) {
        const primary = windowOf(limits.primary, at);
        const secondary = windowOf(limits.secondary, at);
        if (primary || secondary) state.rateLimits = { at, primary, secondary };
      }
      return;
    }
    case "item_completed": {
      const item = payload.item as { type?: unknown; content?: unknown; phase?: unknown } | undefined;
      if (item?.type === "AgentMessage" && at !== undefined) {
        const text = textOf(item.content);
        if (text) state.lastReply = { text, at, final: item.phase === "final_answer" };
      }
      return;
    }
  }
}

function applyItem(state: RolloutState, kind: string | undefined, payload: Record<string, unknown>, at: number | undefined): void {
  switch (kind) {
    case "message": {
      if (payload.role !== "user") return;
      const text = textOf(payload.content);
      if (!text || isContext(text)) return;
      state.firstPrompt ??= text;
      // The user answered, or moved on: an open question is over.
      state.question = undefined;
      return;
    }
    case "custom_tool_call":
    case "function_call": {
      const id = str(payload.call_id);
      const name = str(payload.name) ?? "tool";
      if (at !== undefined) {
        state.toolCallTimes.push(at);
        if (state.toolCallTimes.length > MAX_TOOL_TIMES) state.toolCallTimes.splice(0, state.toolCallTimes.length - MAX_TOOL_TIMES);
      }
      if (name === "request_user_input_async" || name === "request_user_input") {
        const question = askedOf(str(payload.arguments));
        if (question && at !== undefined) state.question = { ...question, at };
        if (name === "request_user_input_async") return;
      }
      if (!id || at === undefined) return;
      const input = str(payload.input) ?? str(payload.arguments) ?? "";
      const exec = name === "exec" ? execCall(input) : { escalated: false };
      state.openCalls.set(id, { name, at, ...exec });
      return;
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      const id = str(payload.call_id);
      if (id) state.openCalls.delete(id);
      return;
    }
  }
}

/** The first question of a `request_user_input` call's arguments, with its options. */
function askedOf(args: string | undefined): { title: string; options: string[] } | undefined {
  if (!args) return undefined;
  try {
    const parsed = JSON.parse(args) as { questions?: { title?: unknown; question?: unknown; options?: unknown }[] };
    const first = parsed.questions?.[0];
    const title = str(first?.title) ?? str(first?.question);
    if (!title) return undefined;
    const options = Array.isArray(first?.options) ? first.options.map((option) => (typeof option === "string" ? option : str((option as { label?: unknown })?.label))).filter((o): o is string => !!o) : [];
    return { title, options };
  } catch {
    return undefined;
  }
}

/** Whether a turn is running: as its start and end say, or, read from mid-file, as the last record suggests. */
export function turnRunning(state: RolloutState): boolean {
  if (state.turnOpen !== undefined) return state.turnOpen;
  return state.lastRecord !== undefined && state.lastRecord !== "event_msg/task_complete" && state.lastRecord !== "event_msg/turn_aborted";
}

/** The call that waits for the user's approval, the oldest first. */
export function approvalCall(state: RolloutState): OpenCall | undefined {
  for (const call of state.openCalls.values()) if (call.escalated) return call;
  return undefined;
}

/** Why the session waits, in Lookout's words with Codex's quoted. */
export function waitReason(state: RolloutState): Reason | undefined {
  const call = approvalCall(state);
  if (call) return { kind: "permission", ask: quoteAsk(call.command ?? call.justification ?? call.name), raw: call.justification ? quoteAsk(call.justification) : "approval request" };
  if (state.question) return { kind: "question", ask: quoteAsk(state.question.title), options: state.question.options.length ? state.question.options : undefined };
  return undefined;
}

/** What a working session is doing: the command it runs, as Claude's are shown ("exec · npm test"). */
export function activityOf(state: RolloutState): string | undefined {
  const calls = [...state.openCalls.values()];
  const call = calls.at(-1);
  if (!call) return undefined;
  return call.command ? `${call.name} · ${call.command}` : call.name;
}
