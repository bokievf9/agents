import { log } from '@fir/core';
import type { Db } from '@fir/core';

/**
 * Telegram runner of the playground agents: every LIVE agent with a connected bot token gets one long-polling loop; a visitor's text goes through the
 * agent's own `chat()` (channel `telegram`, the agent's `msgsPerDay`), the reply goes back. Long polling (not webhooks) because each client bot would need a
 * public HTTPS URL, a `setWebhook` call and a secret per bot, and HQ's webhook port serves only the site; polling needs nothing from the outside and a revoked
 * token or a switched-off agent simply stops its loop. Texts and tokens are never logged: only the agent id, counters and an error code.
 */
export interface TgUpdate { updateId: number; chatId: number; text: string; private: boolean }
export class TgApiError extends Error {
  constructor(readonly code: 'unauthorized' | 'conflict' | 'rate' | 'network' | 'http', readonly retryAfterMs = 0) {
    super(code); // never a URL or a message from the library: the URL carries the token
  }
}
export interface TgTransport {
  getUpdates(token: string, offset: number, timeoutSec: number, signal: AbortSignal): Promise<TgUpdate[]>;
  send(token: string, chatId: number, text: string, signal: AbortSignal): Promise<void>;
}

/** The real transport: Bot API over fetch. Errors are reduced to `TgApiError` so a token can not leak through a message. */
export function fetchTransport(fetchImpl: typeof fetch = fetch): TgTransport {
  const call = async (token: string, method: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch {
      throw new TgApiError('network');
    }
    if (res.status === 401 || res.status === 404) throw new TgApiError('unauthorized');
    if (res.status === 409) throw new TgApiError('conflict');
    if (res.status === 429) {
      const j = (await res.json().catch(() => null)) as { parameters?: { retry_after?: number } } | null;
      throw new TgApiError('rate', Math.min(300, j?.parameters?.retry_after ?? 5) * 1000);
    }
    if (!res.ok) throw new TgApiError('http');
    return (await res.json().catch(() => null)) as unknown;
  };
  return {
    async getUpdates(token, offset, timeoutSec, signal) {
      const j = (await call(token, 'getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, signal, (timeoutSec + 10) * 1000)) as { result?: { update_id: number; message?: { text?: string; chat?: { id: number; type?: string } } }[] } | null;
      return (j?.result ?? []).map((u) => ({ updateId: u.update_id, chatId: u.message?.chat?.id ?? 0, text: typeof u.message?.text === 'string' ? u.message.text : '', private: u.message?.chat?.type === 'private' }));
    },
    async send(token, chatId, text, signal) {
      await call(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4000) }, signal, 15_000);
    },
  };
}

/** What the runner needs from the playground. */
export interface TgAgents {
  telegramBots(): { agentId: number; token: string }[];
  chatTelegram(agentId: number, chatId: number, text: string): Promise<{ reply: string } | { error: string }>;
}

export interface TgRunnerDeps {
  agents: TgAgents;
  transport: TgTransport;
  db: Db;
  now?: () => number;
  /** Waits `ms`, ends early on abort; the tests replace it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** At most this many bots poll at once (the lowest agent ids win); the rest are counted and told to the owner once. */
  maxBots?: number;
  syncMs?: number;
  pollSec?: number;
  notifyOwner?: ((text: string) => void) | undefined;
}

const LIMIT_TEXT = 'Сейчас я не могу ответить: лимит сообщений на сегодня исчерпан. Попробуйте написать завтра или оставьте контакт, менеджер свяжется с вами.';
const FAIL_TEXT = 'Не получилось ответить прямо сейчас. Напишите ещё раз через минуту.';

interface Loop { agentId: number; token: string; abort: AbortController; done: Promise<void> }

export class TelegramRunner {
  private readonly loops = new Map<number, Loop>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private overflowTold = false;
  private readonly limitSent = new Map<string, number>();
  private readonly d: Required<Pick<TgRunnerDeps, 'now' | 'sleep' | 'random' | 'maxBots' | 'syncMs' | 'pollSec'>> & TgRunnerDeps;

  constructor(deps: TgRunnerDeps) {
    this.d = {
      now: Date.now, random: Math.random, maxBots: 20, syncMs: 30_000, pollSec: 25,
      sleep: (ms, signal) => new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      }),
      ...deps,
    };
    this.d.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  /** Active loops (agent ids), for tests and the status line. */
  active(): number[] {
    return [...this.loops.keys()].sort((a, b) => a - b);
  }

  start(): void {
    this.sync();
    this.timer = setInterval(() => this.sync(), this.d.syncMs);
    this.timer.unref?.();
  }

  /** Stops every loop and waits for them. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const all = [...this.loops.values()];
    for (const l of all) l.abort.abort();
    this.loops.clear();
    await Promise.all(all.map((l) => l.done));
  }

  /** Makes the running loops match the live agents: new ones start, switched-off, revoked or re-tokened ones stop. */
  sync(): void {
    let want: { agentId: number; token: string }[];
    try {
      want = this.d.agents.telegramBots();
    } catch {
      log('warn', 'tg runner: agent list failed');
      return;
    }
    const ids = new Set(want.map((w) => w.agentId));
    for (const [id, l] of this.loops) {
      const w = want.find((x) => x.agentId === id);
      if (!ids.has(id) || (w && w.token !== l.token)) this.drop(id);
    }
    let skipped = 0;
    for (const w of want) {
      if (this.loops.has(w.agentId) || this.rejected.has(this.rejKey(w.agentId, w.token))) continue;
      if (this.loops.size >= this.d.maxBots) { skipped++; continue; }
      const abort = new AbortController();
      const loop: Loop = { agentId: w.agentId, token: w.token, abort, done: Promise.resolve() };
      loop.done = this.run(loop).finally(() => { if (this.loops.get(w.agentId) === loop) this.loops.delete(w.agentId); });
      this.loops.set(w.agentId, loop);
      log('info', 'tg runner: bot started', { agentId: w.agentId });
    }
    if (skipped > 0 && !this.overflowTold) {
      this.overflowTold = true;
      log('warn', 'tg runner: too many bots, some are not polled', { max: this.d.maxBots, skipped });
      this.d.notifyOwner?.(`Telegram-раннер агентов: ботов больше лимита ${this.d.maxBots}, ${skipped} не опрашиваются. Нужно поднять TG_RUNNER_MAX или перейти на вебхуки.`);
    }
    if (skipped === 0) this.overflowTold = false;
  }

  private drop(id: number): void {
    const l = this.loops.get(id);
    if (!l) return;
    l.abort.abort();
    this.loops.delete(id);
    log('info', 'tg runner: bot stopped', { agentId: id });
  }

  private offsetKey = (id: number) => `pg.tg.offset.${id}`;
  private readOffset(id: number): number {
    const r = this.d.db.prepare('SELECT value FROM settings WHERE key = ?').get(this.offsetKey(id)) as { value: string } | undefined;
    return r ? Number(r.value) || 0 : 0;
  }
  private writeOffset(id: number, v: number): void {
    this.d.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(this.offsetKey(id), String(v));
  }

  /** Is this loop still the one HQ wants (agent live, same token)? Checked before every reply, so a revoke stops answers at once. */
  private current(l: Loop): boolean {
    if (l.abort.signal.aborted) return false;
    try {
      return this.d.agents.telegramBots().some((b) => b.agentId === l.agentId && b.token === l.token);
    } catch {
      return false;
    }
  }

  private async run(l: Loop): Promise<void> {
    const { signal } = l.abort;
    let failures = 0;
    let offset = this.readOffset(l.agentId);
    while (!signal.aborted) {
      try {
        const updates = await this.d.transport.getUpdates(l.token, offset, this.d.pollSec, signal);
        failures = 0;
        for (const u of updates) {
          if (signal.aborted) return;
          if (u.updateId >= offset) offset = u.updateId + 1;
          if (u.private && u.chatId && u.text) await this.handle(l, u);
          this.writeOffset(l.agentId, offset);
        }
        // an idle poll returns at once in a fake transport; a real one waits server-side. Never spin.
        if (updates.length === 0) await this.d.sleep(0, signal);
      } catch (e) {
        if (signal.aborted) return;
        const code = e instanceof TgApiError ? e.code : 'unknown';
        if (code === 'unauthorized') {
          // revoked at BotFather: stop this bot for good; the loop comes back only if the client saves a new token
          log('warn', 'tg runner: token rejected, bot stopped', { agentId: l.agentId });
          this.d.notifyOwner?.(`Telegram-бот агента #${l.agentId}: токен отклонён (отозван?). Опрос остановлен до нового токена.`);
          this.rejected.add(this.rejKey(l.agentId, l.token));
          return;
        }
        failures++;
        const wait = e instanceof TgApiError && e.retryAfterMs ? e.retryAfterMs : backoff(failures, code === 'conflict', this.d.random());
        log('warn', 'tg runner: poll failed', { agentId: l.agentId, code, failures, waitMs: wait });
        await this.d.sleep(wait, signal);
      }
    }
  }

  /** Tokens Telegram refused: not started again until the client saves a different one. */
  private readonly rejected = new Set<string>();
  private rejKey = (id: number, token: string) => `${id}:${hash(token)}`;

  private async handle(l: Loop, u: TgUpdate): Promise<void> {
    if (!this.current(l)) return;
    const text = u.text.trim() === '/start' ? 'Здравствуйте!' : u.text;
    let out: { reply: string } | { error: string };
    try {
      out = await this.d.agents.chatTelegram(l.agentId, u.chatId, text);
    } catch {
      out = { error: 'failed' };
    }
    let reply: string;
    if ('error' in out) {
      if (out.error === 'not_live' || out.error === 'empty') return;
      if (out.error === 'limit_reached') {
        const key = `${l.agentId}:${u.chatId}`;
        const last = this.limitSent.get(key) ?? 0;
        if (this.d.now() - last < 600_000) return;
        this.limitSent.set(key, this.d.now());
        if (this.limitSent.size > 5000) this.limitSent.clear();
        reply = LIMIT_TEXT;
      } else reply = FAIL_TEXT;
    } else reply = out.reply;
    if (!this.current(l)) return;
    try {
      await this.d.transport.send(l.token, u.chatId, reply, l.abort.signal);
    } catch (e) {
      log('warn', 'tg runner: send failed', { agentId: l.agentId, code: e instanceof TgApiError ? e.code : 'unknown' });
    }
  }
}

const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

/** 1 s, 2 s, 4 s ... up to 60 s (conflict: from 30 s), plus up to 20% jitter. */
export function backoff(failures: number, conflict: boolean, rnd: number): number {
  const base = Math.min(60_000, 1000 * 2 ** (failures - 1));
  return Math.round((conflict ? Math.max(30_000, base) : base) * (1 + 0.2 * rnd));
}
