import { blockText, parseMarkdown, plainText, type Block } from "./markdown";

/** What a session asks is quoted up to this many characters. */
export const ASK_MAX = 160;

/** At most `max` characters, cut with an ellipsis. */
export function clip(text: string, max: number = ASK_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Text quoted as an ask: Markdown stripped, whitespace collapsed, clipped. */
export function quoteAsk(text: string, max: number = ASK_MAX): string {
  return clip(plainText(text), max);
}

/** Closing marks that may follow a question mark: quotes, brackets, emphasis. */
const TRAILING = /[\s"'”’)\]*_`]+$/;
const QUESTION_END = /[?？]$/;
/** Asking for a choice or a yes/no without a question mark. */
const CHOICE = [
  /\((?:y\/n|yes\/no)\)|\[y\/n\]/i,
  /\byes or no\b/i,
  /\blet me know (?:which|whether)\b/i,
  /\b(?:pick|choose) (?:one|an option|between)\b/i,
];
const SENTENCE_END = /(?<=[.!?。！？])\s+/;
/** A question shorter than this leans on the sentence before it ("Which one?"). */
const SHORT_QUESTION = 40;

function asks(text: string): boolean {
  return QUESTION_END.test(text.replace(TRAILING, "")) || CHOICE.some((pattern) => pattern.test(text));
}

/** The sentence that asks, with the one before it when it is too short to stand alone. */
function askingPart(text: string): string {
  const sentences = text.split(SENTENCE_END);
  let at = sentences.length - 1;
  while (at > 0 && !asks(sentences[at]!)) at--;
  const quote = sentences[at]!;
  const before = sentences[at - 1];
  if (quote.length < SHORT_QUESTION && before !== undefined && before.length + 1 + quote.length <= ASK_MAX) return `${before} ${quote}`;
  return clip(quote);
}

function words(block: Block): string {
  return blockText(block).replace(/\s+/g, " ").trim();
}

/**
 * The question a reply leaves the user with, quoted, when its last paragraph
 * asks something: it ends with a question mark, or asks for a choice or a
 * yes/no. Code blocks don't count. A list that follows a question is its
 * options, so the question before it still counts.
 */
export function questionIn(reply: string): string | undefined {
  const blocks = parseMarkdown(reply).filter((block) => block.type !== "code" && block.type !== "rule");
  const last = blocks.at(-1);
  if (!last) return undefined;
  const text = words(last);
  if (asks(text)) return askingPart(text);
  const before = blocks.at(-2);
  if (last.type === "list" && before) {
    const question = words(before);
    if (asks(question)) return askingPart(question);
  }
  return undefined;
}
