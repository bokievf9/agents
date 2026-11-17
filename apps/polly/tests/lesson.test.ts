import { describe, expect, it } from 'vitest';
import { content, OWNER, setup } from './helpers.js';

/** Plays a whole lesson, answering every quiz question correctly (answers are read from the content). */
async function playLesson(ctx: ReturnType<typeof setup>, day: number, wrong = 0) {
  const { teacher, press, messenger } = ctx;
  const lesson = content.lessons[day - 1]!;
  await press('Начать урок').catch(() => teacher.onCommand('lesson'));
  await press('Дальше'); // greeting -> word 1
  await press('Дальше'); // word 2
  await press('Дальше'); // word 3
  await press('Дальше'); // dialogue
  await press('Дальше'); // quiz 1
  for (let i = 0; i < 3; i++) {
    const q = lesson.quiz[i]!;
    const idx = i < wrong ? (q.a + 1) % q.o.length : q.a;
    await press(q.o[idx]!);
    await press('Дальше');
  }
  return messenger.sent.filter((m) => m.chatId === OWNER).at(-1)!;
}

describe('start and profile', () => {
  it('offers the placement test first and creates a zero-level profile when skipped', async () => {
    const { teacher, press, messenger, store } = setup();
    await teacher.onCommand('start');
    expect(messenger.last()!.text).toContain('теста уровня');
    await press('Я с нуля');
    const p = store.profile()!;
    expect(p).toMatchObject({ language: 'zh', level: 'zero', minutesPerDay: 30, lessonTime: '19:00', lessonDay: 1, streak: 0 });
  });

  it('changes the reminder time and rejects a bad one', async () => {
    const { teacher, store, messenger } = setup();
    await teacher.onCommand('time', '7:30');
    expect(store.profile()!.lessonTime).toBe('07:30');
    await teacher.onCommand('time', '25:99');
    expect(messenger.last()!.text).toContain('Формат');
    expect(store.profile()!.lessonTime).toBe('07:30');
  });
});

describe('lesson of the day', () => {
  it('runs greeting, 3 words, dialogue, 3 questions, then adds cards and moves to day 2', async () => {
    const ctx = setup();
    await ctx.teacher.onCommand('start');
    await ctx.press('Я с нуля');
    const lesson = content.lessons[0]!;
    await ctx.teacher.onCommand('lesson');
    expect(ctx.messenger.last()!.text).toContain('День 1 из 14');
    await ctx.press('Дальше');
    const word = ctx.messenger.last()!.text;
    expect(word).toContain('你好');
    expect(word).toContain('nǐ hǎo');
    expect(word).toContain('привет');
    expect(word).toContain('Пример');
    await ctx.press('Повтори');
    expect(ctx.messenger.last()!.text).toBe(word);
    await ctx.press('Объясни по-русски');
    expect(ctx.messenger.last()!.text).toContain('третьих тона');
    await ctx.press('Дальше');
    await ctx.press('Дальше');
    await ctx.press('Дальше'); // dialogue without translation
    expect(ctx.messenger.last()!.text).toContain('nǐ hǎo!');
    expect(ctx.messenger.last()!.text).not.toContain('Здравствуйте!');
    await ctx.press('Объясни по-русски');
    expect(ctx.messenger.last()!.text).toContain('Здравствуйте!');
    await ctx.press('Дальше'); // first question
    expect(ctx.messenger.last()!.text).toContain('Проверка, вопрос 1 из 3');
    // pressing the same answer twice counts once
    const q = lesson.quiz[0]!;
    await ctx.press(q.o[q.a]!);
    const sent = ctx.messenger.sent.length;
    const stale = ctx.messenger.sent.at(-2)!.buttons!.flat()[q.a]!.data;
    await ctx.teacher.onAction(stale);
    expect(ctx.messenger.sent.length).toBe(sent);
    await ctx.press('Дальше');
    for (const i of [1, 2]) {
      const qq = lesson.quiz[i]!;
      await ctx.press(qq.o[i === 1 ? (qq.a + 1) % qq.o.length : qq.a]!); // second answered wrong
      if (i === 1) expect(ctx.messenger.last()!.text).toContain('Не совсем');
      await ctx.press('Дальше');
    }
    const done = ctx.messenger.last()!;
    expect(done.text).toContain('Урок дня 1 пройден');
    expect(done.text).toContain('Правильных ответов: 2 из 3');
    const p = ctx.store.profile()!;
    expect(p.lessonDay).toBe(2);
    expect(p.streak).toBe(1);
    // 3 words + the dialogue phrase cards
    const phrases = lesson.dialog.lines.filter((l) => l.card).length;
    expect(ctx.store.cardCount()).toBe(3 + phrases);
    expect(ctx.store.card('w:谢谢')).toMatchObject({ p: 'xièxie', r: 'спасибо' });
  });

  it('counts the streak across days and breaks it after a skipped day', async () => {
    const ctx = setup();
    await playLesson(ctx, 1);
    expect(ctx.store.profile()!.streak).toBe(1);
    ctx.clock.t += 24 * 3600_000;
    await playLesson(ctx, 2);
    expect(ctx.store.profile()!.streak).toBe(2);
    ctx.clock.t += 3 * 24 * 3600_000; // two days skipped
    expect(ctx.teacher.currentStreak(ctx.store.profile()!)).toBe(0);
    await playLesson(ctx, 3);
    const p = ctx.store.profile()!;
    expect(p.streak).toBe(1);
    expect(p.bestStreak).toBe(2);
  });

  it('plays all 14 days, then says the first fortnight is done', async () => {
    const ctx = setup();
    for (let d = 1; d <= 14; d++) {
      await playLesson(ctx, d);
      ctx.clock.t += 24 * 3600_000;
    }
    expect(ctx.store.profile()!.lessonDay).toBe(15);
    expect(ctx.store.cardCount()).toBeGreaterThanOrEqual(42);
    await ctx.teacher.onCommand('lesson');
    expect(ctx.messenger.last()!.text).toContain('Первые 14 дней пройдены');
  });

  it('ignores buttons of an old step', async () => {
    const ctx = setup();
    await ctx.teacher.onCommand('lesson');
    const first = ctx.lastButtons().find((b) => b.text === 'Дальше')!;
    await ctx.teacher.onAction(first.data);
    const n = ctx.messenger.sent.length;
    await ctx.teacher.onAction(first.data); // same old "next" again
    expect(ctx.messenger.sent.length).toBe(n);
  });
});
