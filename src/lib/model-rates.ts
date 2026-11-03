/** Official standard API USD / million tokens, checked 2026-11-03.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Cache creation assumes 5 minutes. These are estimates, not subscription billing.
 */
export interface TokenRates { input: number; output: number; cacheRead: number; cacheCreation: number }
export interface ModelRate { id: string; name: string; rates: TokenRates; aliases: string[]; note?: string; longPromptRates?: TokenRates }
const row = (id: string, name: string, input: number, output: number, cacheRead: number, aliases: string[] = []): ModelRate =>
  ({ id, name, rates: { input, output, cacheRead, cacheCreation: input * 1.25 }, aliases });
export const PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRICING_CHECKED = '2026-11-03';
export const PRICING_BASIS = 'Standard API speed; 5-minute cache writes. Haiku 5.5 estimates assume prompts up to 100,000 tokens; larger prompts cost 5×. Per-request prompt size, cache duration, fast mode, regional and batch modifiers are not available in stored telemetry. Not subscription billing.';
export const MODEL_CATALOG: ModelRate[] = [
  row('claude-fable-5-1', 'Claude Fable 5.1', 10, 50, .25),
  row('claude-opus-5-5', 'Claude Opus 5.5', 4, 20, .2),
  row('claude-sonnet-5-5', 'Claude Sonnet 5.5', 2, 10, .1),
  { ...row('claude-haiku-5-5', 'Claude Haiku 5.5', .1, .5, .01),
    note: 'Estimate assumes each prompt ≤100k tokens. Above 100k, all token rates are 5×; aggregate telemetry cannot determine the tier.',
    longPromptRates: { input: .5, output: 2.5, cacheRead: .05, cacheCreation: .625 } },
  row('claude-mythos-5-1', 'Claude Mythos 5.1', 10, 50, .25),
  row('claude-fable-5', 'Claude Fable 5', 10, 50, 1),
  row('claude-mythos-5', 'Claude Mythos 5', 10, 50, 1),
  row('claude-opus-5', 'Claude Opus 5', 5, 25, .5),
  row('claude-opus-4-8', 'Claude Opus 4.8', 5, 25, .5),
  row('claude-opus-4-7', 'Claude Opus 4.7', 5, 25, .5),
  row('claude-opus-4-6', 'Claude Opus 4.6', 5, 25, .5),
  row('claude-opus-4-5', 'Claude Opus 4.5', 5, 25, .5, ['claude-opus-4-5-20251101']),
  row('claude-opus-4-1', 'Claude Opus 4.1', 15, 75, 1.5, ['claude-opus-4-1-20250805']),
  row('claude-opus-4-0', 'Claude Opus 4', 15, 75, 1.5, ['claude-opus-4-20250514']),
  row('claude-sonnet-5', 'Claude Sonnet 5', 2, 10, .2),
  row('claude-sonnet-4-6', 'Claude Sonnet 4.6', 3, 15, .3),
  row('claude-sonnet-4-5', 'Claude Sonnet 4.5', 3, 15, .3, ['claude-sonnet-4-5-20250929']),
  row('claude-sonnet-4-0', 'Claude Sonnet 4', 3, 15, .3, ['claude-sonnet-4-20250514']),
  row('claude-haiku-4-5', 'Claude Haiku 4.5', 1, 5, .1, ['claude-haiku-4-5-20251001']),
  row('claude-3-5-haiku-20241022', 'Claude Haiku 3.5', .8, 4, .08, ['claude-3-5-haiku-latest']),
];
export const DEFAULT_RATES = Object.fromEntries(MODEL_CATALOG.flatMap(model => [model.id, ...model.aliases].map(id => [id, model.rates])));
