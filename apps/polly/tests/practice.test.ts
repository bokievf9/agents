import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { content, OWNER, setup } from './helpers.js';

const answerCorrect = async (ctx: ReturnType<typeof setup>, text: string) => {
  const btn = ctx.lastButtons().find((b) => b.text === text);
  if (!btn) throw new Error(`no button ${text}`);
  await ctx.teacher.onAction(btn.data);
};

describe('placement test', () => {
  it('asks 16 questions (3 pinyin, 10 words, 3 phrases) and stores the level', async () => {
    const ctx = setup();
    await ctx.teacher.onCommand('start');
    await ctx.press('Пройти тест');
    let asked = 0;
    // answer the "correct" option: find it through the same content the test uses
    for (;;) {
      const text = ctx.messenger.last()!.text;
      const m = /Вопрос (\d+) из 16/.exec(text);
      if (!m) break;
      asked++;
      const btns = ctx.lastButtons();
      // all-wrong run: always pick the first option, whatever it is, then compare with an all-right run below
      await ctx.teacher.onAction(btns[0]!.data);
    }
    expect(asked).toBe(16);
    const p = ctx.store.profile()!;
    expect(['zero', 'beginner']).toContain(p.level);
    expect(p.placementScore).not.toBeNull();
    expect(ctx.messenger.last()!.text).toContain('Тест окончен');
  });

  it('gives a confident level for correct answers', async () => {
    const ctx = setup();
    await ctx.teacher.onCommand('test');
    const known = new Map<string, string>(); // question label -> correct option
    for (const q of content.placement.pinyin) known.set(q.q, q.o[q.a]!);
    for (const h of content.placement.words) known.set(`Что значит ${h} (${content.words.get(h)!.p})?`, content.words.get(h)!.r);
    for (const p of content.placement.phrases) known.set(`Переведи: ${p.h} (${p.p})`, p.o[p.a]!);
    for (let i = 0; i < 16; i++) {
      const text = ctx.messenger.last()!.text;
      const q = [...known.keys()].find((k) => text.includes(k))!;
      await answerCorrect(ctx, known.get(q)!);
    }
    expect(ctx.store.profile()!.level).toBe('confident');
    expect(ctx.messenger.last()!.text).toContain('16 из 16');
  });
});

describe('vocabulary review (FSRS)', () => {
  async function withCards() {
    const ctx = setup();
    await ctx.teacher.onCommand('lesson');
    // finish day 1 quickly
    const lesson = content.lessons[0]!;
    for (let i = 0; i < 5; i++) await ctx.press('Дальше');
    for (const q of lesson.quiz) {
      await answerCorrect(ctx, q.o[q.a]!);
      await ctx.press('Дальше');
    }
    return ctx;
  }

  it('reviews due cards, reschedules them by grade and brings "again" back in the session', async () => {
    const ctx = await withCards();
    const total = ctx.store.cardCount();
    expect(ctx.store.dueCount(ctx.clock.t)).toBe(total);
    await ctx.teacher.onCommand('review');
    await ctx.press('Показать');
    expect(ctx.messenger.last()!.text).toContain('nǐ hǎo');
    await ctx.press('Снова'); // first card goes back
    expect(ctx.store.card('w:你好')!.due).toBe(ctx.clock.t + 10 * 60_000);
    // answer the rest good, then the repeated one
    for (let i = 0; i < total; i++) {
      await ctx.press('Показать');
      await ctx.press('Хорошо');
    }
    expect(ctx.messenger.last()!.text).toContain('Повторение окончено');
    expect(ctx.store.dueCount(ctx.clock.t + 3600_000)).toBe(0);
    const good = ctx.store.card('w:谢谢')!;
    expect(good.reps).toBe(1);
    expect(good.due).toBeGreaterThan(ctx.clock.t + 3 * 24 * 3600_000);
    expect(ctx.store.card('w:你好')!.reps).toBe(2);
    // tomorrow only the card that was forgotten is due again
    expect(ctx.store.dueCount(ctx.clock.t + 24 * 3600_000)).toBe(1);
    expect(ctx.store.dueCount(ctx.clock.t + 6 * 24 * 3600_000)).toBeGreaterThan(0);
  });

  it('says so when nothing is due', async () => {
    const ctx = setup();
    await ctx.teacher.onCommand('review');
    expect(ctx.messenger.last()!.text).toContain('карточек нет');
  });

  it('ignores a grade button before the answer is shown', async () => {
    const ctx = await withCards();
    await ctx.teacher.onCommand('review');
    const before = ctx.messenger.sent.length;
    await ctx.teacher.onAction('r:g3:0');
    expect(ctx.messenger.sent.length).toBe(before);
  });
});

describe('tone drill', () => {
  it('asks five questions with four tone forms each and reports the score', async () => {
    const ctx = setup();
    await ctx.teacher.onCommand('tones');
    for (let i = 0; i < 5; i++) {
      expect(ctx.messenger.last()!.text).toContain(`Вопрос ${i + 1} из 5`);
      expect(ctx.lastButtons()).toHaveLength(4);
      await ctx.teacher.onAction(ctx.lastButtons()[0]!.data);
    }
    expect(ctx.messenger.last()!.text).toMatch(/Тоны: \d из 5/);
  });
});

describe('reminders and the weekly report', () => {
  it('sends the lesson reminder once at the set local time', async () => {
    const ctx = setup(); // 19:00 Tashkent == 14:00 UTC
    await ctx.teacher.onCommand('start');
    await ctx.press('Я с нуля');
    const n = ctx.messenger.sent.length;
    await ctx.teacher.tick(ctx.clock.t - 60_000); // 18:59
    expect(ctx.messenger.sent.length).toBe(n);
    await ctx.teacher.tick(ctx.clock.t); // 19:00
    expect(ctx.messenger.sent.length).toBe(n + 1);
    expect(ctx.messenger.last()!.text).toContain('Время урока');
    await ctx.teacher.tick(ctx.clock.t + 60_000);
    expect(ctx.messenger.sent.length).toBe(n + 1); // not twice
    // next day again
    await ctx.teacher.tick(ctx.clock.t + 24 * 3600_000);
    expect(ctx.messenger.sent.length).toBe(n + 2);
  });

  it('follows the time zone of the profile', async () => {
    const utc = Date.UTC(2026, 10, 18, 14, 0);
    const tashkent = setup({ tz: 'Asia/Tashkent' });
    const dushanbe = setup({ tz: 'Asia/Dushanbe' });
    const berlin = setup({ tz: 'Europe/Berlin' });
    for (const c of [tashkent, dushanbe, berlin]) await c.teacher.onCommand('time', '19:00');
    for (const c of [tashkent, dushanbe, berlin]) c.messenger.sent.length = 0;
    await tashkent.teacher.tick(utc); // 19:00 in Tashkent
    await dushanbe.teacher.tick(utc); // Dushanbe is also UTC+5
    await berlin.teacher.tick(utc); // 15:00 in Berlin
    expect(tashkent.messenger.sent).toHaveLength(1);
    expect(dushanbe.messenger.sent).toHaveLength(1);
    expect(berlin.messenger.sent).toHaveLength(0);
    await berlin.teacher.tick(Date.UTC(2026, 10, 18, 18, 0)); // 19:00 in Berlin (UTC+1 in November)
    expect(berlin.messenger.sent).toHaveLength(1);
  });

  it('does not nag when the lesson was already done today, and catches up within an hour after a restart', async () => {
    const ctx = setup();
    await ctx.teacher.onCommand('lesson');
    const lesson = content.lessons[0]!;
    for (let i = 0; i < 5; i++) await ctx.press('Дальше');
    for (const q of lesson.quiz) {
      await answerCorrect(ctx, q.o[q.a]!);
      await ctx.press('Дальше');
    }
    const n = ctx.messenger.sent.length;
    await ctx.teacher.tick(ctx.clock.t);
    expect(ctx.messenger.sent.length).toBe(n);
    ctx.clock.t += 24 * 3600_000;
    await ctx.teacher.tick(ctx.clock.t + 30 * 60_000); // 19:30, the process was down at 19:00
    expect(ctx.messenger.sent.length).toBe(n + 1);
    await ctx.teacher.tick(ctx.clock.t + 3 * 3600_000); // 22:00 is too late
    expect(ctx.messenger.sent.length).toBe(n + 1);
  });

  it('sends the weekly report on Sunday with minutes, words in the active vocabulary and the streak', async () => {
    const ctx = setup();
    await ctx.teacher.onCommand('lesson');
    const lesson = content.lessons[0]!;
    for (let i = 0; i < 5; i++) {
      ctx.clock.t += 60_000;
      await ctx.press('Дальше');
    }
    for (const q of lesson.quiz) {
      ctx.clock.t += 60_000;
      await answerCorrect(ctx, q.o[q.a]!);
      await ctx.press('Дальше');
    }
    // review with "easy" to make words active
    await ctx.teacher.onCommand('review');
    for (let i = 0; i < ctx.store.cardCount(); i++) {
      await ctx.press('Показать');
      await ctx.press('Легко');
    }
    ctx.messenger.sent.length = 0;
    const sunday = Date.UTC(2026, 10, 22, 14, 0); // Sun 19:00 Tashkent
    ctx.clock.t = sunday;
    await ctx.teacher.tick(sunday);
    const texts = ctx.messenger.to(OWNER);
    const report = texts.find((t) => t.startsWith('Итоги недели'))!;
    expect(report).toContain('Время занятий: ');
    expect(report).toContain('Уроков пройдено: 1');
    expect(report).toMatch(/Слов в активе: [1-9]/);
    expect(report).toContain('Серия: ');
    await ctx.teacher.tick(sunday + 60_000);
    expect(ctx.messenger.to(OWNER).filter((t) => t.startsWith('Итоги недели'))).toHaveLength(1);
  });

  it('counts study minutes from the taps within a session, not the pauses', async () => {
    const ctx = setup();
    await ctx.teacher.onCommand('help');
    ctx.clock.t += 120_000;
    await ctx.teacher.onCommand('help');
    ctx.clock.t += 3600_000; // a pause is not study time
    await ctx.teacher.onCommand('help');
    ctx.clock.t += 60_000;
    await ctx.teacher.onCommand('help');
    expect(ctx.store.activeMinutes(ctx.clock.t - 7 * 24 * 3600_000, ctx.clock.t)).toBe(3);
  });
});

describe('voice and conversation', () => {
  it('queues a voice message and promises voice for stage 2', async () => {
    const ctx = setup();
    await ctx.teacher.onVoice('file123', 4);
    expect(ctx.store.voiceQueueSize()).toBe(1);
    expect(ctx.messenger.last()!.text).toContain('этапе 2');
  });

  it('works without an LLM: /talk explains, lessons carry on', async () => {
    const ctx = setup();
    await ctx.teacher.onCommand('talk');
    expect(ctx.messenger.last()!.text).toContain('LLM off');
    await ctx.teacher.onText('привет');
    expect(ctx.messenger.last()!.text).toContain('/lesson');
  });

  it('talks through the LLM (mock) and falls back politely when it fails', async () => {
    let fail = false;
    const llm = new MockLlm((req) => {
      if (fail) throw new Error('down');
      expect(req.tier).toBe('sonnet');
      return '你好！\nnǐ hǎo!\nЗдравствуйте!';
    });
    const ctx = setup({ llm });
    await ctx.teacher.onCommand('talk');
    await ctx.teacher.onText('你好');
    expect(ctx.messenger.last()!.text).toContain('nǐ hǎo');
    expect(llm.calls[0]!.system).toContain('absolute beginner');
    fail = true;
    await ctx.teacher.onText('ещё');
    expect(ctx.messenger.last()!.text).toContain('Не получилось');
    await ctx.teacher.onCommand('stop');
    await ctx.teacher.onText('привет');
    expect(ctx.messenger.last()!.text).toContain('/lesson');
  });
});
