import { Types } from 'mongoose';
export class QueryError extends Error { status = 400; }
function text(v: unknown): string | undefined { if (v === undefined) return; if (typeof v !== 'string') throw new QueryError('Invalid query parameter'); return v; }
export function timezoneName(v?: string) {
  const tz = v ?? process.env.REPORTING_TIMEZONE ?? 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }).format(); } catch { throw new QueryError('Invalid IANA timezone'); }
  return tz;
}
function midnight(date: string, timezone: string, next: boolean): Date {
  const [y,m,d] = date.split('-').map(Number);
  const calendar = new Date(Date.UTC(y,m-1,d));
  if (calendar.toISOString().slice(0,10) !== date) throw new QueryError('Invalid calendar date');
  if (next) calendar.setUTCDate(calendar.getUTCDate()+1);
  const target = calendar.getTime(); let value = target;
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' });
  for (let i=0;i<6;i++) {
    const p = Object.fromEntries(format.formatToParts(new Date(value)).map(p=>[p.type,p.value]));
    const actual = Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    const adjustment = target-actual;
    if (!adjustment) return new Date(value);
    value += adjustment;
  }
  throw new QueryError('Timezone has no unambiguous midnight for this date; use an ISO timestamp with offset');
}
function boundary(v: string | undefined, tz: string, end: boolean, fallback: Date) {
  if (!v) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return midnight(v,tz,end);
  if (!/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(v)) throw new QueryError('Use YYYY-MM-DD or ISO timestamp with offset');
  const d = new Date(v); if (!Number.isFinite(d.getTime())) throw new QueryError('Invalid date'); return d;
}
export function usageQuery(query: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const timezone = timezoneName(text(query.timezone));
  const now = new Date();
  const from = boundary(text(query.from),timezone,false,new Date(now.getTime()-30*86400000));
  const to = boundary(text(query.to),timezone,true,now);
  if (to <= from || to.getTime()-from.getTime() > 366*86400000) throw new QueryError('Choose a positive date range of at most 366 days');
  const match: Record<string, unknown> = { exportedAt: { $gte: from, $lt: to } };
  for (const [parameter,field] of [['personId','personIdAtTime'],['deviceId','deviceId']] as const) {
    const id = text(query[parameter]); if (id) { if (!/^[0-9a-f]{24}$/i.test(id)) throw new QueryError('Invalid '+parameter); match[field] = new Types.ObjectId(id); }
  }
  const sessionId = text(query.sessionId); if (sessionId) { if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) throw new QueryError('Invalid session ID'); match.sessionId = sessionId; }
  const model = text(query.model); if (model) { if (model.length>200) throw new QueryError('Invalid model'); match.usageModel=model; }
  return { timezone, from, to, match: { ...match, ...extra } };
}
export function csvCell(value: unknown) {
  let v = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(v)) v = "'" + v;
  return '"' + v.replace(/"/g,'""') + '"';
}
