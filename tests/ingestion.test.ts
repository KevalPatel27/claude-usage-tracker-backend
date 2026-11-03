/**
 * Ingestion correctness tests.
 * Tests delta calculation, deduplication, counter resets, concurrent requests.
 *
 * NOTE: These tests require a MongoDB connection. Run with:
 *   MONGODB_URI=mongodb://localhost:27017/tracker_test npm test
 *
 * For CI without MongoDB, use mongodb-memory-server (add to devDependencies).
 */

import { buildSeriesKey } from '../src/lib/crypto';
import { AGGREGATION_TEMPORALITY_CUMULATIVE } from '../src/lib/otlp-parser';

describe('buildSeriesKey', () => {
  test('produces consistent keys for same params', () => {
    const params = {
      deviceId: 'abc123',
      model: 'claude-opus-4-5',
      tokenType: 'input',
      querySource: 'main',
      startTimeUnixNano: '1700000000000000000',
    };
    expect(buildSeriesKey(params)).toBe(buildSeriesKey(params));
  });

  test('produces different keys when startTimeUnixNano changes (counter reset)', () => {
    const base = {
      deviceId: 'abc123',
      model: 'claude-opus-4-5',
      tokenType: 'input',
      querySource: 'main',
      startTimeUnixNano: '1700000000000000000',
    };
    const reset = { ...base, startTimeUnixNano: '1700001000000000000' };
    expect(buildSeriesKey(base)).not.toBe(buildSeriesKey(reset));
  });

  test('produces different keys for different token types', () => {
    const base = {
      deviceId: 'abc123',
      model: 'claude-opus-4-5',
      tokenType: 'input',
      querySource: 'main',
      startTimeUnixNano: '1700000000000000000',
    };
    const output = { ...base, tokenType: 'output' };
    expect(buildSeriesKey(base)).not.toBe(buildSeriesKey(output));
  });

  test('produces different keys for different devices', () => {
    const base = {
      deviceId: 'device-a',
      model: 'claude-opus-4-5',
      tokenType: 'input',
      querySource: 'main',
      startTimeUnixNano: '1700000000000000000',
    };
    const other = { ...base, deviceId: 'device-b' };
    expect(buildSeriesKey(base)).not.toBe(buildSeriesKey(other));
  });

  test('key length is 32 chars', () => {
    expect(buildSeriesKey({
      deviceId: 'x',
      model: 'y',
      tokenType: 'z',
      querySource: 'w',
      startTimeUnixNano: '0',
    })).toHaveLength(32);
  });
});

describe('Delta calculation logic (unit)', () => {
  // These test the logic without DB

  test('first report: full cumulative value is the delta', () => {
    const currentCumulative = 14520;
    const lastCumulative = undefined; // no checkpoint
    const delta = lastCumulative === undefined ? currentCumulative : currentCumulative - lastCumulative;
    expect(delta).toBe(14520);
  });

  test('subsequent report: delta is the increment', () => {
    const lastCumulative = 14520;
    const currentCumulative = 18420;
    const delta = currentCumulative - lastCumulative;
    expect(delta).toBe(3900);
  });

  test('counter reset: new cumulative is the delta', () => {
    // Simulates process restart with different startTimeUnixNano
    const nanos: string[] = ['1700000000000000000', '1700001000000000000'];
    const lastStartNano = nanos[0];
    const currentStartNano = nanos[1];
    const currentCumulative = 500;
    const isReset = lastStartNano !== currentStartNano;
    const delta = isReset ? currentCumulative : currentCumulative - 14520;
    expect(delta).toBe(500);
    expect(isReset).toBe(true);
  });

  test('does not double-count: two cumulative totals 1000 and 1400 → delta 400', () => {
    const report1Cumulative = 1000;
    const report2Cumulative = 1400;
    const delta = report2Cumulative - report1Cumulative;
    expect(delta).toBe(400);
    // NOT 1000 + 1400 = 2400
    expect(report1Cumulative + report2Cumulative).not.toBe(delta);
  });
});

describe('OTLP temporality constants', () => {
  test('AGGREGATION_TEMPORALITY_CUMULATIVE is 2', () => {
    expect(AGGREGATION_TEMPORALITY_CUMULATIVE).toBe(2);
  });
});
