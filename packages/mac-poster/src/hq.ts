/** The slice of HQ's `GET /admin/content` this helper reads (contract: `docs/admin-crm-api.md`, «Пульт v3»). */
export interface HqFile { path: string; type: 'png' | 'mp4'; w: number; h: number }
export interface HqItem {
  id: number | string;
  kind: 'clip' | 'post' | 'carousel' | 'story' | 'article';
  platform: string;
  status: 'draft' | 'pending' | 'approved' | 'rendering' | 'ready' | 'published' | 'rejected';
  title: string;
  caption: { instagram: string; tiktok?: string; shorts?: string; dzen?: string };
  files: HqFile[];
  publishedUrl: string | null;
  error: string | null;
  /** Newer HQ: platforms already marked published, the Instagram caption ready to paste. */
  publishedOn?: string[];
  igCaption?: string;
}
export interface HqDay { date: string; items: HqItem[] }

/** An HQ answer that is not ok. The message never carries the token. */
export class HqError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Fetch = typeof fetch;

export const encodeFilePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** `x-admin-token` client of HQ's admin API over the SSH tunnel (`http://127.0.0.1:<port>`). */
export class HqClient {
  constructor(private readonly base: string, private readonly token: string, private readonly fetchImpl: Fetch = fetch, private readonly timeoutMs = 30_000) {}

  private async req(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    let r: Response;
    try {
      r = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { 'x-admin-token': this.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new HqError(0, `HQ недоступен (${method} ${path.split('?')[0]}): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (r.status === 401) throw new HqError(401, 'HQ: 401, неверный MP_ADMIN_TOKEN');
    return r;
  }

  private async json(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const r = await this.req(method, path, body);
    const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (!r.ok || !j || j.ok !== true) throw new HqError(r.status, `HQ ${method} ${path.split('?')[0]}: ${r.status} ${String(j?.error ?? 'bad answer')}`);
    return j;
  }

  async content(week: string): Promise<HqDay[]> {
    const j = await this.json('GET', `/admin/content?week=${encodeURIComponent(week)}`);
    if (!Array.isArray(j.days)) throw new HqError(200, 'HQ: в ответе нет days');
    return j.days as HqDay[];
  }

  async file(path: string): Promise<Buffer> {
    const r = await this.req('GET', `/admin/files/${encodeFilePath(path)}`);
    if (!r.ok) throw new HqError(r.status, `HQ файл ${path}: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async published(id: HqItem['id'], url: string): Promise<HqItem> {
    return (await this.json('POST', `/admin/content/${id}`, { action: 'published', platform: 'instagram', url })).item as HqItem;
  }

  async failed(id: HqItem['id'], note: string): Promise<HqItem> {
    return (await this.json('POST', `/admin/content/${id}`, { action: 'failed', platform: 'instagram', note: clip(note, 300) })).item as HqItem;
  }
}

/** Cuts to `n` characters with an ellipsis. */
export const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
