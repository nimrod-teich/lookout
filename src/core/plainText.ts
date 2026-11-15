// Text that came from elsewhere (a backup file, another window's state, a
// session's title), made safe to put in a VS Code notification or input
// box. VS Code turns `[label](command:…)` there into a link that runs the
// command when clicked, so a link's `](` is broken apart; control and
// direction-changing characters go, lines are joined, and it is cut short.

/** Control characters, and those that reorder or hide text. */
const UNSEEN = /[\p{Cc}\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

/** `text` as plain words on one line, at most `max` characters, never a link. */
export function plainText(text: unknown, max = 200): string {
  if (typeof text !== "string") return "";
  const line = text.replace(/[\r\n\t]+/g, " ").replace(UNSEEN, "").replace(/\s{2,}/g, " ").trim();
  const cut = line.length > max ? `${line.slice(0, max - 1)}…` : line;
  // A space between the label's end and the address's start: no longer a link, and still readable.
  return cut.replace(/\]\s*\(/g, "] (");
}
