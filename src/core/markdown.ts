// A small Markdown reader for conversation text: the forms agents and people
// write in chat, nothing more. Pure, so it can be tested without a DOM; the
// webview turns the tree into elements.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; text: string; href: string };

export interface ListItem {
  children: Inline[];
  /** A list nested under the item. */
  sub?: Block;
}

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "rule" };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w.+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Inline forms, longest first so `**` wins over `*`. */
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;

/** The inline forms of one run of text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest !== "") {
    const match = INLINE.exec(rest);
    if (!match) {
      out.push({ type: "text", text: rest });
      break;
    }
    if (match.index > 0) out.push({ type: "text", text: rest.slice(0, match.index) });
    const [whole, , code, strong, strong2, em, em2, linkText, href] = match;
    if (code !== undefined) out.push({ type: "code", text: code });
    else if (strong !== undefined || strong2 !== undefined) out.push({ type: "strong", children: parseInline((strong ?? strong2)!) });
    else if (em !== undefined || em2 !== undefined) out.push({ type: "em", children: parseInline((em ?? em2)!) });
    else if (linkText !== undefined && href !== undefined) out.push({ type: "link", text: linkText, href });
    rest = rest.slice(match.index + whole.length);
  }
  return out;
}

/** The blocks of a message. Paragraph lines keep their line breaks. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i]!.trim().startsWith(marker[0]!.repeat(3)) && lines[i]!.trim().replace(/[`~]/g, "") === "")) body.push(lines[i++]!);
      i++;
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, children: parseInline(heading[2]!) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(QUOTE.exec(lines[i++]!)![1]!);
      blocks.push({ type: "quote", children: parseInline(quoted.join("\n")) });
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const [list, next] = parseList(lines, i, indentOf(line));
      blocks.push(list);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i]!)) para.push(lines[i++]!);
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }
  return blocks;
}

function inlineText(nodes: readonly Inline[]): string {
  return nodes.map((node) => (node.type === "strong" || node.type === "em" ? inlineText(node.children) : node.text)).join("");
}

/** A block's words without its markup; list items are joined with "; ". */
export function blockText(block: Block): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
      return inlineText(block.children);
    case "code":
      return block.text;
    case "list":
      return block.items.map((item) => (item.sub ? `${inlineText(item.children)}; ${blockText(item.sub)}` : inlineText(item.children))).join("; ");
    case "rule":
      return "";
  }
}

/** A message's words without its Markdown, whitespace collapsed. */
export function plainText(text: string): string {
  return parseMarkdown(text)
    .map(blockText)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)![0].length;
}

function isBlockStart(line: string): boolean {
  return line.trim() === "" || FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line);
}

/** A list starting at `start` whose items sit at `indent`; deeper items nest under the item before them. */
function parseList(lines: string[], start: number, indent: number): [Block, number] {
  const ordered = NUMBERED.test(lines[start]!);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const item = (ordered ? NUMBERED : BULLET).exec(line) ?? (ordered ? BULLET : NUMBERED).exec(line);
    if (!item || item[1]!.length !== indent) {
      // A deeper item nests under the last one; a shallower or non-list line ends this list.
      if (item && item[1]!.length > indent && items.length > 0) {
        const [sub, next] = parseList(lines, i, item[1]!.length);
        items[items.length - 1]!.sub = sub;
        i = next;
        continue;
      }
      // Text indented under the last item continues it; at a nested level, text at the items' own indent does too.
      const deeper = indentOf(line) > indent || (indent > 0 && indentOf(line) === indent);
      if (!item && line.trim() !== "" && deeper && items.length > 0 && !isBlockStart(line)) {
        items[items.length - 1]!.children.push({ type: "text", text: "\n" }, ...parseInline(line.trim()));
        i++;
        continue;
      }
      break;
    }
    items.push({ children: parseInline(item[3]!) });
    i++;
  }
  return [{ type: "list", ordered, items }, i];
}
