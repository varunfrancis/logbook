/** Anthropic API list prices, $ per million tokens. Only used for "API prices" in Settings: on a Claude plan nothing is paid per token. */
type Rates = { in: number; out: number; read: number };

// First match wins, so more specific names come first. Cache writes are priced from `in`: 1.25x for 5-minute, 2x for 1-hour.
const RATES: [RegExp, Rates][] = [
  [/fable-5|mythos-5/, { in: 10, out: 50, read: 0.25 }],
  [/opus-5-5/, { in: 4, out: 20, read: 0.2 }],
  [/opus-(5|4-[5-9])/, { in: 5, out: 25, read: 0.5 }],
  [/opus/, { in: 15, out: 75, read: 1.5 }], // Opus 4 / 4.1 and older
  [/sonnet-5/, { in: 2, out: 10, read: 0.2 }],
  [/sonnet/, { in: 3, out: 15, read: 0.3 }],
  [/haiku-5/, { in: 0.1, out: 0.5, read: 0.01 }],
  [/haiku-4/, { in: 1, out: 5, read: 0.1 }],
  [/haiku/, { in: 0.8, out: 4, read: 0.08 }],
];
const DEFAULT = RATES[1][1]; // unknown model: price it like the current Opus

export const ratesFor = (model: string | null | undefined): Rates => RATES.find(([re]) => re.test(model ?? ''))?.[1] ?? DEFAULT;

/** What one API reply would cost at list prices, from the `usage` block Claude Code writes into the transcript. */
export function usdOf(model: string | null | undefined, u: any): number {
  if (!u) return 0;
  const r = ratesFor(model);
  const write = u.cache_creation_input_tokens || 0;
  const w1h = Math.min(write, u.cache_creation?.ephemeral_1h_input_tokens || 0);
  const usd = ((u.input_tokens || 0) * r.in + (u.output_tokens || 0) * r.out + (u.cache_read_input_tokens || 0) * r.read
    + w1h * r.in * 2 + (write - w1h) * r.in * 1.25) / 1e6;
  return u.speed === 'fast' ? usd * 2 : usd; // fast mode is billed at twice the standard rate
}
