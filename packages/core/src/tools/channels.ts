import { CHAIN_HOSTS, fetchTransfers, microToCents, tonRaw, type ChainMethod, type ChainTransfer } from '../chain.js';
import type { Db } from '../db.js';
import { errMsg } from '../log.js';
import { rawRequest } from './http.js';
import type { Kit } from './kit.js';
import { policyOf } from './policy.js';
import { dayIn, fail, failStatus, okv, type ToolResult } from './result.js';

export interface Telegram {
  /** A message to the owner (plain text, or Telegram HTML with `html: true`). Agents never write to other chats through tools. */
  send(text: string, o?: { html?: boolean }): Promise<ToolResult<{ sent: true }>>;
  /** A stored file (`files.put` path) to the owner as a document. */
  sendDocument(path: string, caption?: string): Promise<ToolResult<{ sent: true }>>;
  /** Stored pictures to the owner as an album. */
  sendPhotos(paths: string[], caption?: string): Promise<ToolResult<{ sent: true }>>;
}

export interface Email {
  /** One plain-text email through Resend. Outward action: call it only from an approved step (the owner saw the text). */
  send(m: { to: string; subject: string; text: string; replyTo?: string }): Promise<ToolResult<{ id: string }>>;
}

export interface MacPoster {
  /** Puts an approved content item into the queue the owner's Mac helper reads (`GET /admin/content?queued=1`). */
  enqueue(itemId: number, platform: 'instagram' | 'tiktok'): Promise<ToolResult<{ id: number; already: boolean }>>;
}

export interface Chain {
  /** Incoming USDT to `address` since `sinceMs` (TronGrid for TRC20, toncenter for TON); amounts in micro-units and cents. */
  transfers(method: ChainMethod, address: string, sinceMs: number): Promise<ToolResult<(ChainTransfer & { cents: number })[]>>;
}

export const RESEND_HOST = 'api.resend.com';
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;

export const MAC_QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS mac_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','done','failed')),
  agent_id TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS mac_queue_open ON mac_queue (item_id, platform) WHERE status = 'queued';
`;

/** Items waiting for the Mac helper, by item id -> platforms. */
export function macQueued(db: Db): Map<number, string[]> {
  db.exec(MAC_QUEUE_SCHEMA);
  const out = new Map<number, string[]>();
  for (const r of db.prepare("SELECT item_id, platform FROM mac_queue WHERE status = 'queued' ORDER BY id").all() as { item_id: number; platform: string }[]) {
    out.set(r.item_id, [...(out.get(r.item_id) ?? []), r.platform]);
  }
  return out;
}

/** The helper reported back (`POST /admin/content/:id` published or failed): the queued row is closed. */
export function macSettle(db: Db, itemId: number, platform: string | undefined, status: 'done' | 'failed', at: number): number {
  db.exec(MAC_QUEUE_SCHEMA);
  return platform
    ? db.prepare("UPDATE mac_queue SET status = ?, done_at = ? WHERE item_id = ? AND platform = ? AND status = 'queued'").run(status, at, itemId, platform).changes
    : db.prepare("UPDATE mac_queue SET status = ?, done_at = ? WHERE item_id = ? AND status = 'queued'").run(status, at, itemId).changes;
}

export function createTelegram(k: Kit): Telegram {
  const m = k.deps.messenger;
  const owner = k.deps.ownerId;
  const caption = (c?: string) => (c === undefined ? undefined : String(c).slice(0, 1024));
  return {
    send: (text, o = {}) =>
      k.call('telegram.send', async () => {
        if (typeof text !== 'string' || !text.trim() || text.length > 4000) return fail('invalid', 'text: 1..4000 characters');
        await m!.send(owner!, text, undefined, o.html ? { html: true } : undefined);
        return okv({ sent: true as const });
      }),
    sendDocument: (path, cap) =>
      k.call('telegram.sendDocument', async () => {
        const abs = k.files().absolute(path);
        if (!abs) return fail('not_found', 'no such stored file');
        await m!.sendDocument!(owner!, abs, caption(cap));
        return okv({ sent: true as const });
      }),
    sendPhotos: (paths, cap) =>
      k.call('telegram.sendPhotos', async () => {
        if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) return fail('invalid', 'paths: 1..20 stored pictures');
        const abs = paths.map((p) => k.files().absolute(p));
        if (abs.some((a) => !a || !/\.(png|jpe?g|webp)$/i.test(a))) return fail('not_found', 'a picture is missing or not an image');
        await m!.sendPhotos!(owner!, abs as string[], caption(cap));
        return okv({ sent: true as const });
      }),
  };
}

export function createEmail(k: Kit): Email {
  const key = k.cfg.resendApiKey;
  return {
    send: (msg) =>
      k.call('email.send', async () => {
        if (!msg || typeof msg.to !== 'string' || !EMAIL_RE.test(msg.to.trim())) return fail('invalid', 'to: one email address');
        if (msg.replyTo !== undefined && !EMAIL_RE.test(String(msg.replyTo).trim())) return fail('invalid', 'replyTo: one email address');
        if (typeof msg.subject !== 'string' || !msg.subject.trim() || msg.subject.length > 200 || /[\r\n]/.test(msg.subject)) return fail('invalid', 'subject: one line, 1..200 characters');
        if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 20_000) return fail('invalid', 'text: 1..20000 characters');
        const cap = policyOf('email.send')!.limits.perDay!;
        const counterKey = `tools.email.${dayIn(k.now(), k.tz)}`;
        const j = k.deps.journal;
        const sent = j ? Number(j.setting(counterKey) || 0) : 0;
        if (sent >= cap) return fail('rate_limited', `email cap of ${cap} a day reached`, { retryable: false });
        const body = JSON.stringify({ from: k.cfg.emailFrom, to: [msg.to.trim()], subject: msg.subject.trim(), text: msg.text, ...(msg.replyTo ? { reply_to: msg.replyTo.trim() } : {}) });
        const r = await rawRequest(`https://${RESEND_HOST}/emails`, {
          method: 'POST', hosts: [RESEND_HOST], headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }, body,
          timeoutMs: policyOf('email.send')!.limits.timeoutMs!, maxBytes: 100_000, perHost: 1, minGapMs: 600,
        }, k.net);
        if (!r.ok) return { ...r, retryable: false };
        if (r.value.status < 200 || r.value.status >= 300) return { ...failStatus(r.value.status, 'Resend'), retryable: false };
        j?.setSetting(counterKey, String(sent + 1));
        let id: string;
        try {
          id = String((JSON.parse(r.value.bytes.toString('utf8')) as { id?: unknown }).id ?? '');
        } catch {
          id = '';
        }
        return okv({ id });
      }),
  };
}

export function createMacPoster(k: Kit): MacPoster {
  const db = k.deps.db;
  return {
    enqueue: (itemId, platform) =>
      k.call<{ id: number; already: boolean }>('mac.poster.enqueue', async () => {
        if (!Number.isSafeInteger(itemId) || itemId <= 0) return fail('invalid', 'itemId: a positive integer');
        if (platform !== 'instagram' && platform !== 'tiktok') return fail('invalid', 'platform: instagram or tiktok');
        db!.exec(MAC_QUEUE_SCHEMA);
        if (db!.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cm_items'").get() && !db!.prepare('SELECT 1 FROM cm_items WHERE id = ?').get(itemId)) return fail('not_found', `no content item ${itemId}`);
        const open = db!.prepare("SELECT id FROM mac_queue WHERE item_id = ? AND platform = ? AND status = 'queued'").get(itemId, platform) as { id: number } | undefined;
        if (open) return okv({ id: open.id, already: true });
        const r = db!.prepare('INSERT INTO mac_queue (item_id, platform, agent_id, created_at) VALUES (?, ?, ?, ?)').run(itemId, platform, k.cx.agentId, k.now());
        return okv({ id: Number(r.lastInsertRowid), already: false });
      }),
  };
}

export function createChain(k: Kit): Chain {
  return {
    transfers: (method, address, sinceMs) =>
      k.call('chain.transfers', async () => {
        if (method !== 'usdt_trc20' && method !== 'usdt_ton') return fail('invalid', 'method: usdt_trc20 or usdt_ton');
        if (typeof address !== 'string' || (method === 'usdt_trc20' ? !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address) : !tonRaw(address))) return fail('invalid', 'address: not a valid address of that network');
        if (!Number.isFinite(sinceMs) || sinceMs < 0) return fail('invalid', 'sinceMs: epoch milliseconds');
        const l = policyOf('chain.transfers')!.limits;
        const key = method === 'usdt_trc20' ? k.cfg.trongridApiKey : k.cfg.toncenterApiKey;
        let out;
        try {
          out = await fetchTransfers(async (url, headers) => {
            const r = await rawRequest(url, { hosts: CHAIN_HOSTS, headers: { accept: 'application/json', ...headers }, timeoutMs: l.timeoutMs!, maxBytes: l.maxBytes!, perHost: l.perHost!, minGapMs: l.minGapMs! }, k.net);
            if (!r.ok) return { ok: false, status: r.status ?? 0, error: r.error };
            let body: unknown;
            try {
              body = r.value.status >= 200 && r.value.status < 300 ? JSON.parse(r.value.bytes.toString('utf8')) : null;
            } catch {
              body = null;
            }
            return { ok: true, status: r.value.status, body };
          }, method, address, sinceMs, key);
        } catch (e) {
          return fail('internal', errMsg(e));
        }
        if (!out.ok) return fail(/^http 429/.test(out.reason) ? 'rate_limited' : out.retryable ? (out.reason === 'timeout' ? 'timeout' : 'network') : 'upstream', `chain: ${out.reason}`, { retryable: out.retryable });
        return okv(out.transfers.map((t) => ({ ...t, cents: microToCents(t.amountMicro) })));
      }),
  };
}
