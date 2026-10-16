// Pure text helpers shared by the extension and the webviews; nothing from Node here.

/** The words of a query, lowercased. A message matches when it contains every one of them. */
export function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** [start, end) of every term in the text, in order, overlaps merged. */
export function matchRanges(text: string, terms: string[]): [number, number][] {
  const lower = text.toLowerCase();
  const found: [number, number][] = [];
  for (const term of terms) {
    if (term === "") continue;
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) found.push([at, at + term.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const ranges: [number, number][] = [];
  for (const range of found) {
    const last = ranges.at(-1);
    if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([range[0], range[1]]);
  }
  return ranges;
}

/** The text holds every term. */
export function matchesAll(text: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
}
