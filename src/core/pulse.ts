// The pulse on a card: tool calls per minute over the last 15 minutes, for any agent.

/** How far back the pulse looks. */
export const PULSE_WINDOW_MS = 15 * 60_000;
export const PULSE_BINS = 15;

/** The minute of the pulse window a time falls in, 0 the oldest, or undefined outside it. */
export function pulseBin(at: number, now: number): number | undefined {
  const start = now - PULSE_WINDOW_MS;
  if (at < start || at > now) return undefined;
  return Math.min(PULSE_BINS - 1, Math.floor((at - start) / (PULSE_WINDOW_MS / PULSE_BINS)));
}

/** How many of the newest minutes the pulse shows: all of them, or those since the session started. */
export function pulseLength(now: number, since?: number): number {
  if (since === undefined || since <= now - PULSE_WINDOW_MS) return PULSE_BINS;
  return Math.max(1, Math.min(PULSE_BINS, Math.floor((now - since) / (PULSE_WINDOW_MS / PULSE_BINS)) + 1));
}

/**
 * Tool calls per minute over the last 15 minutes, oldest first. A session
 * younger than that gets only the minutes since `since`, so its bars start at
 * the left and fill rightwards as it ages.
 */
export function pulseBins(times: Iterable<number>, now: number, since?: number): number[] {
  const bins = new Array<number>(PULSE_BINS).fill(0);
  for (const at of times) {
    const bin = pulseBin(at, now);
    if (bin !== undefined) bins[bin]!++;
  }
  return bins.slice(PULSE_BINS - pulseLength(now, since));
}
