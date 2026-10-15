/** Anthropic API list prices in USD per million tokens (first-party rates, 2026-10). */
export interface Prices {
  input: number;
  output: number;
  cacheRead: number;
  /** Writing a 5-minute cache entry: 1.25× input. */
  cacheWrite5m: number;
  /** Writing a 1-hour cache entry: 2× input. */
  cacheWrite1h: number;
}

function prices(input: number, output: number, cacheRead: number): Prices {
  return { input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

/** Matched in order; the first pattern that fits the model id wins. */
const TABLE: [RegExp, Prices][] = [
  [/^claude-(fable|mythos)-5/, prices(10, 50, 0.25)],
  [/^claude-opus-5-5/, prices(4, 20, 0.2)],
  [/^claude-opus-(5|4-[678])/, prices(5, 25, 0.5)],
  [/^claude-sonnet-5/, prices(2, 10, 0.2)],
  [/^claude-sonnet-4-6/, prices(3, 15, 0.3)],
  [/^claude-haiku-5-5/, prices(0.1, 0.5, 0.01)],
  [/^claude-haiku-4-5/, prices(1, 5, 0.1)],
];

/** The prices for a model id, or undefined for a model Lookout doesn't know. */
export function pricesFor(model: string): Prices | undefined {
  const id = model.replace(/\[1m\]$/, "");
  return TABLE.find(([pattern]) => pattern.test(id))?.[1];
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** What a model's tokens cost at list prices, or undefined for an unknown model. */
export function costOf(model: string, tokens: TokenCounts): number | undefined {
  const p = pricesFor(model);
  if (!p) return undefined;
  return (tokens.input * p.input + tokens.output * p.output + tokens.cacheRead * p.cacheRead + tokens.cacheWrite5m * p.cacheWrite5m + tokens.cacheWrite1h * p.cacheWrite1h) / 1_000_000;
}
