import { AsyncLocalStorage } from 'node:async_hooks';
import { errMsg, log, migrate, type Button, type Db, type Messenger } from '@fir/core';
import type { Hq } from '@fir/hq';

export type InboxKind = 'message' | 'approval' | 'progress' | 'alert' | 'summary' | 'reply';
export type PresenceMode = 'desk' | 'away';

export interface InboxItem {
  id: number;
  at: number;
  kind: InboxKind;
  text: string;
  taskId: number | null;
  approvalId: number | null;
  read: boolean;
  deliveredTg: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  task_id INTEGER,
  approval_id INTEGER,
  delivered_tg INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0,
  buttons TEXT
);
CREATE INDEX IF NOT EXISTS owner_inbox_unread ON owner_inbox (read, id);
`;

const DIGEST_WINDOW_MS = 2 * 3_600_000;
const INBOX_KEEP_MS = 30 * 86_400_000;

export interface NotifyOpts {
  buttons?: Button[][];
  taskId?: number;
  /** Goes to Telegram even at the desk (presence confirmations). */
  force?: boolean;
}

export interface OwnerChannelDeps {
  hq: Hq;
  inner: Messenger;
  ownerId: number;
  /** The site is considered gone after this many minutes without a ping. */
  awayAfterMin?: number;
  /** Is the core approval still waiting for the owner? Used to keep digests and resends honest. */
  approvalPending?: (approvalId: number) => boolean;
}

type Scope = { mode: 'capture'; replies: string[] } | { mode: 'reply' };

/**
 * Everything addressed to the owner goes through here (it is the `Messenger` of the Director, the approval queue and the heads).
 * Each message is stored in the owner inbox (the website reads it) and reaches Telegram only when the owner is away (effective
 * presence), or when forced. Messages to any other chat pass straight through. Two scopes (AsyncLocalStorage):
 * `capture`: the website ran a command, the Director's replies are collected and returned inline (not stored, not sent);
 * `reply`: the owner talks to the bot in Telegram, so the answers always go to Telegram.
 */
export class OwnerChannel implements Messenger {
  private readonly als = new AsyncLocalStorage<Scope>();
  readonly awayAfterMin: number;

  constructor(private readonly d: OwnerChannelDeps) {
    this.awayAfterMin = d.awayAfterMin ?? 20;
    migrate(d.hq.db, SCHEMA);
  }

  private get db(): Db {
    return this.d.hq.db;
  }

  // ---- presence ----
  get mode(): PresenceMode {
    return this.d.hq.setting('presence.mode') === 'desk' ? 'desk' : 'away';
  }

  get lastPingAt(): number | null {
    return Number(this.d.hq.setting('presence.lastPingAt')) || null;
  }

  effective(): PresenceMode {
    if (this.mode === 'away') return 'away';
    const last = this.lastPingAt;
    if (last === null || this.d.hq.now() - last >= this.awayAfterMin * 60_000) return 'away';
    return 'desk';
  }

  async setMode(mode: PresenceMode): Promise<void> {
    this.d.hq.setSetting('presence.mode', mode);
    // switching to the desk is itself a sign of life (the 20 minutes start now)
    if (mode === 'desk') this.d.hq.setSetting('presence.lastPingAt', String(this.d.hq.now()));
    await this.sync();
  }

  async ping(): Promise<void> {
    this.d.hq.setSetting('presence.lastPingAt', String(this.d.hq.now()));
    await this.sync();
  }

  /** Notices a change of effective presence (also the automatic one); on desk to away sends the digest. Called by a timer. */
  async sync(): Promise<void> {
    const eff = this.effective();
    const prev = this.d.hq.setting('presence.effective') === 'desk' ? 'desk' : 'away';
    if (eff === prev) return;
    this.d.hq.setSetting('presence.effective', eff);
    if (eff === 'away') await this.digest();
  }

  /** One Telegram message instead of a replay of what the owner could see on the site. */
  private async digest(): Promise<void> {
    const since = this.d.hq.now() - DIGEST_WINDOW_MS;
    const rows = (this.db
      .prepare("SELECT id, kind, approval_id FROM owner_inbox WHERE delivered_tg = 0 AND read = 0 AND at >= ? AND kind IN ('approval','progress','alert')")
      .all(since) as { id: number; kind: InboxKind; approval_id: number | null }[])
      .filter((r) => r.kind !== 'approval' || r.approval_id === null || !this.d.approvalPending || this.d.approvalPending(r.approval_id));
    if (!rows.length) return;
    const n = (k: InboxKind) => rows.filter((r) => r.kind === k).length;
    const text = `Пока вы были на месте: ${n('approval')} одобрений, ${n('progress')} задач готово, ${n('alert')} алертов. /approve, /status`;
    const ids = rows.map((r) => r.id);
    try {
      await this.d.inner.send(this.d.ownerId, text);
      this.db.prepare(`UPDATE owner_inbox SET delivered_tg = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      log('info', 'presence digest sent', { items: ids.length });
    } catch (e) {
      log('warn', 'presence digest failed', { err: errMsg(e) });
    }
  }

  // ---- scopes ----
  /** Runs `fn` so that the Director's owner-bound messages are collected instead of stored and sent. */
  async capture<T>(fn: () => Promise<T>): Promise<{ result: T; replies: string[] }> {
    const replies: string[] = [];
    const result = await this.als.run({ mode: 'capture', replies }, fn);
    return { result, replies };
  }

  /** Everything started inside `fn` answers the owner in Telegram (his own message there, a button press). */
  asReply<T>(fn: () => T): T {
    return this.als.run({ mode: 'reply' }, fn);
  }

  capturing(): boolean {
    return this.als.getStore()?.mode === 'capture';
  }

  /** Live task messages stay off Telegram when the owner is at the desk or the command comes from the site. */
  webOnly(): boolean {
    const s = this.als.getStore();
    if (s?.mode === 'capture') return true;
    if (s?.mode === 'reply') return false;
    return this.effective() === 'desk';
  }

  // ---- sending ----
  send(chatId: number, text: string, buttons?: Button[][]): Promise<void> {
    return this.sendMessage(chatId, text, buttons).then(() => undefined);
  }

  async sendMessage(chatId: number, text: string, buttons?: Button[][]): Promise<number> {
    if (chatId !== this.d.ownerId) return this.d.inner.sendMessage(chatId, text, buttons);
    return this.notify(undefined, text, buttons ? { buttons } : {});
  }

  edit(chatId: number, messageId: number, text: string): Promise<void> {
    return this.d.inner.edit(chatId, messageId, text);
  }

  private classify(text: string, buttons?: Button[][]): { kind: InboxKind; approvalId: number | null } {
    for (const row of buttons ?? []) {
      for (const b of row) {
        const m = /^ap:(\d+):[aer]$/.exec(b.data);
        if (m) return { kind: 'approval', approvalId: Number(m[1]) };
      }
    }
    if (/^Алерт:/.test(text)) return { kind: 'alert', approvalId: null };
    if (/^Утренняя сводка/.test(text)) return { kind: 'summary', approvalId: null };
    return { kind: 'message', approvalId: null };
  }

  /** The one way to the owner. Returns the Telegram message id, or 0 when nothing went to Telegram. */
  async notify(kind: InboxKind | undefined, text: string, o: NotifyOpts = {}): Promise<number> {
    const scope = this.als.getStore();
    if (scope?.mode === 'capture') {
      scope.replies.push(text);
      return 0;
    }
    await this.sync();
    const c = this.classify(text, o.buttons);
    const inReply = scope?.mode === 'reply';
    const k: InboxKind = c.kind === 'approval' ? 'approval' : inReply ? 'reply' : (kind ?? c.kind);
    const toTg = Boolean(o.force) || inReply || this.effective() === 'away';
    const id = this.insert(k, text, o.taskId ?? null, c.approvalId, o.buttons, inReply && k === 'reply');
    if (!toTg) return 0;
    const msgId = await this.d.inner.sendMessage(this.d.ownerId, text, o.buttons);
    this.db.prepare('UPDATE owner_inbox SET delivered_tg = 1 WHERE id = ?').run(id);
    return msgId;
  }

  /** Stores a line in the inbox that the owner already has elsewhere (an edited Telegram message): no sending. */
  record(kind: InboxKind, text: string, taskId?: number): void {
    if (this.capturing()) return;
    this.insert(kind, text, taskId ?? null, null, undefined, false, true);
  }

  private insert(kind: InboxKind, text: string, taskId: number | null, approvalId: number | null, buttons: Button[][] | undefined, read: boolean, delivered = false): number {
    const r = this.db
      .prepare('INSERT INTO owner_inbox (at, kind, text, task_id, approval_id, delivered_tg, read, buttons) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.d.hq.now(), kind, text.slice(0, 8000), taskId, approvalId, delivered ? 1 : 0, read ? 1 : 0, buttons ? JSON.stringify(buttons) : null);
    // the inbox is a feed, not an archive
    if (Number(r.lastInsertRowid) % 50 === 0) this.db.prepare('DELETE FROM owner_inbox WHERE at < ?').run(this.d.hq.now() - INBOX_KEEP_MS);
    return Number(r.lastInsertRowid);
  }

  /** `/approve` in Telegram: pending approval cards that never reached it (sent while at the desk) go out now. */
  async resendUndelivered(): Promise<number> {
    if (this.capturing()) return 0;
    const rows = this.db
      .prepare("SELECT id, text, approval_id, buttons FROM owner_inbox WHERE kind = 'approval' AND delivered_tg = 0 AND buttons IS NOT NULL ORDER BY id")
      .all() as { id: number; text: string; approval_id: number | null; buttons: string }[];
    let n = 0;
    for (const r of rows) {
      if (r.approval_id !== null && this.d.approvalPending && !this.d.approvalPending(r.approval_id)) continue;
      await this.d.inner.send(this.d.ownerId, r.text, JSON.parse(r.buttons) as Button[][]);
      this.db.prepare('UPDATE owner_inbox SET delivered_tg = 1 WHERE id = ?').run(r.id);
      n++;
    }
    return n;
  }

  // ---- reading (the admin API) ----
  list(o: { after?: number; limit?: number; unread?: boolean } = {}): InboxItem[] {
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(`SELECT * FROM (SELECT * FROM owner_inbox WHERE id > ? ${o.unread ? 'AND read = 0' : ''} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`)
      .all(o.after ?? 0, limit) as { id: number; at: number; kind: InboxKind; text: string; task_id: number | null; approval_id: number | null; delivered_tg: number; read: number }[];
    return rows.map((r) => ({
      id: r.id, at: r.at, kind: r.kind, text: r.text, taskId: r.task_id, approvalId: r.approval_id, read: r.read === 1, deliveredTg: r.delivered_tg === 1,
    }));
  }

  unread(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM owner_inbox WHERE read = 0').get() as { c: number }).c;
  }

  markRead(ids: number[] | 'all'): number {
    if (ids === 'all') return this.db.prepare('UPDATE owner_inbox SET read = 1 WHERE read = 0').run().changes;
    if (!ids.length) return 0;
    return this.db.prepare(`UPDATE owner_inbox SET read = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
  }

  /** The owner decided an approval on the site: its inbox card is no longer news, in Telegram or on the page. */
  resolveApproval(approvalId: number): void {
    this.db.prepare('UPDATE owner_inbox SET read = 1, delivered_tg = 1 WHERE approval_id = ?').run(approvalId);
  }
}
