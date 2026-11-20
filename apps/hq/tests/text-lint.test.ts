import type { LlmRequest } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { lintCopy, renderClip, clipSchema } from '@fir/worker-content-maker';
import { clipJson, routedLlm, world } from './helpers.js';

const topicIntent = { split: () => JSON.stringify({ action: 'topic', topic: 'бот-администратор для барбершопа', type: 'clip' }) };
const CLEAN = JSON.parse(clipJson()) as Record<string, unknown>;

/** A clip whose script is stock phrases from the AI-slop lexicon (none of them is caught by the older brand-voice lint). */
const SLOP = {
  ...CLEAN,
  scenes: [
    { voice: 'Наш уникальный и инновационный подход даёт широкий спектр возможностей.', subtitle: 'Подход' },
    { voice: 'Давайте разберёмся, как раскрыть потенциал вашего салона, не упустите шанс.', subtitle: 'Потенциал' },
    { voice: 'Мы ваш надёжный партнёр, комплексное решение для бизнеса.', subtitle: 'Партнёр' },
    { voice: 'Эффективный и надёжный бот записывает клиентов в рамках вашего процесса.', subtitle: 'Запись' },
  ],
};

/** The first draft is `first`; a rework (the prompt carries the remarks) is the clean clip. Counts generations and the remarks given. */
function llmWith(first: Record<string, unknown>) {
  const base = routedLlm({ ...topicIntent });
  const seen = { gens: 0, remarks: [] as string[] };
  const llm = {
    enabled: true,
    complete: (req: LlmRequest) => {
      const user = req.messages[0]!.content;
      if (user.startsWith('Составь сценарий')) {
        seen.gens++;
        if (user.includes('Комментарий владельца')) seen.remarks.push(user);
        else return Promise.resolve(JSON.stringify(first));
      }
      return base.complete(req);
    },
  };
  return { llm, seen };
}

describe('Marketing head: text lints before an approval card (text.detect and text.captionLint)', () => {
  it('lintCopy: the fixture script is stock-word text, the default clip is not', () => {
    const slop = lintCopy(`Пакет, материал 1 из 7.\n\n${renderClip(clipSchema.parse(SLOP))}`)!;
    expect(slop.issues.join(' ')).toContain('штампы');
    const clean = lintCopy(`Пакет, материал 1 из 7.\n\n${renderClip(clipSchema.parse(CLEAN))}`)!;
    expect(clean.issues).toEqual([]);
    expect(clean.line).toMatch(/^Проверка текста: человечность \d+, подпись /);
    expect(lintCopy('Профиль Instagram: настройка\nБио: тест')).toBeNull();
  });

  it('a script with AI stock words goes back once to the content maker, then the card carries the scores', async () => {
    const { llm, seen } = llmWith(SLOP);
    const w = world({ llm });
    const t = w.hq.createTask({ title: 'Сделай ролик про барбершоп', dept: 'marketing', creator: 'owner' });
    await w.marketing.onHeartbeat();
    const comments = w.hq.events(t.id).filter((e) => e.kind === 'comment').map((e) => e.body);
    expect(comments[0]).toMatch(/Ревью, замечания: сценарий: человечность \d+, штампы/);
    expect(seen.remarks.length).toBeGreaterThanOrEqual(1);
    expect(seen.remarks[0]).toContain('штампы');
    expect(w.hq.task(t.id)!.status).toBe('approval');
    const card = w.hq.queuedApprovals()[0]!;
    expect(card.summary).toMatch(/Проверка текста: человечность \d+, подпись /);
    expect(card.summary).not.toContain('Ревью отдела после доработки');
  });

  it('an Instagram caption with too many hashtags fails the caption lint and is reworked once', async () => {
    const tags = ['#а1', '#б2', '#в3', '#г4', '#д5', '#е6', '#ж7'];
    const { llm, seen } = llmWith({ ...CLEAN, captions: { ...(CLEAN.captions as object), instagram: { text: 'Клиент пишет в 2 ночи, бот отвечает за 2 секунды. Напишите нам: firtech.pro', hashtags: tags } } });
    const w = world({ llm });
    const t = w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner' });
    await w.marketing.onHeartbeat();
    expect(w.hq.events(t.id).filter((e) => e.kind === 'comment')[0]!.body).toContain('подпись Instagram: 7 хэштегов, лимит Instagram 5');
    expect(seen.remarks[0]).toContain('подпись Instagram');
    expect(w.hq.queuedApprovals()[0]!.summary).toMatch(/подпись ок|подпись есть замечания/);
  });

  it('the rework happens once: remarks that remain are shown on the card with the scores', async () => {
    const base = routedLlm({ ...topicIntent });
    const llm = {
      enabled: true,
      complete: (req: LlmRequest) => (req.messages[0]!.content.startsWith('Составь сценарий') ? Promise.resolve(JSON.stringify(SLOP)) : base.complete(req)),
    };
    const w = world({ llm });
    const t = w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner' });
    await w.marketing.onHeartbeat();
    expect(w.hq.events(t.id).filter((e) => e.kind === 'comment')).toHaveLength(1);
    const card = w.hq.queuedApprovals()[0]!;
    expect(card.summary).toContain('Ревью отдела после доработки: сценарий: человечность');
    expect(card.summary).toMatch(/Проверка текста: человечность \d+/);
  });

  it('a clean clip passes without any rework and shows its scores', async () => {
    const { llm, seen } = llmWith(CLEAN);
    const w = world({ llm });
    const t = w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner' });
    await w.marketing.onHeartbeat();
    expect(seen.remarks).toHaveLength(0);
    expect(w.hq.events(t.id).filter((e) => e.kind === 'comment')).toHaveLength(0);
    expect(w.hq.queuedApprovals()[0]!.summary).toMatch(/Проверка текста: человечность \d+, подпись /);
  });
});
