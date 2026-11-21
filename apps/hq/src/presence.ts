import { AsyncLocalStorage } from 'node:async_hooks';
import { errMsg, log, migrate, stripHtml, zonedParts, type Button, type Db, type EditOptions, type Messenger, type ReplyKeyboard, type SendOptions } from '@fir/core';
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
  /** The text is Telegram HTML: Telegram gets it as is, the inbox and the website the plain text. */
  html?: boolean;
  /** The reply keyboard to show with this message (Telegram only). */
  keyboard?: ReplyKeyboard;
}

/**
 * What reaches Telegram. `all` (the old Director bot): everything addressed to the owner while he is away. `notices` (owner 2026-11-22, one HQ bot):
 * only the short reminders of `OwnerNotices` (`notice()`) and the answers to his own messages in the bot; everything else lives in the inbox of the
 * Пульт. Approval cards reach Telegram only with `cards` (`TG_APPROVAL_CARDS=on`).
 */
export type TelegramPolicy = 'all' | 'notices';

export interface OwnerChannelDeps {
  hq: Hq;
  /** Default `all` (tests of the older flows); the app passes `notices`. */
  telegram?: TelegramPolicy;
  /** With `telegram: 'notices'`: approval cards with buttons still go to Telegram (the legacy flag). */
  cards?: boolean;
  /** The Пульт, for the one link of the presence digest (default https://firtech.pro/admin). */
  pultUrl?: string;
  inner: Messenger;
  ownerId: number;
  /** The site is considered gone after this many minutes without a ping. */
  awayAfterMin?: number;
  /** Is the core approval still waiting for the owner? Used to keep digests and resends honest. */
  approvalPending?: (approvalId: number) => boolean;
  /** An approval card reached Telegram later (resent from the inbox): where it is, so it can be edited after the decision. */
  onCardSent?: (approvalId: number, messageId: number) => void;
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
    // added later: the Telegram HTML of a message (the `text` column stays plain for the website)
    const cols = d.hq.db.prepare('PRAGMA table_info(owner_inbox)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'html')) d.hq.db.exec('ALTER TABLE owner_inbox ADD COLUMN html TEXT');
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

  /** The owner's calendar day (his clock, `owner_tz`): the desk mode belongs to a day. */
  private ownerDay(): string {
    const p = zonedParts(this.d.hq.now(), this.d.hq.ownerTz);
    return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }

  /**
   * At the desk only while the site pings AND the desk belongs to the owner's current day. A tab left open overnight keeps pinging,
   * but pings in his quiet hours do not carry the desk into the next day: at his midnight the mode ends and everything goes to
   * Telegram again (the morning ping from the open site, outside quiet hours, brings it back).
   */
  effective(): PresenceMode {
    if (this.mode === 'away') return 'away';
    const last = this.lastPingAt;
    if (last === null || this.d.hq.now() - last >= this.awayAfterMin * 60_000) return 'away';
    if (this.d.hq.setting('presence.deskDay') !== this.ownerDay()) return 'away';
    return 'desk';
  }

  async setMode(mode: PresenceMode): Promise<void> {
    this.d.hq.setSetting('presence.mode', mode);
    // switching to the desk is itself a sign of life (the 20 minutes start now, the day is today on the owner's clock)
    if (mode === 'desk') {
      this.d.hq.setSetting('presence.lastPingAt', String(this.d.hq.now()));
      this.d.hq.setSetting('presence.deskDay', this.ownerDay());
    }
    await this.sync();
  }

  async ping(): Promise<void> {
    this.d.hq.setSetting('presence.lastPingAt', String(this.d.hq.now()));
    if (!this.d.hq.isQuiet()) this.d.hq.setSetting('presence.deskDay', this.ownerDay());
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
    const text = this.notices
      ? `Пока вы были за столом: ждут одобрения ${n('approval')}, алертов ${n('alert')}. Пульт: ${this.d.pultUrl ?? 'https://firtech.pro/admin'}`
      : `Пока вы были на месте: ${n('approval')} одобрений, ${n('progress')} задач готово, ${n('alert')} алертов. /approve, /status`;
    if (this.notices && n('approval') + n('alert') === 0) return;
    const ids = rows.map((r) => r.id);
    try {
      await this.d.inner.send(this.d.ownerId, text);
      this.db.prepare(`UPDATE owner_inbox SET delivered_tg = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      log('info', 'presence digest sent', { items: ids.length });
    } catch (e) {
      log('warn', 'presence digest failed', { err: errMsg(e) });
    }
  }

  private get notices(): boolean {
    return this.d.telegram === 'notices';
  }

  /**
   * A short reminder to Telegram (`OwnerNotices`): it is a ping about something the Пульт already shows, so it is not stored in the inbox.
   * At the desk it is skipped (he sees the site), inside a website command it is dropped. Returns what happened.
   */
  async notice(html: string): Promise<'sent' | 'desk' | 'capture'> {
    if (this.capturing()) return 'capture';
    await this.sync();
    if (this.effective() === 'desk') return 'desk';
    await this.d.inner.sendMessage(this.d.ownerId, html, undefined, { html: true });
    return 'sent';
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
  send(chatId: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<void> {
    return this.sendMessage(chatId, text, buttons, opts).then(() => undefined);
  }

  async sendMessage(chatId: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<number> {
    if (chatId !== this.d.ownerId) return this.d.inner.sendMessage(chatId, text, buttons, opts);
    return this.notify(undefined, text, { ...(buttons ? { buttons } : {}), ...(opts?.html ? { html: true } : {}), ...(opts?.keyboard ? { keyboard: opts.keyboard } : {}) });
  }

  /** Edits of a Telegram message (a button press, a live task message) go straight through: the owner already has it. */
  edit(chatId: number, messageId: number, text: string, opts?: EditOptions): Promise<void> {
    return this.d.inner.edit(chatId, messageId, text, opts);
  }

  editButtons(chatId: number, messageId: number, buttons: Button[][] | null): Promise<void> {
    return this.d.inner.editButtons(chatId, messageId, buttons);
  }

  /**
   * Pictures cannot live in the website inbox: with `all` they go to Telegram (the owner forwards them to Instagram from there). With `notices`
   * the files stay in the review center and the inbox gets the caption only.
   */
  sendPhotos(chatId: number, files: string[], caption?: string): Promise<void> {
    if (this.notices && chatId === this.d.ownerId) return Promise.resolve(this.record('message', `${caption ?? 'Картинки'} (${files.length} шт., файлы в ревью-центре)`));
    if (!this.d.inner.sendPhotos) return Promise.reject(new Error('this messenger cannot send photos'));
    return this.d.inner.sendPhotos(chatId, files, caption);
  }

  /** The reel's MP4 always goes to Telegram too (a video cannot live in the website inbox). Same as `sendPhotos`: delegates to the real messenger. */
  sendVideo(chatId: number, file: string, caption?: string, buttons?: Button[][]): Promise<void> {
    if (this.notices && chatId === this.d.ownerId) return Promise.resolve(this.record('message', `${caption ?? 'Видео'} (видео в ревью-центре)`));
    if (!this.d.inner.sendVideo) return Promise.reject(new Error('this messenger cannot send video'));
    return this.d.inner.sendVideo(chatId, file, caption, buttons);
  }

  /** Backups and other files: straight to Telegram. */
  sendDocument(chatId: number, file: string, caption?: string): Promise<void> {
    if (!this.d.inner.sendDocument) return Promise.reject(new Error('this messenger cannot send documents'));
    return this.d.inner.sendDocument(chatId, file, caption);
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
    const plain = o.html ? stripHtml(text) : text;
    if (scope?.mode === 'capture') {
      scope.replies.push(plain);
      return 0;
    }
    await this.sync();
    const c = this.classify(plain, o.buttons);
    const inReply = scope?.mode === 'reply';
    const k: InboxKind = c.kind === 'approval' ? 'approval' : inReply ? 'reply' : (kind ?? c.kind);
    const away = this.effective() === 'away';
    const toTg = this.notices
      ? (c.kind === 'approval' ? Boolean(this.d.cards) && (Boolean(o.force) || inReply || away) : inReply)
      : Boolean(o.force) || inReply || away;
    // the same card sent again (the first send failed, or a re-ask): the old undelivered copy is replaced, not shown twice on the site and resent by /approve
    if (c.approvalId !== null) this.db.prepare("DELETE FROM owner_inbox WHERE approval_id = ? AND kind = 'approval' AND delivered_tg = 0").run(c.approvalId);
    const id = this.insert(k, plain, o.taskId ?? null, c.approvalId, o.buttons, inReply && k === 'reply', false, o.html ? text : null);
    if (!toTg) return 0;
    const msgId = await this.d.inner.sendMessage(this.d.ownerId, text, o.buttons, { ...(o.html ? { html: true } : {}), ...(o.keyboard && !o.buttons ? { keyboard: o.keyboard } : {}) });
    this.db.prepare('UPDATE owner_inbox SET delivered_tg = 1 WHERE id = ?').run(id);
    return msgId;
  }

  /** Stores a line in the inbox that the owner already has elsewhere (an edited Telegram message): no sending. */
  record(kind: InboxKind, text: string, taskId?: number): void {
    if (this.capturing()) return;
    this.insert(kind, text, taskId ?? null, null, undefined, false, true);
  }

  private insert(kind: InboxKind, text: string, taskId: number | null, approvalId: number | null, buttons: Button[][] | undefined, read: boolean, delivered = false, html: string | null = null): number {
    const r = this.db
      .prepare('INSERT INTO owner_inbox (at, kind, text, task_id, approval_id, delivered_tg, read, buttons, html) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.d.hq.now(), kind, text.slice(0, 8000), taskId, approvalId, delivered ? 1 : 0, read ? 1 : 0, buttons ? JSON.stringify(buttons) : null, html && html.length <= 8000 ? html : null);
    // the inbox is a feed, not an archive
    if (Number(r.lastInsertRowid) % 50 === 0) this.db.prepare('DELETE FROM owner_inbox WHERE at < ?').run(this.d.hq.now() - INBOX_KEEP_MS);
    return Number(r.lastInsertRowid);
  }

  /** `/approve` in Telegram: pending approval cards that never reached it (sent while at the desk) go out now. */
  async resendUndelivered(): Promise<number> {
    // with the one HQ bot the cards stay in the Пульт (TG_APPROVAL_CARDS=on brings them back)
    if (this.capturing() || (this.notices && !this.d.cards)) return 0;
    const rows = this.db
      .prepare("SELECT id, text, html, approval_id, buttons FROM owner_inbox WHERE kind = 'approval' AND delivered_tg = 0 AND buttons IS NOT NULL ORDER BY id")
      .all() as { id: number; text: string; html: string | null; approval_id: number | null; buttons: string }[];
    let n = 0;
    for (const r of rows) {
      if (r.approval_id !== null && this.d.approvalPending && !this.d.approvalPending(r.approval_id)) continue;
      // still queued in its department: the batch that follows sends it (and replaces this row), sending it here too would show the card twice
      if (r.approval_id !== null && this.d.hq.approvalByCoreId(r.approval_id)?.state === 'queued') continue;
      const msgId = await this.d.inner.sendMessage(this.d.ownerId, r.html ?? r.text, JSON.parse(r.buttons) as Button[][], r.html ? { html: true } : undefined);
      if (r.approval_id !== null) this.d.onCardSent?.(r.approval_id, msgId);
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
