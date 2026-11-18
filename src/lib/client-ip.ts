import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';

const exemptAddresses = new Set(['103.250.144.203', '2402:a00:408:4126:ac01:ad35:7114:f8d']);

export function normalizeClientIp(address: string): string | null {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6 || address.includes('%')) return null;
  const normalized = new URL('http://[' + address + ']').hostname.slice(1, -1);
  const mapped = normalized.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return normalized;
}

function verifiedClientIp(req: Request): string | null {
  const secret = process.env.CLIENT_IP_PROXY_SECRET;
  const ip = req.get('x-tracker-client-ip');
  const timestamp = req.get('x-tracker-client-time');
  const signature = req.get('x-tracker-client-signature');
  if (!secret || secret.length < 32 || !ip || !timestamp || !signature) return null;
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000) return null;
  const normalized = normalizeClientIp(ip);
  if (!normalized || !/^[a-f0-9]{64}$/.test(signature)) return null;
  const expected = createHmac('sha256', secret)
    .update(JSON.stringify([ip, timestamp, req.method, req.originalUrl]))
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex')) ? normalized : null;
}

export function clientRateLimitKey(req: Request): string {
  return verifiedClientIp(req) ?? normalizeClientIp(req.ip ?? '') ?? 'unknown';
}

export function authRateLimitExempt(req: Request): boolean {
  const ip = verifiedClientIp(req);
  return ip !== null && exemptAddresses.has(ip);
}
