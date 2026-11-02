/** Anthropic API list prices in USD per million tokens (first-party rates, read 2026-10-31 from https://platform.claude.com/docs/en/about-claude/pricing). */
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

interface ModelPrices {
  standard: Prices;
  /** A reply whose prompt is longer than `longAbove` tokens is priced at these. */
  long?: Prices;
  longAbove?: number;
  /** Fast mode's rates; the cache multipliers apply on top of them. */
  fast?: Prices;
}

/** Matched in order; the first pattern that fits the model id wins. */
const TABLE: [RegExp, ModelPrices][] = [
  [/^claude-(fable|mythos)-5-1/, { standard: prices(10, 50, 0.25) }],
  [/^claude-(fable|mythos)-5/, { standard: prices(10, 50, 1) }],
  [/^claude-opus-5-5/, { standard: prices(4, 20, 0.2), fast: prices(8, 40, 0.4) }],
  [/^claude-opus-(5|4-8)/, { standard: prices(5, 25, 0.5), fast: prices(10, 50, 1) }],
  [/^claude-opus-4-[567]/, { standard: prices(5, 25, 0.5) }],
  // Opus 4.1, and Opus 4 by its alias or its dated id (claude-opus-4-20250514).
  [/^claude-opus-4-(1|0|\d{8})/, { standard: prices(15, 75, 1.5) }],
  [/^claude-sonnet-5-5/, { standard: prices(2, 10, 0.1) }],
  [/^claude-sonnet-5/, { standard: prices(2, 10, 0.2) }],
  // Sonnet 4.6 and 4.5, and Sonnet 4 by its alias or its dated id.
  [/^claude-sonnet-4-([56]|0|\d{8})/, { standard: prices(3, 15, 0.3) }],
  // A prompt counts its cache reads and writes too.
  [/^claude-haiku-5-5/, { standard: prices(0.1, 0.5, 0.01), long: prices(0.5, 2.5, 0.05), longAbove: 100_000 }],
  [/^claude-haiku-4-5/, { standard: prices(1, 5, 0.1) }],
  [/^claude-3-5-haiku/, { standard: prices(0.8, 4, 0.08) }],
];

/** US-only inference (`inference_geo: "us"`) costs 1.1× in every category; only Claude 4.6 and later accept it. */
const US_ONLY = 1.1;

function modelPrices(model: string): ModelPrices | undefined {
  const id = model.replace(/\[1m\]$/, "");
  return TABLE.find(([pattern]) => pattern.test(id))?.[1];
}

/** A model's standard prices, or undefined for a model Lookout doesn't know. */
export function pricesFor(model: string): Prices | undefined {
  return modelPrices(model)?.standard;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** How a reply was served, as its `usage` says. */
export interface Service {
  /** `fast` for fast mode. */
  speed?: string;
  /** `us` for US-only inference. */
  inferenceGeo?: string;
}

/**
 * What one reply's tokens cost at list prices, or undefined for an unknown
 * model. Per reply, since a long prompt, fast mode and US-only inference
 * each change the price of that reply alone.
 */
export function replyCost(model: string, tokens: TokenCounts, service: Service = {}): number | undefined {
  const known = modelPrices(model);
  if (!known) return undefined;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  const long = known.long && known.longAbove !== undefined && prompt > known.longAbove ? known.long : undefined;
  const fast = service.speed === "fast" ? known.fast : undefined;
  const p = fast ?? long ?? known.standard;
  const geo = service.inferenceGeo === "us" ? US_ONLY : 1;
  return (geo * (tokens.input * p.input + tokens.output * p.output + tokens.cacheRead * p.cacheRead + tokens.cacheWrite5m * p.cacheWrite5m + tokens.cacheWrite1h * p.cacheWrite1h)) / 1_000_000;
}
