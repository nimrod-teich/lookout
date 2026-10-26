import { PULSE_BINS, PULSE_WINDOW_MS, pulseBin, pulseBins, pulseLength } from "../../pulse";
import { clip, quoteAsk } from "../../asks";
import { costOf, type TokenCounts } from "./pricing";
import { cronListOf, cronResultOf, cronSchedule, firedBy, pendingSchedules, promptLine, scheduleView, type Schedule } from "./schedule";
import type { ScheduleView } from "../../types";

/** A tool call the assistant made that has no result yet. */
export interface OpenTool {
  id: string;
  name: string;
  /** What the tool works on, e.g. the command or the file. */
  summary?: string;
  /** What a permission prompt for it asks: the whole command, the path, the question. */
  ask?: string;
  /** The answers a question offers. */
  options?: string[];
}

/** The latest reply of the main chain, while the turn has not moved on from it. */
export interface Reply {
  /** Message id; one message spans several lines. */
  id?: string;
  text: string;
  /** Epoch ms, when known. */
  at?: number;
}

/** Tokens a session used, by kind, and what they cost. */
export interface Spend {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD; exact from Claude Code's checkpoint plus Lookout's estimate since, or undefined for unknown models. */
  costUsd: number | undefined;
  /** Part of the total is Lookout's own estimate at list prices. */
  estimated: boolean;
  /** The transcript was joined after Claude Code's last checkpoint, so earlier usage is missing. */
  partial: boolean;
}

/** What Lookout knows about a session from its transcript. */
export interface TranscriptState {
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  /** The session's current directory; unlike the session file's, it follows `cd`. */
  cwd?: string;
  /** The git branch of the latest main-chain entry. */
  gitBranch?: string;
  /** Tool calls in flight, oldest first. */
  openTools: Map<string, OpenTool>;
  /** First line of the assistant's latest message. */
  lastReply?: string;
  /** The latest reply, unless a tool call, a prompt or an interrupt came after it. */
  reply?: Reply;
  /** Names the session's plan file, `<config>/plans/<slug>.md`. */
  slug?: string;
  model?: string;
  /** The reasoning effort of the latest main-chain reply: low, medium, high, xhigh, max. */
  effort?: string;
  /** Tokens in the context window at the last model call. */
  contextTokens?: number;
  /** When the assistant called tools, newest last; older than `PULSE_WINDOW_MS` is dropped. */
  toolCallTimes: number[];
  /** When Claude Code compacted the conversation, oldest first: the pins on the pulse. */
  compactedAt: number[];
  /** Totals from Claude Code's last cost checkpoint, which includes subagents. */
  checkpoint?: { tokens: TokenCounts; costUsd: number | undefined };
  /** Usage after the checkpoint, per model, deduplicated by message id. */
  since: Map<string, TokenCounts>;
  /** Message ids counted in `since`; a message spans several lines with the same usage. */
  countedMessages: Set<string>;
  /** No checkpoint was seen: the state started mid-transcript. */
  joinedLate: boolean;
  /** The tasks the session scheduled for itself, by id. */
  schedules: Map<string, Schedule>;
  /** CronCreate and CronList calls whose result, naming the jobs, is still to come: by the call's id. */
  cronCalls: Map<string, { kind: "create"; cron: string; prompt: string; at: number | undefined } | { kind: "list"; at: number | undefined }>;
}

export { PULSE_WINDOW_MS };
const MAX_TOOL_TIMES = 400;

export const INTERRUPT = "[Request interrupted by user";
const SUMMARY_MAX = 60;
/** A reply longer than this is cut; a question sits at its end, so the end is kept. */
const REPLY_MAX = 16 * 1024;
const OPTION_MAX = 60;

export function emptyTranscript(): TranscriptState {
  return { openTools: new Map(), toolCallTimes: [], compactedAt: [], since: new Map(), countedMessages: new Set(), joinedLate: false, schedules: new Map(), cronCalls: new Map() };
}

/**
 * Claude Code marks one compaction twice, a boundary and a summary, well
 * under a second apart; compacting takes longer than this, so two
 * compactions are always farther apart.
 */
const SAME_COMPACTION_MS = 10_000;
const MAX_COMPACTION_TIMES = 50;

/** When one compaction happened, from its boundary or its summary, whichever is seen first. */
function recordCompaction(state: TranscriptState, at: number): void {
  if (!Number.isFinite(at) || state.compactedAt.some((time) => Math.abs(time - at) < SAME_COMPACTION_MS)) return;
  const later = state.compactedAt.findIndex((time) => time > at);
  if (later < 0) state.compactedAt.push(at);
  else state.compactedAt.splice(later, 0, at);
  if (state.compactedAt.length > MAX_COMPACTION_TIMES) state.compactedAt.shift();
}

/** A transcript line that marks a compaction: Claude Code's boundary, or the summary that replaces the conversation. */
export function isCompactionEntry(e: Record<string, unknown>): boolean {
  return (e.type === "system" && e.subtype === "compact_boundary") || (e.type === "user" && e.isCompactSummary === true);
}

const MAX_COUNTED_MESSAGES = 4000;

function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

function addTokens(into: TokenCounts, from: TokenCounts): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite5m += from.cacheWrite5m;
  into.cacheWrite1h += from.cacheWrite1h;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Claude Code's `cost-state` line: its own totals for the session so far, subagents included. */
function applyCheckpoint(state: TranscriptState, e: Record<string, unknown>): void {
  const usage = e.modelUsage;
  if (typeof usage !== "object" || usage === null) return;
  const tokens = zeroTokens();
  for (const raw of Object.values(usage as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as Record<string, unknown>;
    // The checkpoint doesn't split cache writes by lifetime; they are counted once, priced by Claude Code itself.
    addTokens(tokens, { input: n(m.inputTokens), output: n(m.outputTokens), cacheRead: n(m.cacheReadInputTokens), cacheWrite5m: n(m.cacheCreationInputTokens), cacheWrite1h: 0 });
  }
  state.checkpoint = { tokens, costUsd: typeof e.totalCostUSD === "number" ? e.totalCostUSD : undefined };
  state.since.clear();
  state.countedMessages.clear();
  state.joinedLate = false;
}

function applyUsage(state: TranscriptState, message: { id?: unknown; model?: unknown; usage?: Record<string, unknown> }): void {
  const usage = message.usage;
  const model = typeof message.model === "string" ? message.model : undefined;
  const id = typeof message.id === "string" ? message.id : undefined;
  if (!usage || !model || !id || model.startsWith("<") || state.countedMessages.has(id)) return;
  state.countedMessages.add(id);
  if (state.countedMessages.size > MAX_COUNTED_MESSAGES) state.countedMessages.delete(state.countedMessages.values().next().value as string);
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  const write1h = n(creation?.ephemeral_1h_input_tokens);
  const write5m = creation ? n(creation.ephemeral_5m_input_tokens) : n(usage.cache_creation_input_tokens);
  const tokens = state.since.get(model) ?? zeroTokens();
  addTokens(tokens, { input: n(usage.input_tokens), output: n(usage.output_tokens), cacheRead: n(usage.cache_read_input_tokens), cacheWrite5m: write5m, cacheWrite1h: write1h });
  state.since.set(model, tokens);
}

function firstLine(text: string, max = SUMMARY_MAX): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function baseName(file: string): string {
  return file.split(/[\\/]+/).filter(Boolean).at(-1) ?? file;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** A short description of a tool call: the command, the file, the pattern. */
export function summarizeTool(name: string, input: unknown): string | undefined {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "Bash":
      return str(i.description) ?? (str(i.command) ? firstLine(i.command as string) : undefined);
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const file = str(i.file_path) ?? str(i.notebook_path);
      return file ? baseName(file) : undefined;
    }
    case "Grep":
    case "Glob":
      return str(i.pattern) ? firstLine(i.pattern as string) : undefined;
    case "Agent":
    case "Task":
      return str(i.description) ? firstLine(i.description as string) : undefined;
    case "Skill":
      return str(i.skill);
    case "WebFetch":
      return str(i.url);
    case "WebSearch":
      return str(i.query) ? firstLine(i.query as string) : undefined;
    default:
      return undefined;
  }
}

/** Fields that name what a tool works on, literally: shown as they are. */
const LITERAL_FIELDS = ["command", "file_path", "notebook_path", "url", "pattern", "query", "skill", "path"];
/** Fields that describe it in words: shown without their Markdown. */
const PROSE_FIELDS = ["description", "prompt", "title", "summary", "name"];

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A path under the session's directory, relative to it. */
function relative(file: string, cwd: string | undefined): string {
  if (!cwd) return file;
  const base = cwd.replace(/[\\/]+$/, "");
  return file.startsWith(`${base}/`) || file.startsWith(`${base}\\`) ? file.slice(base.length + 1) : file;
}

/**
 * What a tool call asks to do, as a permission prompt would show it: the
 * whole command, the path, the address; for a question, the question and
 * its answers.
 */
export function askOf(name: string, input: unknown, cwd?: string): Pick<OpenTool, "ask" | "options"> {
  const i = record(input);
  if (name === "AskUserQuestion") {
    const questions = Array.isArray(i.questions) ? i.questions : [];
    const first = record(questions[0]);
    const question = str(first.question);
    if (!question) return {};
    const options = (Array.isArray(first.options) ? first.options : []).map((option) => str(record(option).label)).filter((label): label is string => label !== undefined).map((label) => quoteAsk(label, OPTION_MAX));
    const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
    return { ask: clip(`${quoteAsk(question)}${more}`), options };
  }
  for (const key of LITERAL_FIELDS) {
    const value = str(i[key]);
    if (value) return { ask: clip(oneLine(key === "file_path" || key === "notebook_path" || key === "path" ? relative(value, cwd) : value)) };
  }
  for (const key of ["plan", ...PROSE_FIELDS]) {
    const value = str(i[key]);
    if (value) return { ask: quoteAsk(key === "plan" ? (value.split("\n").find((l) => l.trim() !== "") ?? value) : value) };
  }
  return {};
}

interface Block {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  text?: unknown;
  tool_use_id?: unknown;
}

function blocksOf(message: unknown): Block[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function applyAssistant(state: TranscriptState, e: Record<string, unknown>): void {
  const message = e.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
  const model = str(message?.model);
  if (model && !model.startsWith("<")) state.model = model;
  if (typeof e.effort === "string" && e.effort !== "") state.effort = e.effort;
  const usage = message?.usage;
  const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  const id = typeof message?.id === "string" ? message.id : undefined;
  if (usage) {
    const tokens = n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
    if (tokens > 0) state.contextTokens = tokens;
    applyUsage(state, message!);
  }
  for (const block of blocksOf(e.message)) {
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      state.openTools.set(block.id, { id: block.id, name: block.name, summary: summarizeTool(block.name, block.input), ...askOf(block.name, block.input, state.cwd) });
      applySchedulingCall(state, block.id, block.name, block.input, Number.isFinite(at) ? at : undefined);
      // The turn goes on: what was said before the call is not where it stopped.
      state.reply = undefined;
      if (Number.isFinite(at)) {
        state.toolCallTimes.push(at);
        if (state.toolCallTimes.length > MAX_TOOL_TIMES) state.toolCallTimes.splice(0, state.toolCallTimes.length - MAX_TOOL_TIMES);
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      const line = firstLine(block.text, 120);
      if (line) state.lastReply = line;
      if (block.text.trim() === "") continue;
      const text = state.reply && id !== undefined && state.reply.id === id ? `${state.reply.text}\n\n${block.text}` : block.text;
      state.reply = { id, text: text.length > REPLY_MAX ? tailOf(text, REPLY_MAX) : text, at: Number.isFinite(at) ? at : undefined };
    }
  }
}

/** The last `max` characters from a line start; a cut inside a code block gets its opening fence back. */
function tailOf(text: string, max: number): string {
  const cut = text.slice(-max);
  const tail = cut.slice(cut.indexOf("\n") + 1);
  const fences = tail.split("\n").filter((line) => /^\s*(`{3,}|~{3,})/.test(line)).length;
  return fences % 2 === 1 ? `\`\`\`\n${tail}` : tail;
}

function applyUser(state: TranscriptState, e: Record<string, unknown>): void {
  const content = (e.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    if (content.startsWith(INTERRUPT)) state.openTools.clear();
    // A prompt, an interrupt or a compaction summary: the reply before it is answered or moot.
    if (e.isMeta !== true) state.reply = undefined;
    // The runtime marks the prompt a scheduled task enqueued: that task has fired.
    if (e.turnOrigin === "scheduled") applyScheduledPrompt(state, content);
    return;
  }
  let results = 0;
  for (const block of blocksOf(e.message)) {
    if (block.type === "tool_result") {
      results++;
      if (typeof block.tool_use_id === "string") {
        state.openTools.delete(block.tool_use_id);
        applySchedulingResult(state, block.tool_use_id, (block as { content?: unknown }).content);
      }
    } else if (block.type === "text" && typeof block.text === "string" && block.text.startsWith(INTERRUPT)) {
      state.openTools.clear();
      state.reply = undefined;
      return;
    }
  }
  // A prompt starts a new turn; whatever was in flight is over.
  if (results === 0 && e.isMeta !== true) {
    state.openTools.clear();
    state.reply = undefined;
  }
}

/**
 * A tool call that schedules the session's own future: a wakeup, held as
 * the one the session can have at a time and dropped by `stop`; a cron
 * job, held from the call until its result names the job; a deletion.
 */
function applySchedulingCall(state: TranscriptState, id: string, name: string, input: unknown, at: number | undefined): void {
  const args = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  if (name === "ScheduleWakeup") {
    if (args.stop === true) {
      state.schedules.delete("wakeup");
      return;
    }
    const delay = typeof args.delaySeconds === "number" ? Math.min(3600, Math.max(60, args.delaySeconds)) : undefined;
    if (delay === undefined || at === undefined) return;
    const wakeup: Schedule = { id: "wakeup", kind: "wakeup", prompt: promptLine(args.prompt), at, nextAt: at + delay * 1000 };
    if (typeof args.prompt === "string") wakeup.fullPrompt = args.prompt;
    state.schedules.set("wakeup", wakeup);
  } else if (name === "CronCreate") {
    if (typeof args.cron !== "string") return;
    state.cronCalls.set(id, { kind: "create", cron: args.cron, prompt: typeof args.prompt === "string" ? args.prompt : "", at });
  } else if (name === "CronList") {
    state.cronCalls.set(id, { kind: "list", at });
  } else if (name === "CronDelete") {
    if (typeof args.id === "string") state.schedules.delete(args.id);
  }
}

/**
 * The result of a CronCreate names the job: from then on it is a schedule
 * of the session's, with the first run the scheduler announced. A
 * CronList result is the scheduler's own word on the jobs: a job it lists
 * takes its next run from it, one it leaves out has run its once or
 * expired, and one it names that the transcript never showed created is
 * taken in, its next run known only until it passes.
 */
function applySchedulingResult(state: TranscriptState, callId: string, content: unknown): void {
  const call = state.cronCalls.get(callId);
  if (!call) return;
  state.cronCalls.delete(callId);
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : "")).join("\n") : "";
  const at = call.at ?? Date.now();
  if (call.kind === "create") {
    const line = cronResultOf(text, at);
    if (line) state.schedules.set(line.id, cronSchedule(line, call.cron, call.prompt, at));
    return;
  }
  const listed = cronListOf(text, at);
  // A listing that reads as none, or as nothing, says nothing about the jobs.
  if (listed.length === 0 && !/no (cron )?jobs|none/i.test(text)) return;
  const ids = new Set(listed.map((line) => line.id));
  for (const id of [...state.schedules.keys()]) if (id !== "wakeup" && !ids.has(id)) state.schedules.delete(id);
  for (const line of listed) {
    const known = state.schedules.get(line.id);
    if (known) {
      if (line.nextAt !== undefined) known.nextAt = line.nextAt;
    } else state.schedules.set(line.id, cronSchedule(line, undefined, undefined, at));
  }
}

/** A scheduled prompt has fired: the one-time job or the wakeup that gave it is over; a recurring job runs on. */
function applyScheduledPrompt(state: TranscriptState, content: string): void {
  for (const schedule of state.schedules.values()) {
    if (schedule.kind === "cron" && firedBy(schedule, content)) {
      if (!schedule.recurring) state.schedules.delete(schedule.id);
      return;
    }
  }
  // A prompt no cron job gave, while a wakeup waits, is the wakeup's (its prompt may be a sentinel the runtime resolved).
  state.schedules.delete("wakeup");
}

/** The tasks the session scheduled for itself and still to come at `now`, the next first, as the board shows them. */
export function schedulesOf(state: TranscriptState, now: number): ScheduleView[] {
  return pendingSchedules(state.schedules.values(), now).map(scheduleView);
}

/** Folds one transcript line into the state. Lines that don't parse are ignored, and subagents' unless `sidechain` asks for them. */
export function applyLine(state: TranscriptState, line: string, sidechain = false): void {
  if (line.length < 2) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof entry !== "object" || entry === null) return;
  const e = entry as Record<string, unknown>;
  switch (e.type) {
    case "custom-title":
      if (typeof e.customTitle === "string") state.customTitle = e.customTitle;
      return;
    case "ai-title":
      if (typeof e.aiTitle === "string") state.aiTitle = e.aiTitle;
      return;
    case "last-prompt":
      if (typeof e.lastPrompt === "string") state.lastPrompt = e.lastPrompt;
      return;
    case "cost-state":
      applyCheckpoint(state, e);
      return;
  }
  // Subagent entries carry their own cwd and tools; only the main chain is the session.
  if (e.isSidechain === true && !sidechain) return;
  const time = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  if (isCompactionEntry(e)) recordCompaction(state, time);
  if (typeof e.cwd === "string" && e.cwd !== "") state.cwd = e.cwd;
  if (typeof e.gitBranch === "string" && e.gitBranch.trim() !== "") state.gitBranch = e.gitBranch.trim();
  if (typeof e.slug === "string" && e.slug !== "") state.slug = e.slug;
  if (e.type === "assistant") applyAssistant(state, e);
  else if (e.type === "user") applyUser(state, e);
}

/** The name the Claude Code tab shows: a user rename wins over the generated title. */
export function titleOf(state: TranscriptState | undefined): string | undefined {
  if (!state) return undefined;
  for (const candidate of [state.customTitle, state.aiTitle, state.lastPrompt]) {
    const title = candidate?.replace(/\s+/g, " ").trim();
    if (title) return title;
  }
  return undefined;
}

const AGENT_TOOLS = ["Agent", "Task"];

/** "Bash · npm test", or "Agent · Review the diff +2" when several calls are in flight. */
export function activityOf(state: TranscriptState): string | undefined {
  const tools = [...state.openTools.values()];
  const first = tools[0];
  if (!first) return undefined;
  const label = first.summary ? `${first.name} · ${first.summary}` : first.name;
  return tools.length > 1 ? `${label} +${tools.length - 1}` : label;
}

/** Tool calls per minute over the last 15 minutes, oldest first; see `pulseBins`. */
export function pulseOf(state: TranscriptState, now: number, since?: number): number[] {
  return pulseBins(state.toolCallTimes, now, since);
}

/**
 * Indices into the pulse of `pulseOf` (same window, same `since`) of the
 * minutes the conversation was compacted.
 */
export function pulseMarksOf(state: TranscriptState, now: number, since?: number): number[] {
  const skipped = PULSE_BINS - pulseLength(now, since);
  const marks = new Set<number>();
  for (const at of state.compactedAt) {
    const bin = pulseBin(at, now);
    if (bin !== undefined && bin >= skipped) marks.add(bin - skipped);
  }
  return [...marks].sort((a, b) => a - b);
}

/** Claude's context window for a model id: 1M for the `[1m]` variants, or when the usage already passed 200k. */
export function contextWindowOf(model: string | undefined, contextTokens: number | undefined): number | undefined {
  if (!model) return undefined;
  if (model.includes("[1m]") || (contextTokens !== undefined && contextTokens > 200_000)) return 1_000_000;
  return 200_000;
}

/** The session's spend: Claude Code's checkpoint plus what the main transcript added since. */
export function spendOf(state: TranscriptState): Spend | undefined {
  if (!state.checkpoint && state.since.size === 0) return undefined;
  const total = state.checkpoint ? { ...state.checkpoint.tokens } : zeroTokens();
  let cost: number | undefined = state.checkpoint ? state.checkpoint.costUsd : 0;
  let estimated = false;
  for (const [model, tokens] of state.since) {
    addTokens(total, tokens);
    estimated = true;
    const part = costOf(model, tokens);
    cost = cost === undefined || part === undefined ? undefined : cost + part;
  }
  return {
    input: total.input,
    output: total.output,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite5m + total.cacheWrite1h,
    costUsd: cost,
    estimated,
    partial: state.joinedLate,
  };
}

/** Subagents in flight. */
export function agentsOf(state: TranscriptState): number {
  let count = 0;
  for (const tool of state.openTools.values()) if (AGENT_TOOLS.includes(tool.name)) count++;
  return count;
}
