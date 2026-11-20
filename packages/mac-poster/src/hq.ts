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
  /** Newer HQ: platforms an agent queued for this helper (`tools.mac.poster.enqueue`), still open. */
  macQueued?: string[];
  plannedDate?: string;
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

  /**
   * Items agents queued for this helper (`GET /admin/content?queued=1`, `queuedItems`: any week). Only those queued for `platform`;
   * an older HQ without the field gives an empty list.
   */
  async queued(platform = 'instagram'): Promise<HqItem[]> {
    const j = await this.json('GET', '/admin/content?queued=1');
    const items = Array.isArray(j.queuedItems) ? (j.queuedItems as HqItem[]) : [];
    return items.filter((x) => Array.isArray(x.macQueued) && x.macQueued.includes(platform));
  }

  async file(path: string): Promise<Buffer> {
    const r = await this.req('GET', `/admin/files/${encodeFilePath(path)}`);
    if (!r.ok) throw new HqError(r.status, `HQ файл ${path}: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** Agent Reach jobs waiting for the Mac (`GET /admin/reach/jobs?status=queued`); the channels the Mac has set up are reported in the same call. */
  async reachJobs(channels?: string[]): Promise<{ items: { id: number; channel: string; action: string; args: unknown }[]; counts: Record<string, number> }> {
    const qs = `status=queued&limit=20${channels ? `&channels=${encodeURIComponent(channels.join(','))}` : ''}`;
    const j = await this.json('GET', `/admin/reach/jobs?${qs}`);
    if (!Array.isArray(j.items)) throw new HqError(200, 'HQ: в ответе нет items');
    return { items: j.items as { id: number; channel: string; action: string; args: unknown }[], counts: (j.counts ?? {}) as Record<string, number> };
  }

  /** true: the job is ours; false: another run took it (409). */
  async reachClaim(id: number, channels?: string[]): Promise<boolean> {
    const r = await this.req('POST', `/admin/reach/jobs/${id}/claim`, channels ? { channels } : {});
    if (r.status === 409) return false;
    const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (!r.ok || !j || j.ok !== true) throw new HqError(r.status, `HQ claim ${id}: ${r.status} ${String(j?.error ?? 'bad answer')}`);
    return true;
  }

  async reachResult(id: number, body: { ok: true; result: unknown } | { ok: false; error: string }): Promise<void> {
    await this.json('POST', `/admin/reach/jobs/${id}/result`, body);
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
