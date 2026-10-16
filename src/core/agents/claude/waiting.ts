import * as fs from "node:fs";
import { clip, questionIn, quoteAsk } from "../../asks";
import { parseMarkdown, blockText } from "../../markdown";
import type { Reason, ReasonKind, TypedQuestion } from "../../types";
import type { SessionFile } from "./sessionFile";
import type { OpenTool, Reply, TranscriptState } from "./transcript";

/** Claude Code's `waitingFor` for a tool permission, and for any prompt that names nothing more specific. */
export const PERMISSION_PROMPT = "permission prompt";
/** Its `waitingFor` while AskUserQuestion (or an MCP server's question) waits for an answer. */
export const INPUT_NEEDED = "input needed";
/** How Claude Code itself files each `waitingFor`; anything else is a dialog. */
const KINDS: Readonly<Record<string, ReasonKind>> = {
  [PERMISSION_PROMPT]: "permission",
  "sandbox request": "permission",
  "worker request": "permission",
  "goal proposal": "permission",
  [INPUT_NEEDED]: "question",
};
const PLAN_TOOLS = ["ExitPlanMode", "EnterPlanMode"];
/** Tools that hand work to a subagent: a prompt asked while one is open may come from the subagent. */
export const SUBAGENT_TOOLS = ["Agent", "Task"];
/** How much of a plan file is read for its title. */
const PLAN_HEAD_BYTES = 8 * 1024;

/** "Bash", or "createJiraIssue (atlassian)" for an MCP server's tool. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[2]} (${mcp[1]})` : name;
}

function toolAsk(tool: OpenTool): string {
  return tool.ask ? `${toolLabel(tool.name)}: ${tool.ask}` : toolLabel(tool.name);
}

/**
 * Why a waiting session waits. Claude Code records a word for it in the
 * session file (`waitingFor`), and for some dialogs its own line (`needs`),
 * which is quoted as it is. Otherwise the tool call still open in the
 * transcript says what a prompt is about: tool calls run one after another,
 * so the oldest open call is the one being asked about. When that call hands
 * work to a subagent, `subagentTool` gives the call the subagent has open.
 */
export function reasonOf(
  file: Pick<SessionFile, "waitingFor" | "needs">,
  state: TranscriptState,
  lookups: { planTitle?: (slug: string) => string | undefined; subagentTool?: () => OpenTool | undefined } = {},
): Reason {
  const raw = file.waitingFor;
  const word = raw ?? PERMISSION_PROMPT;
  const kind = KINDS[word] ?? "dialog";
  const tools = [...state.openTools.values()];
  const question = tools.find((tool) => tool.name === "AskUserQuestion");
  if ((word === PERMISSION_PROMPT || word === INPUT_NEEDED) && question?.ask) return { kind: "question", ask: question.ask, options: question.options, raw };
  if (file.needs) return { kind, ask: quoteAsk(file.needs), raw };
  if (word === PERMISSION_PROMPT) {
    const plan = tools.find((tool) => PLAN_TOOLS.includes(tool.name));
    if (plan?.name === "EnterPlanMode") return { kind: "plan", ask: "enter plan mode", raw };
    if (plan) return { kind: "plan", ask: plan.ask ?? (state.slug ? lookups.planTitle?.(state.slug) : undefined) ?? "a plan to review", raw };
  }
  if (word === PERMISSION_PROMPT || word === "sandbox request") {
    const tool = tools[0];
    if (tool && SUBAGENT_TOOLS.includes(tool.name)) {
      const inner = lookups.subagentTool?.();
      const who = tool.ask ? ` · in subagent "${tool.ask}"` : " · in a subagent";
      if (inner) return { kind, ask: clip(`${toolAsk(inner)}${who}`), raw };
    }
    if (tool) return { kind, ask: clip(word === "sandbox request" ? `${toolAsk(tool)} · network access` : toolAsk(tool)), raw };
  }
  // The tool call or the question can reach the transcript a moment after the wait is recorded.
  return { kind, ask: quoteAsk(word), raw, tentative: word === PERMISSION_PROMPT || word === INPUT_NEEDED || undefined };
}

/** The title of a plan file: its first heading, else its first line; Markdown stripped. */
export function planFileTitle(file: string): string | undefined {
  let head: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(PLAN_HEAD_BYTES);
      head = buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, PLAN_HEAD_BYTES, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const blocks = parseMarkdown(head);
  const first = blocks.find((block) => block.type === "heading") ?? blocks.find((block) => block.type !== "rule");
  const text = first ? blockText(first).replace(/\s+/g, " ").trim() : "";
  return text ? clip(text) : undefined;
}

/** Each reply is read for a question once. */
const questions = new WeakMap<Reply, TypedQuestion | null>();

/** The question the session's last reply asks, while that reply is where the turn stopped. */
export function questionOf(state: TranscriptState): TypedQuestion | undefined {
  const reply = state.reply;
  if (!reply) return undefined;
  let question = questions.get(reply);
  if (question === undefined) {
    const text = questionIn(reply.text);
    question = text ? { text, at: reply.at } : null;
    questions.set(reply, question);
  }
  return question ?? undefined;
}
