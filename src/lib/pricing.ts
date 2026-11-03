import { z } from 'zod';
import { DEFAULT_RATES, MODEL_CATALOG, PRICING_BASIS, PRICING_CHECKED, PRICING_SOURCE } from './model-rates.js';
const categories = ['input', 'output', 'cacheRead', 'cacheCreation'] as const;
const rate = z.number().finite().nonnegative();
const catalogSchema = z.record(z.object({ input: rate, output: rate, cacheRead: rate, cacheCreation: rate }));
export type RateCatalog = z.infer<typeof catalogSchema>;
export interface ModelCategoryTotal { _id: { model: string; tokenType: string }; totalTokens: number }
export function readPricing() {
  try {
    const overrides = catalogSchema.parse(JSON.parse(process.env.MODEL_RATES_JSON || '{}'));
    const rates = { ...DEFAULT_RATES, ...overrides };
    // A canonical override also covers its documented snapshot aliases, unless explicitly overridden.
    for (const model of MODEL_CATALOG) if (Object.hasOwn(overrides, model.id)) {
      for (const alias of model.aliases) if (!Object.hasOwn(overrides, alias)) rates[alias] = overrides[model.id];
    }
    return { rates, error: null };
  }
  catch { return { rates: {} as RateCatalog, error: 'Model pricing is not configured correctly.' }; }
}
export function estimateCost(rows: ModelCategoryTotal[], rates: RateCatalog) {
  let amount = 0;
  const unpricedModels = new Set<string>();
  for (const row of rows) {
    if (!categories.includes(row._id.tokenType as typeof categories[number])) { unpricedModels.add(row._id.model); continue; }
    const value = Object.hasOwn(rates, row._id.model) ? rates[row._id.model][row._id.tokenType as typeof categories[number]] : undefined;
    if (value === undefined) unpricedModels.add(row._id.model);
    else amount += row.totalTokens * value / 1000000;
  }
  return { amount: rows.length && !unpricedModels.size ? amount : null, unpricedModels: [...unpricedModels].sort() };
}
export function pricingMetadata(pricing = readPricing()) {
  return {
    source: PRICING_SOURCE, verifiedAt: PRICING_CHECKED, basis: PRICING_BASIS,
    overrideSource: process.env.MODEL_RATES_SOURCE || null, overrideVerifiedAt: process.env.MODEL_RATES_VERIFIED_AT || null,
    overrideBasis: process.env.MODEL_RATES_BASIS || null,
    catalog: MODEL_CATALOG.map(model => ({
      ...model, rates: pricing.rates[model.id] ?? null,
      overridden: !!pricing.rates[model.id] && JSON.stringify(pricing.rates[model.id]) !== JSON.stringify(DEFAULT_RATES[model.id])
    })),
  };
}
