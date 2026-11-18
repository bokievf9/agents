import { createSign } from 'node:crypto';
import type { FetchFn } from './worker.js';

export interface GscRow {
  key: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface GscReport {
  queries: GscRow[];
  pages: GscRow[];
  from: string;
  to: string;
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/** Service-account OAuth without a library: RS256 JWT bearer grant. The JSON key never leaves this function. */
async function accessToken(fetchFn: FetchFn, json: { client_email: string; private_key: string }, now: number): Promise<string> {
  const iat = Math.floor(now / 1000);
  const claim = { iss: json.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3000 };
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify(claim))}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(json.private_key).toString('base64url');
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GSC token HTTP ${res.status}`);
  const t = (await res.json()) as { access_token?: string };
  if (!t.access_token) throw new Error('GSC token: no access_token');
  return t.access_token;
}

/** Search Console: top queries and pages of the last 28 days (data lags about 3 days). */
export async function fetchGsc(fetchFn: FetchFn, serviceAccountJson: string, siteUrl: string, now: number): Promise<GscReport> {
  const json = JSON.parse(serviceAccountJson) as { client_email?: string; private_key?: string };
  if (!json.client_email || !json.private_key) throw new Error('GSC_SERVICE_ACCOUNT_JSON: нет client_email или private_key');
  const token = await accessToken(fetchFn, { client_email: json.client_email, private_key: json.private_key }, now);
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const to = ymd(now - 3 * 86_400_000);
  const from = ymd(now - 31 * 86_400_000);
  const query = async (dimension: 'query' | 'page'): Promise<GscRow[]> => {
    const res = await fetchFn(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: from, endDate: to, dimensions: [dimension], rowLimit: 10 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GSC query HTTP ${res.status}`);
    const data = (await res.json()) as { rows?: { keys: string[]; clicks: number; impressions: number; position: number }[] };
    return (data.rows ?? []).map((r) => ({ key: r.keys[0] ?? '', clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 }));
  };
  return { queries: await query('query'), pages: await query('page'), from, to };
}

export function gscText(r: GscReport): string {
  const fmt = (rows: GscRow[]) => rows.slice(0, 5).map((x) => `  ${x.key}: ${x.clicks} кликов, ${x.impressions} показов, позиция ${x.position}`).join('\n') || '  данных нет';
  return `Search Console ${r.from} - ${r.to}:\nЗапросы:\n${fmt(r.queries)}\nСтраницы:\n${fmt(r.pages)}`;
}
