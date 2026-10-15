/** A tool call the assistant made that has no result yet. */
export interface OpenTool {
  id: string;
  name: string;
  /** What the tool works on, e.g. the command or the file. */
  summary?: string;
}

/** What Lookout knows about a session from its transcript. */
export interface TranscriptState {
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  /** The session's current directory; unlike the session file's, it follows `cd`. */
  cwd?: string;
  /** Tool calls in flight, oldest first. */
  openTools: Map<string, OpenTool>;
  /** First line of the assistant's latest message. */
  lastReply?: string;
  model?: string;
  /** Tokens in the context window at the last model call. */
  contextTokens?: number;
  /** When the assistant called tools, newest last; older than `PULSE_WINDOW_MS` is dropped. */
  toolCallTimes: number[];
}

/** How far back the pulse looks. */
export const PULSE_WINDOW_MS = 15 * 60_000;
const PULSE_BINS = 15;
const MAX_TOOL_TIMES = 400;

const INTERRUPT = "[Request interrupted by user";
const SUMMARY_MAX = 60;

export function emptyTranscript(): TranscriptState {
  return { openTools: new Map(), toolCallTimes: [] };
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
  const message = e.message as { model?: unknown; usage?: Record<string, unknown> } | undefined;
  const model = str(message?.model);
  if (model && !model.startsWith("<")) state.model = model;
  const usage = message?.usage;
  if (usage) {
    const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
    const tokens = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    if (tokens > 0) state.contextTokens = tokens;
  }
  const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  for (const block of blocksOf(e.message)) {
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      state.openTools.set(block.id, { id: block.id, name: block.name, summary: summarizeTool(block.name, block.input) });
      if (Number.isFinite(at)) {
        state.toolCallTimes.push(at);
        if (state.toolCallTimes.length > MAX_TOOL_TIMES) state.toolCallTimes.splice(0, state.toolCallTimes.length - MAX_TOOL_TIMES);
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      const line = firstLine(block.text, 120);
      if (line) state.lastReply = line;
    }
  }
}

function applyUser(state: TranscriptState, e: Record<string, unknown>): void {
  const content = (e.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    if (content.startsWith(INTERRUPT)) state.openTools.clear();
    return;
  }
  let results = 0;
  for (const block of blocksOf(e.message)) {
    if (block.type === "tool_result") {
      results++;
      if (typeof block.tool_use_id === "string") state.openTools.delete(block.tool_use_id);
    } else if (block.type === "text" && typeof block.text === "string" && block.text.startsWith(INTERRUPT)) {
      state.openTools.clear();
      return;
    }
  }
  // A prompt starts a new turn; whatever was in flight is over.
  if (results === 0 && e.isMeta !== true) state.openTools.clear();
}

/** Folds one transcript line into the state. Lines that don't parse are ignored. */
export function applyLine(state: TranscriptState, line: string): void {
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
  }
  // Subagent entries carry their own cwd and tools; only the main chain is the session.
  if (e.isSidechain === true) return;
  if (typeof e.cwd === "string" && e.cwd !== "") state.cwd = e.cwd;
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

/** Tool calls per minute over the last 15 minutes, oldest first. */
export function pulseOf(state: TranscriptState, now: number): number[] {
  const bins = new Array<number>(PULSE_BINS).fill(0);
  const binMs = PULSE_WINDOW_MS / PULSE_BINS;
  const start = now - PULSE_WINDOW_MS;
  for (const at of state.toolCallTimes) {
    if (at < start || at > now) continue;
    bins[Math.min(PULSE_BINS - 1, Math.floor((at - start) / binMs))]!++;
  }
  return bins;
}

/** Claude's context window for a model id: 1M for the `[1m]` variants, or when the usage already passed 200k. */
export function contextWindowOf(model: string | undefined, contextTokens: number | undefined): number | undefined {
  if (!model) return undefined;
  if (model.includes("[1m]") || (contextTokens !== undefined && contextTokens > 200_000)) return 1_000_000;
  return 200_000;
}

/** Subagents in flight. */
export function agentsOf(state: TranscriptState): number {
  let count = 0;
  for (const tool of state.openTools.values()) if (AGENT_TOOLS.includes(tool.name)) count++;
  return count;
}
