import { describe, expect, it } from 'vitest';
import {
  chunkText, cosine, FiraNotWired, HashEmbedder, hybrid, InMemoryJournal, InMemoryKnowledge, InMemoryLessons, InMemoryMemory, SupabaseKnowledge, wordScore,
} from '../src/index.js';
import { DAY, NOW } from './helpers.js';

const chunk = (companyId: string, id: string, title: string, text: string) => ({ id, companyId, source: 'faq' as const, title, text, updatedAt: NOW });

describe('knowledge', () => {
  it('chunkText: chunks near the size at sentence ends, with overlap; nothing from empty text; deterministic', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Предложение номер ${i} про запись клиентов.`).join(' ');
    const a = chunkText(text, { size: 200, overlap: 40 });
    expect(a.length).toBeGreaterThan(5);
    expect(a.every((c) => c.length <= 300)).toBe(true);
    expect(a[1]!.startsWith('Предложение номер')).toBe(false); // the overlap carried a tail of the first chunk
    expect(chunkText(text, { size: 200, overlap: 40 })).toEqual(a);
    expect(chunkText('')).toEqual([]);
  });

  it('hybrid search: words and meaning, inside one company only, best first', async () => {
    const k = new InMemoryKnowledge();
    await k.add([
      chunk('salon', 'hours', 'Часы работы', 'Работаем ежедневно с 10:00 до 20:00.'),
      chunk('salon', 'prepay', 'Предоплата', 'Предоплата не нужна, перенос за 3 часа.'),
      chunk('clinic', 'hours', 'Часы работы', 'Клиника открыта с 8:00.'),
    ]);
    const hits = await k.search('salon', 'до скольки вы работаете?', 3);
    expect(hits[0]!.id).toBe('hours');
    expect(hits.every((h) => h.companyId === 'salon')).toBe(true);
    expect(['words', 'meaning', 'both']).toContain(hits[0]!.via);
    expect(await k.search('nobody', 'часы', 3)).toEqual([]);
  });

  it('misses are counted per company and question («агент не знал»)', async () => {
    const k = new InMemoryKnowledge();
    await k.missed('a', 'Есть парковка?', NOW);
    await k.missed('a', 'есть парковка?', NOW + 1);
    await k.missed('b', 'Есть парковка?', NOW);
    expect(await k.misses('a', 10)).toEqual([{ query: 'есть парковка?', count: 2, lastAt: NOW + 1 }]);
  });

  it('scoring helpers', async () => {
    expect(wordScore('запись на стрижку', 'Записываем на стрижку и окрашивание')).toBe(1);
    expect(wordScore('', 'x')).toBe(0);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(hybrid(1, 1)).toEqual({ score: 1, via: 'both' });
    const [a, b, c] = await new HashEmbedder().embed(['запись клиентов', 'записи клиента', 'доставка пиццы']);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });
});

describe('memory', () => {
  it('turns expire, a promotion extends them, profiles are per company and expire too', async () => {
    const m = new InMemoryMemory();
    await m.append('a', 'c', [{ role: 'user', text: 'привет', at: NOW }], NOW + DAY);
    expect(await m.turns('a', 'c', 10, NOW + DAY - 1)).toHaveLength(1);
    expect(await m.turns('a', 'c', 10, NOW + DAY)).toEqual([]);
    expect(await m.turns('b', 'c', 10, NOW)).toEqual([]);
    await m.promote('a', 'c', '+99290', NOW + 90 * DAY);
    expect(await m.turns('a', 'c', 10, NOW + 2 * DAY)).toHaveLength(1);
    await m.saveProfile({ companyId: 'a', contactKey: '+99290', facts: ['салон'], summary: '', conversations: 1, lastAt: NOW, expiresAt: NOW + 90 * DAY });
    expect((await m.profile('a', '+99290', NOW))?.facts).toEqual(['салон']);
    expect(await m.profile('b', '+99290', NOW)).toBeNull();
    expect(await m.sweep(NOW + 91 * DAY)).toBe(2);
  });
});

describe('lessons', () => {
  it('near: this agent and the role-wide lessons of the company, closest first, nothing of other companies', async () => {
    const l = new InMemoryLessons();
    const base = { roleId: 'lead-manager', bad: '', source: 'owner_review' as const, createdAt: NOW };
    await l.add({ ...base, companyId: 'a', agentId: 'a/lm', question: 'Сколько стоит сайт?', good: 'Сайт от $150.' });
    await l.add({ ...base, companyId: 'a', agentId: '*', question: 'Сколько стоит сайт для кафе?', good: 'Сайт для кафе от $150.' });
    await l.add({ ...base, companyId: 'a', agentId: 'a/other', question: 'Сколько стоит сайт?', good: 'нет' });
    await l.add({ ...base, companyId: 'b', agentId: 'a/lm', question: 'Сколько стоит сайт?', good: 'нет' });
    const near = await l.near('a', 'a/lm', 'lead-manager', 'сколько стоит сайт', 5);
    expect(near.map((x) => x.good)).toEqual(['Сайт от $150.', 'Сайт для кафе от $150.']);
  });
});

describe('journal', () => {
  it('drops texts of anything that is not live, whatever the caller passed', async () => {
    const j = new InMemoryJournal();
    const e = { companyId: 'a', agentId: 'a/x', specVersion: 1, conversationId: 'c', at: NOW, tier: 'sonnet', rounds: 1, tools: [], handoff: false, contact: false, removed: 0, flagged: 0, fallback: false, unknown: false, texts: { user: 'u', reply: 'r' } };
    await j.record({ ...e, mode: 'anon' });
    await j.record({ ...e, mode: 'demo' });
    await j.record({ ...e, mode: 'live' });
    expect(j.entries.map((x) => x.texts)).toEqual([undefined, undefined, { user: 'u', reply: 'r' }]);
  });
});

describe('Supabase adapter (stub)', () => {
  const s = new SupabaseKnowledge({ url: 'https://example.supabase.co', serviceKey: 'k', dims: 3 });
  it('builds the requests with the company on every row and filter, never sends them', async () => {
    expect(s.requestFor.search('firtech', 'часы', [0.1, 0.2, 0.3], 4)).toEqual({
      method: 'POST', path: '/rest/v1/rpc/fira_match_chunks', body: { p_company: 'firtech', p_query: 'часы', p_embedding: [0.1, 0.2, 0.3], p_k: 4 },
    });
    expect((s.requestFor.add([chunk('firtech', 'x', 't', 'b')], [[1, 2, 3]]).body as { company_id: string }[])[0]!.company_id).toBe('firtech');
    expect(s.requestFor.misses('firtech', 5).query).toMatchObject({ company_id: 'eq.firtech' });
    expect(() => s.requestFor.search('firtech', 'q', [1], 1)).toThrow(/dims/);
    await expect(s.search()).rejects.toBeInstanceOf(FiraNotWired);
    await expect(s.add()).rejects.toThrow(/stub/);
  });
  it('refuses a non-https project URL', () => {
    expect(() => new SupabaseKnowledge({ url: 'http://x', serviceKey: 'k', dims: 3 })).toThrow(/https/);
  });
});
