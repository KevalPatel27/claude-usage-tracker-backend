/**
 * Tests for the OTLP parser.
 * Uses sanitized fixtures modeled on real Claude Code payload structure.
 */

import {
  parseOtlpMetricsPayload,
  AGGREGATION_TEMPORALITY_CUMULATIVE,
  AGGREGATION_TEMPORALITY_DELTA,
} from '../src/lib/otlp-parser';

// Sanitized fixture: real Claude Code OTLP HTTP/JSON payload structure
const samplePayload = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'claude-code' } },
          { key: 'telemetry.sdk.language', value: { stringValue: 'node' } },
          { key: 'service.version', value: { stringValue: '1.0.0' } },
          { key: 'user.email', value: { stringValue: 'developer@example.com' } },
        ],
      },
      scopeMetrics: [
        {
          scope: { name: 'claude-code', version: '1.0.0' },
          metrics: [
            {
              name: 'claude_code.token.usage',
              description: 'Token usage by type',
              unit: '{token}',
              sum: {
                dataPoints: [
                  {
                    attributes: [
                      { key: 'model', value: { stringValue: 'claude-opus-4-5' } },
                      { key: 'type', value: { stringValue: 'input' } },
                      { key: 'query_source', value: { stringValue: 'main' } },
                    ],
                    startTimeUnixNano: '1700000000000000000',
                    timeUnixNano: '1700000060000000000',
                    asInt: '14520',
                  },
                  {
                    attributes: [
                      { key: 'model', value: { stringValue: 'claude-opus-4-5' } },
                      { key: 'type', value: { stringValue: 'output' } },
                      { key: 'query_source', value: { stringValue: 'main' } },
                    ],
                    startTimeUnixNano: '1700000000000000000',
                    timeUnixNano: '1700000060000000000',
                    asInt: '3200',
                  },
                  {
                    attributes: [
                      { key: 'model', value: { stringValue: 'claude-opus-4-5' } },
                      { key: 'type', value: { stringValue: 'cacheRead' } },
                      { key: 'query_source', value: { stringValue: 'main' } },
                    ],
                    startTimeUnixNano: '1700000000000000000',
                    timeUnixNano: '1700000060000000000',
                    asInt: '9800',
                  },
                ],
                aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
                isMonotonic: true,
              },
            },
          ],
        },
      ],
    },
  ],
};

test('retains point session ID with resource fallback without storing other identity attributes',()=>{
 const p=structuredClone(samplePayload),resource=p.resourceMetrics[0].resource.attributes;
 resource.push({key:'session.id',value:{stringValue:'resource-session'}});
 let result=parseOtlpMetricsPayload(p)[0].dataPoints;
 expect(result.every(dp=>dp.sessionId==='resource-session')).toBe(true);
 p.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes.push({key:'session.id',value:{stringValue:'point-session'}});
 result=parseOtlpMetricsPayload(p)[0].dataPoints;expect(result[0].sessionId).toBe('point-session');
 expect(JSON.stringify(result)).not.toContain('developer@example.com');
});
test('missing or malformed session identifiers do not reject otherwise valid token reporting',()=>{
 for(const id of ['', 'unsafe id', 'x'.repeat(129)]){
  const p=structuredClone(samplePayload);p.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes.push({key:'session.id',value:{stringValue:id}});
  expect(parseOtlpMetricsPayload(p)[0].dataPoints[0].sessionId).toBeNull();
 }
 expect(parseOtlpMetricsPayload(samplePayload)[0].dataPoints[0].sessionId).toBeNull();
});

describe('parseOtlpMetricsPayload', () => {
  test('parses resource attributes correctly', () => {
    const result = parseOtlpMetricsPayload(samplePayload);
    expect(result).toHaveLength(1);
    expect(result[0].serviceName).toBe('claude-code');
    expect(result[0]).not.toHaveProperty('userEmail');
    expect(result[0]).not.toHaveProperty('rawResourceAttributes');
  });

  test('extracts all data points', () => {
    const result = parseOtlpMetricsPayload(samplePayload);
    expect(result[0].dataPoints).toHaveLength(3);
  });

  test('correctly parses token types', () => {
    const result = parseOtlpMetricsPayload(samplePayload);
    const types = result[0].dataPoints.map(dp => dp.tokenType);
    expect(types).toContain('input');
    expect(types).toContain('output');
    expect(types).toContain('cacheRead');
  });

  test('correctly parses integer token counts from string asInt', () => {
    const result = parseOtlpMetricsPayload(samplePayload);
    const inputDp = result[0].dataPoints.find(dp => dp.tokenType === 'input')!;
    expect(inputDp.asInt).toBe(14520);
  });

  test('correctly identifies cumulative temporality', () => {
    const result = parseOtlpMetricsPayload(samplePayload);
    result[0].dataPoints.forEach(dp => {
      expect(dp.aggregationTemporality).toBe(AGGREGATION_TEMPORALITY_CUMULATIVE);
    });
  });

  test('ignores metrics that are not claude_code.token.usage', () => {
    const payloadWithOtherMetric = {
      resourceMetrics: [
        {
          ...samplePayload.resourceMetrics[0],
          scopeMetrics: [
            {
              scope: { name: 'other', version: '1.0.0' },
              metrics: [
                {
                  name: 'some.other.metric',
                  sum: {
                    dataPoints: [
                      {
                        attributes: [],
                        startTimeUnixNano: '0',
                        timeUnixNano: '1000000000000000000',
                        asInt: '999',
                      },
                    ],
                    aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
                    isMonotonic: true,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parseOtlpMetricsPayload(payloadWithOtherMetric);
    expect(result[0].dataPoints).toHaveLength(0);
  });

  test('returns empty array for empty resourceMetrics', () => {
    const result = parseOtlpMetricsPayload({ resourceMetrics: [] });
    expect(result).toHaveLength(0);
  });

  test('throws for non-object payload', () => {
    expect(() => parseOtlpMetricsPayload('invalid')).toThrow();
    expect(() => parseOtlpMetricsPayload(null)).toThrow();
  });

  test('handles asInt as number (not string)', () => {
    const payload = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
          scopeMetrics: [
            {
              scope: { name: 'claude-code' },
              metrics: [
                {
                  name: 'claude_code.token.usage',
                  sum: {
                    dataPoints: [
                      {
                        attributes: [
                          { key: 'model', value: { stringValue: 'claude-3-5-sonnet' } },
                          { key: 'type', value: { stringValue: 'output' } },
                          { key: 'query_source', value: { stringValue: 'main' } },
                        ],
                        startTimeUnixNano: '1700000000000000000',
                        timeUnixNano: '1700000060000000000',
                        asInt: 5000,  // number, not string
                      },
                    ],
                    aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
                    isMonotonic: true,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = parseOtlpMetricsPayload(payload);
    expect(result[0].dataPoints[0].asInt).toBe(5000);
  });
});


describe('Bounded searchable telemetry dimensions', () => {
  test.each(['model', 'query_source'])('rejects oversized %s before persistence', key => {
    const payload = JSON.parse(JSON.stringify(samplePayload));
    const point = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
    point.attributes = point.attributes.filter((a: { key: string }) => a.key !== key);
    point.attributes.push({ key, value: { stringValue: 'x'.repeat(201) } });
    expect(() => parseOtlpMetricsPayload(payload)).toThrow();
  });
});
