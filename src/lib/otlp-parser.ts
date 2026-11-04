/** Strict OTLP/HTTP JSON token sums. Other metrics are intentionally ignored. */
import { z } from 'zod';
import { createHash } from 'crypto';
export const AGGREGATION_TEMPORALITY_DELTA = 1;
export const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
export interface ParsedDataPoint {
  sessionId?: string | null;
  model: string; tokenType: string; querySource: string;
  startTimeUnixNano: string; timeUnixNano: string; asInt: number;
  aggregationTemporality: number; isMonotonic: boolean; identityHash?: string;
}
export interface ParsedMetricsPayload {
  serviceName: string; dataPoints: ParsedDataPoint[];
}
const attr = z.object({ key: z.string().max(256), value: z.record(z.unknown()) });
const attrs = z.array(attr).max(128).default([]);
const point = z.object({ attributes: attrs, startTimeUnixNano: z.string().regex(/^\d{1,20}$/),
  timeUnixNano: z.string().regex(/^\d{1,20}$/), asInt: z.union([z.string().regex(/^\d+$/), z.number()]).optional(),
  asDouble: z.number().optional(), flags: z.number().int().optional() });
const root = z.object({ resourceMetrics: z.array(z.object({
  resource: z.object({ attributes: attrs }).optional(), schemaUrl: z.string().optional(),
  scopeMetrics: z.array(z.object({ scope: z.unknown().optional(), schemaUrl: z.string().optional(),
    metrics: z.array(z.object({ name: z.string(), sum: z.unknown().optional(), unit: z.string().optional() })).max(256)
  })).max(128).default([])
})).max(128).default([]) }).refine(v => Object.keys(v).includes('resourceMetrics'));
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => JSON.stringify(k)+':'+canonical(x)).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
}
function sortedAttributes(v: z.infer<typeof attr>[]) { return [...v].sort((a,b) => a.key.localeCompare(b.key)); }
function stringAttr(v: z.infer<typeof attr>[], key: string) {
  const value = v.find(a => a.key === key)?.value.stringValue;
  return typeof value === 'string' ? value : undefined;
}
export function parseOtlpMetricsPayload(body: unknown): ParsedMetricsPayload[] {
  if (!body || typeof body !== 'object' || !('resourceMetrics' in body)) throw new Error('Expected OTLP resourceMetrics');
  const data = root.parse(body);
  let count = 0;
  return data.resourceMetrics.map(rm => {
    const dataPoints: ParsedDataPoint[] = [];
    const resource = rm.resource?.attributes ?? [];
    for (const sm of rm.scopeMetrics) for (const m of sm.metrics) {
      if (m.name !== 'claude_code.token.usage') continue;
      const sum = z.object({ aggregationTemporality: z.union([z.literal(1),z.literal(2)]),
        isMonotonic: z.literal(true), dataPoints: z.array(point).max(10000) }).parse(m.sum);
      for (const dp of sum.dataPoints) {
        if (++count > 10000) throw new Error('Too many token data points');
        if (dp.flags && (dp.flags & 1)) continue; // OTLP no recorded value
        const start = BigInt(dp.startTimeUnixNano), end = BigInt(dp.timeUnixNano);
        if (start <= 0n || end < start || end > 8640000000000000000000n) throw new Error('Invalid counter timestamps');
        if ((dp.asInt === undefined) === (dp.asDouble === undefined)) throw new Error('Exactly one counter value required');
        const value = Number(dp.asInt ?? dp.asDouble);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Token count must be a nonnegative safe integer');
        const model = stringAttr(dp.attributes,'model');
        const tokenType = stringAttr(dp.attributes,'type');
        if (!model || model.length > 200 || !['input','output','cacheRead','cacheCreation'].includes(tokenType ?? '')) throw new Error('Missing model or unsupported token category');
        const querySource = stringAttr(dp.attributes,'query_source') ?? 'main';
        if (!querySource || querySource.length > 200) throw new Error('Invalid query source');
        const rawSessionId = stringAttr(dp.attributes,'session.id') ?? stringAttr(resource,'session.id');
        const sessionId = rawSessionId && /^[A-Za-z0-9._:-]{1,128}$/.test(rawSessionId) ? rawSessionId : null;
        // Preserve ALL dimensions in a nonreversible fingerprint, including session.id.
        // Only the explicit session ID is retained separately; raw resources/emails/prompts are not stored.
        const identityHash = createHash('sha256').update(canonical([
          sortedAttributes(resource), rm.schemaUrl, sm.scope, sm.schemaUrl,
          m.name, m.unit, sortedAttributes(dp.attributes), sum.aggregationTemporality
        ])).digest('hex');
        dataPoints.push({ model, sessionId, tokenType: tokenType!, querySource,
          startTimeUnixNano: start.toString(), timeUnixNano: end.toString(), asInt: value,
          aggregationTemporality: sum.aggregationTemporality, isMonotonic: true, identityHash });
      }
    }
    return { serviceName: stringAttr(resource,'service.name') ?? 'claude-code', dataPoints };
  });
}
