// Anthropic published rates as of 2026-04. Matches agent-ledger v0.7 pricing.
// Units: USD per million tokens.

export interface ModelPricing {
  input: number;
  output: number;
  cache5mWrite: number;
  cache1hWrite: number;
  cacheRead: number;
}

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7":   { input: 15, output: 75, cache5mWrite: 18.75, cache1hWrite: 30,   cacheRead: 1.5 },
  "claude-opus-4-6":   { input: 15, output: 75, cache5mWrite: 18.75, cache1hWrite: 30,   cacheRead: 1.5 },
  "claude-sonnet-4-6": { input:  3, output: 15, cache5mWrite:  3.75, cache1hWrite:  6,   cacheRead: 0.3 },
  "claude-sonnet-4-5": { input:  3, output: 15, cache5mWrite:  3.75, cache1hWrite:  6,   cacheRead: 0.3 },
  "claude-haiku-4-5":  { input: 0.8, output: 4, cache5mWrite:  1.0,  cache1hWrite:  1.6, cacheRead: 0.08 },
};

export function priceFor(model: string): ModelPricing {
  // Normalize long names like "claude-haiku-4-5-20251001" to canonical key.
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key]!;
  }
  // Unknown model — assume Sonnet pricing as a safe middle estimate.
  return PRICING["claude-sonnet-4-6"]!;
}

export function fmtUSD(n: number): string {
  if (n >= 1000) return `$${n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  if (n >= 10) return `$${n.toFixed(0)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}
