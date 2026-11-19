import { migrate, zonedParts, type Button, type Db } from '@fir/core';

/**
 * «Салон Лайм»: a sandboxed demo of the booking-bot product inside the client bot. Everything here is fictional and
 * lives only in `cb_demo` (one row per chat, wiped by /start or after 24 h). The demo never creates a lead, task or
 * approval: only the final «Хочу такого бота себе» leaves it, and the engine runs the normal intake from there.
 * Callback data is `dm:<action>[:<arg>]`.
 */
export type Lang = 'ru' | 'en';
export type DemoStep = 'service' | 'master' | 'day' | 'time' | 'confirm' | 'booked' | 'review' | 'reviewed' | 'cancelled';

export interface DemoPicks {
  service?: number;
  master?: number;
  day?: number;
  time?: string;
  /** Booking counter: a reminder fires only for the booking it was scheduled for. */
  seq: number;
  rating?: number;
}

export interface DemoRow {
  chatId: number;
  step: DemoStep;
  picks: DemoPicks;
  createdAt: number;
}

export const DEMO_TTL_MS = 24 * 3_600_000;
export const REMINDER_DELAY_MS = 60_000;
/** The deep link the site opens. */
export const DEMO_START = 'demo_salon';
export const DEMO_LINK = `https://t.me/firtech_bot?start=${DEMO_START}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cb_demo (
  chat_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,
  picks TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
`;

const SERVICES: Record<Lang, string[]> = { ru: ['Стрижка', 'Окрашивание', 'Маникюр'], en: ['Haircut', 'Colouring', 'Manicure'] };
const MASTERS: Record<Lang, string[]> = { ru: ['Алина', 'Мадина'], en: ['Alina', 'Madina'] };
const DAY_WORDS: Record<Lang, string[]> = { ru: ['Сегодня', 'Завтра', 'Послезавтра'], en: ['Today', 'Tomorrow', 'Day after'] };

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pad = (n: number): string => String(n).padStart(2, '0');

/** Generated list of free slots for a master on a day offset: hourly 10:00-19:00, a stable pseudo-random part is «taken»; today only the future. */
export function demoSlots(master: number, day: number, nowMs: number, tz: string): string[] {
  const p = zonedParts(nowMs, tz);
  const out: string[] = [];
  for (let h = 10; h <= 19; h++) {
    if ((h * 7 + master * 3 + day * 5) % 4 === 0) continue;
    if (day === 0 && (h < p.h + 1 || (h === p.h + 1 && p.mi > 30))) continue;
    out.push(`${pad(h)}:00`);
  }
  return out.slice(0, 6);
}

/** Date label of a day offset in the company timezone: «19.11». */
export function demoDate(nowMs: number, tz: string, day: number): string {
  const p = zonedParts(nowMs + day * 86_400_000, tz);
  return `${pad(p.d)}.${pad(p.mo)}`;
}

const HEAD = {
  ru: '🧪 <b>Демо · Салон Лайм</b>\n<i>Демо, записи не настоящие.</i>',
  en: '🧪 <b>Demo · Lime Salon</b>\n<i>Demo only, bookings are not real.</i>',
};

const L = {
  ru: {
    service: 'Что хотите записать?',
    master: 'Выберите мастера.',
    day: 'Выберите день.',
    time: (d: string) => `Свободное время, ${d}.`,
    noSlots: 'На этот день свободных окон нет, выберите другой.',
    confirm: (svc: string, m: string, when: string) => `Проверьте запись:\n• ${esc(svc)}\n• мастер ${esc(m)}\n• ${esc(when)}`,
    confirmBtn: '✅ Подтвердить', back: '← Назад',
    booked: (svc: string, m: string, when: string) =>
      `✅ <b>Вы записаны</b> (понарошку)\n• ${esc(svc)}\n• мастер ${esc(m)}\n• ${esc(when)}\n\nЧерез минуту пришлю демо-напоминание.`,
    reminder: (svc: string, m: string, when: string) =>
      `⏰ <b>Напоминание</b>\nЗавтра вас ждёт ${esc(svc.toLowerCase())}: ${esc(when)}, мастер ${esc(m)}.\n\n<i>Так клиент получит напоминание за день. Демо, записи не настоящие.</i>`,
    resched: 'Перенести', cancel: 'Отменить', review: 'Оставить отзыв',
    reviewAsk: 'Как всё прошло? Поставьте оценку от 1 до 5.',
    thanks: (n: number) => `Спасибо за оценку ${'⭐'.repeat(n)}. Так бот собирает отзывы после визита: низкие оценки уходят владельцу, высокие приглашают оставить отзыв на карте.`,
    cancelled: 'Запись отменена (понарошку). Мастер получил бы уведомление, а окно вернулось бы в расписание.',
    want: '🚀 Хочу такого бота себе', restart: '↺ Начать демо заново',
    toastStale: 'Уже неактуально',
  },
  en: {
    service: 'What would you like to book?',
    master: 'Choose a master.',
    day: 'Choose a day.',
    time: (d: string) => `Free times, ${d}.`,
    noSlots: 'No free slots that day, please pick another.',
    confirm: (svc: string, m: string, when: string) => `Please check the booking:\n• ${esc(svc)}\n• master ${esc(m)}\n• ${esc(when)}`,
    confirmBtn: '✅ Confirm', back: '← Back',
    booked: (svc: string, m: string, when: string) =>
      `✅ <b>You are booked</b> (pretend)\n• ${esc(svc)}\n• master ${esc(m)}\n• ${esc(when)}\n\nI will send a demo reminder in a minute.`,
    reminder: (svc: string, m: string, when: string) =>
      `⏰ <b>Reminder</b>\nTomorrow you have a ${esc(svc.toLowerCase())}: ${esc(when)}, master ${esc(m)}.\n\n<i>This is how a client gets a reminder a day before. Demo only, bookings are not real.</i>`,
    resched: 'Reschedule', cancel: 'Cancel', review: 'Leave a review',
    reviewAsk: 'How did it go? Rate from 1 to 5.',
    thanks: (n: number) => `Thank you for ${'⭐'.repeat(n)}. This is how the bot collects reviews after a visit: low ratings go to the owner, high ones invite a review on the map.`,
    cancelled: 'Booking cancelled (pretend). The master would be notified and the slot would return to the schedule.',
    want: '🚀 I want a bot like this', restart: '↺ Restart the demo',
    toastStale: 'No longer relevant',
  },
};

export interface DemoIO {
  send(chatId: number, html: string, buttons?: Button[][]): Promise<number | null>;
  edit(chatId: number, messageId: number, html: string, buttons?: Button[][]): Promise<void>;
}

export type DemoResult = { toast?: string; want?: boolean };

const rows = (btns: Button[], per: number): Button[][] => {
  const out: Button[][] = [];
  for (let i = 0; i < btns.length; i += per) out.push(btns.slice(i, i + per));
  return out;
};

export class DemoSalon {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly tz: () => string,
    private readonly io: DemoIO,
    /** Runs `job` after `ms` (setTimeout in production, captured by tests). */
    private readonly schedule: (ms: number, job: () => void) => void,
  ) {
    migrate(db, SCHEMA);
  }

  get(chatId: number): DemoRow | undefined {
    this.sweep();
    const r = this.db.prepare('SELECT chat_id, step, picks, created_at FROM cb_demo WHERE chat_id = ?').get(chatId) as
      | { chat_id: number; step: DemoStep; picks: string; created_at: number }
      | undefined;
    return r ? { chatId: r.chat_id, step: r.step, picks: JSON.parse(r.picks) as DemoPicks, createdAt: r.created_at } : undefined;
  }

  /** `/start` and the 24 h rule. */
  wipe(chatId: number): void {
    this.db.prepare('DELETE FROM cb_demo WHERE chat_id = ?').run(chatId);
  }

  sweep(): void {
    this.db.prepare('DELETE FROM cb_demo WHERE created_at < ?').run(this.now() - DEMO_TTL_MS);
  }

  private save(chatId: number, step: DemoStep, picks: DemoPicks, createdAt?: number): void {
    this.db
      .prepare(
        `INSERT INTO cb_demo (chat_id, step, picks, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET step = excluded.step, picks = excluded.picks`,
      )
      .run(chatId, step, JSON.stringify(picks), createdAt ?? this.now());
  }

  private frame(lang: Lang, body: string): string {
    return `${HEAD[lang]}\n\n${body}`;
  }

  /** Begins (or restarts) the demo as a new message. */
  async start(chatId: number, lang: Lang): Promise<void> {
    this.wipe(chatId);
    this.save(chatId, 'service', { seq: 0 });
    await this.io.send(chatId, this.frame(lang, L[lang].service), this.serviceButtons(lang));
  }

  private serviceButtons(lang: Lang): Button[][] {
    return rows(SERVICES[lang].map((t, i) => ({ text: t, data: `dm:s:${i}` })), 1);
  }

  private masterButtons(lang: Lang): Button[][] {
    return [...rows(MASTERS[lang].map((t, i) => ({ text: `👩 ${t}`, data: `dm:m:${i}` })), 2), [{ text: L[lang].back, data: 'dm:b:service' }]];
  }

  private dayChoices(master: number): number[] {
    return [0, 1, 2].filter((d) => demoSlots(master, d, this.now(), this.tz()).length > 0);
  }

  private dayButtons(lang: Lang, master: number): Button[][] {
    const btns = this.dayChoices(master).map((d) => ({ text: `${DAY_WORDS[lang][d]} · ${demoDate(this.now(), this.tz(), d)}`, data: `dm:d:${d}` }));
    return [...rows(btns, 1), [{ text: L[lang].back, data: 'dm:b:master' }]];
  }

  private timeButtons(lang: Lang, master: number, day: number): Button[][] {
    const slots = demoSlots(master, day, this.now(), this.tz());
    return [...rows(slots.map((s) => ({ text: s, data: `dm:t:${s.replace(':', '')}` })), 3), [{ text: L[lang].back, data: 'dm:b:day' }]];
  }

  private when(lang: Lang, p: DemoPicks): string {
    return `${DAY_WORDS[lang][p.day ?? 0]!.toLowerCase()}, ${demoDate(this.now(), this.tz(), p.day ?? 0)}, ${p.time}`;
  }

  private bookedButtons(lang: Lang): Button[][] {
    const l = L[lang];
    return [[{ text: l.resched, data: 'dm:rs' }, { text: l.cancel, data: 'dm:cx' }], [{ text: l.review, data: 'dm:rv' }], [{ text: l.want, data: 'dm:want' }]];
  }

  /** A demo button. `messageId` is the message that carries it: the demo edits it in place. */
  async button(chatId: number, lang: Lang, messageId: number, data: string): Promise<DemoResult> {
    const row = this.get(chatId);
    const l = L[lang];
    const stale = { toast: l.toastStale };
    if (!row) return stale;
    const [, act = '', arg = ''] = data.split(':');
    const p = row.picks;
    const edit = (body: string, buttons: Button[][]) => this.io.edit(chatId, messageId, this.frame(lang, body), buttons);
    const go = async (step: DemoStep, picks: DemoPicks, body: string, buttons: Button[][]) => {
      this.save(chatId, step, picks, row.createdAt);
      await edit(body, buttons);
      return {};
    };
    const num = Number(arg);

    if (act === 'want') return { want: true };
    if (act === 're') {
      this.wipe(chatId);
      this.save(chatId, 'service', { seq: p.seq });
      await edit(l.service, this.serviceButtons(lang));
      return {};
    }
    if (act === 'b') {
      if (arg === 'service' && row.step === 'master') return go('service', { seq: p.seq }, l.service, this.serviceButtons(lang));
      if (arg === 'master' && row.step === 'day') return go('master', { seq: p.seq, ...(p.service !== undefined ? { service: p.service } : {}) }, l.master, this.masterButtons(lang));
      if (arg === 'day' && row.step === 'time' && p.master !== undefined) return go('day', { seq: p.seq, service: p.service!, master: p.master }, l.day, this.dayButtons(lang, p.master));
      return stale;
    }
    if (act === 's' && row.step === 'service' && SERVICES.ru[num]) return go('master', { seq: p.seq, service: num }, l.master, this.masterButtons(lang));
    if (act === 'm' && row.step === 'master' && MASTERS.ru[num]) return go('day', { ...p, master: num }, l.day, this.dayButtons(lang, num));
    if (act === 'd' && row.step === 'day' && p.master !== undefined && this.dayChoices(p.master).includes(num)) {
      return go('time', { ...p, day: num }, l.time(`${DAY_WORDS[lang][num]!.toLowerCase()} ${demoDate(this.now(), this.tz(), num)}`), this.timeButtons(lang, p.master, num));
    }
    if (act === 't' && row.step === 'time' && p.master !== undefined && p.day !== undefined) {
      const time = `${arg.slice(0, 2)}:${arg.slice(2)}`;
      if (!demoSlots(p.master, p.day, this.now(), this.tz()).includes(time)) return stale;
      const picks = { ...p, time };
      return go('confirm', picks, l.confirm(SERVICES[lang][p.service!]!, MASTERS[lang][p.master]!, this.when(lang, picks)), [
        [{ text: l.confirmBtn, data: 'dm:ok' }], [{ text: l.back, data: 'dm:b:day' }],
      ]);
    }
    if (act === 'ok' && row.step === 'confirm') {
      const picks = { ...p, seq: p.seq + 1 };
      const res = await go('booked', picks, l.booked(SERVICES[lang][p.service!]!, MASTERS[lang][p.master!]!, this.when(lang, picks)), this.bookedButtons(lang));
      this.schedule(REMINDER_DELAY_MS, () => void this.remind(chatId, lang, picks.seq));
      return res;
    }
    if (act === 'rs' && row.step === 'booked' && p.master !== undefined) {
      return go('day', { seq: p.seq + 1, service: p.service!, master: p.master }, l.day, this.dayButtons(lang, p.master));
    }
    if (act === 'cx' && row.step === 'booked') {
      return go('cancelled', { ...p, seq: p.seq + 1 }, l.cancelled, [[{ text: l.restart, data: 'dm:re' }], [{ text: l.want, data: 'dm:want' }]]);
    }
    if (act === 'rv' && (row.step === 'booked' || row.step === 'reviewed')) {
      return go('review', p, l.reviewAsk, [[1, 2, 3, 4, 5].map((n) => ({ text: `${n} ⭐`, data: `dm:r:${n}` }))]);
    }
    if (act === 'r' && row.step === 'review' && num >= 1 && num <= 5) {
      return go('reviewed', { ...p, rating: num }, l.thanks(num), [[{ text: l.restart, data: 'dm:re' }], [{ text: l.want, data: 'dm:want' }]]);
    }
    return stale;
  }

  /** The scheduled reminder: only while that very booking is still the live one. */
  async remind(chatId: number, lang: Lang, seq: number): Promise<void> {
    const row = this.get(chatId);
    if (!row || row.picks.seq !== seq || (row.step !== 'booked' && row.step !== 'review' && row.step !== 'reviewed')) return;
    const p = row.picks;
    await this.io.send(chatId, this.frame(lang, L[lang].reminder(SERVICES[lang][p.service!]!, MASTERS[lang][p.master!]!, this.when(lang, p))));
  }
}
