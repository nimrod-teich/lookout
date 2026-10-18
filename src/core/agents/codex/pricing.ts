// OpenAI's list prices for the models Codex runs, per million tokens, to say
// what a session's tokens would cost through the API. A Codex session on a
// ChatGPT plan is not billed per token: these are API-equivalent figures.

interface Rates {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

interface ModelPrices {
  short: Rates;
  /** A reply whose input is longer than `longAbove` tokens is priced at these. */
  long?: Rates;
  longAbove?: number;
}

/**
 * Standard tier. Source: https://developers.openai.com/api/docs/pricing
 * (read 2026-10-18). A model not listed here has no price: its tokens show
 * without one.
 */
const PRICES: Record<string, ModelPrices> = {
  "gpt-6.1-sol": {
    short: { input: 2.0, cachedInput: 0.1, cacheWrite: 2.5, output: 10.0 },
    long: { input: 4.0, cachedInput: 0.2, cacheWrite: 5.0, output: 15.0 },
    longAbove: 272_000,
  },
};

/** One reply's tokens, as Codex's `token_usage_record` gives them. */
export interface ReplyTokens {
  input: number;
  /** Part of `input` read from the cache. */
  cached: number;
  cacheWrite: number;
  output: number;
}

/** What one reply would cost through the API, in USD; undefined when the model has no price here. */
export function replyCost(model: string | undefined, tokens: ReplyTokens): number | undefined {
  const prices = model === undefined ? undefined : PRICES[model];
  if (!prices) return undefined;
  const rates = prices.long && prices.longAbove !== undefined && tokens.input > prices.longAbove ? prices.long : prices.short;
  const uncached = Math.max(0, tokens.input - tokens.cached - tokens.cacheWrite);
  return (uncached * rates.input + tokens.cached * rates.cachedInput + tokens.cacheWrite * rates.cacheWrite + tokens.output * rates.output) / 1_000_000;
}
