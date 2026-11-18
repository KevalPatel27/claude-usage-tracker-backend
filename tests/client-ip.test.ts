import { createHmac } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app';
import { normalizeClientIp } from '../src/lib/client-ip';

const secret = 'isolated-client-ip-proxy-test-secret-0000000000';
const previous = process.env.CLIENT_IP_PROXY_SECRET;
beforeAll(() => {
  process.env.CLIENT_IP_PROXY_SECRET = secret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.CLIENT_IP_PROXY_SECRET;
  else process.env.CLIENT_IP_PROXY_SECRET = previous;
});

function signed(ip: string, path = '/api/auth/logout', timestamp = String(Date.now())) {
  return {
    'x-tracker-client-ip': ip,
    'x-tracker-client-time': timestamp,
    'x-tracker-client-signature': createHmac('sha256', secret)
      .update(JSON.stringify([ip, timestamp, 'POST', path]))
      .digest('hex'),
  };
}

test('normalizes IPv6 and IPv4-mapped client addresses', () => {
  expect(normalizeClientIp('2402:0a00:0408:4126:ac01:ad35:7114:0f8d')).toBe(
    '2402:a00:408:4126:ac01:ad35:7114:f8d',
  );
  expect(normalizeClientIp('::ffff:103.250.144.203')).toBe('103.250.144.203');
  expect(normalizeClientIp('::ffff:67fa:90cb')).toBe('103.250.144.203');
  expect(normalizeClientIp('103.250.144.203:443')).toBeNull();
  expect(normalizeClientIp('fe80::1%eth0')).toBeNull();
});

test('clients behind the same frontend receive separate auth rate-limit buckets', async () => {
  for (let count = 0; count < 30; count++) {
    expect((await request(app).post('/api/auth/logout').set(signed('198.51.100.11'))).status).toBe(
      200,
    );
  }
  const blocked = await request(app).post('/api/auth/logout').set(signed('198.51.100.11'));
  expect(blocked.status).toBe(429);
  expect(blocked.body.error).toContain('Too many sign-in attempts');
  expect(blocked.headers['retry-after']).toBeDefined();
  expect((await request(app).post('/api/auth/logout').set(signed('198.51.100.12'))).status).toBe(
    200,
  );
});

test.each(['103.250.144.203', '2402:a00:408:4126:ac01:ad35:7114:f8d'])(
  'the approved client %s is exempt from auth throttling',
  async (ip) => {
    for (let count = 0; count < 205; count++) {
      expect((await request(app).post('/api/auth/logout').set(signed(ip))).status).toBe(200);
    }
  },
);

test('spoofed, expired and wrong-path proofs cannot enable the IP exception', async () => {
  const variants = [
    { ...signed('103.250.144.203'), 'x-tracker-client-signature': '0'.repeat(64) },
    signed('103.250.144.203', '/api/auth/logout', String(Date.now() - 120_000)),
    signed('103.250.144.203', '/api/auth/login'),
    { 'x-tracker-client-ip': '103.250.144.203' },
  ];
  for (const [index, headers] of variants.entries()) {
    for (let count = 0; count < 30; count++) {
      expect(
        (
          await request(app)
            .post('/api/auth/logout')
            .set('X-Forwarded-For', '198.51.100.' + (50 + index))
            .set(headers)
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await request(app)
          .post('/api/auth/logout')
          .set('X-Forwarded-For', '198.51.100.' + (50 + index))
          .set(headers)
      ).status,
    ).toBe(429);
  }
});
