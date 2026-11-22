import { describe, expect, it, vi } from 'vitest';
import { InMemoryKnowledge, voyageFromEnv, VoyageEmbedder, type Embedder } from '../src/index.js';
import { NOW } from './helpers.js';

const chunk = (id: string, title: string, text: string) => ({ id, companyId: 'c', source: 'faq' as const, title, text, updatedAt: NOW });
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const vecs = (n: number) => ({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: [index + 1, 0] })), usage: { total_tokens: n * 10 } });
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body) as { input: string[]; model: string; input_type: string };

describe('voyage adapter', () => {
  const mk = (f: typeof fetch, o: Partial<ConstructorParameters<typeof VoyageEmbedder>[0]> = {}) => new VoyageEmbedder({ apiKey: 'k', fetch: f, sleep: () => Promise.resolve(), ...o });

  it('batches by 128, sends the model and input_type, keeps the order', async () => {
    const f = vi.fn((_u: unknown, init?: { body?: string }) => Promise.resolve(ok(vecs((JSON.parse(init!.body!) as { input: string[] }).input.length))));
    const e = mk(f as unknown as typeof fetch);
    const out = await e.embed(Array.from({ length: 300 }, (_, i) => `t${i}`));
    expect(out).toHaveLength(300);
    expect(f).toHaveBeenCalledTimes(3);
    expect(bodyOf(f.mock.calls[0]!)).toMatchObject({ model: 'voyage-3.5-lite', input_type: 'document' });
    expect(bodyOf(f.mock.calls[0]!).input).toHaveLength(128);
    expect(bodyOf(f.mock.calls[2]!).input).toHaveLength(44);
    await e.embedQuery(['q']);
    expect(bodyOf(f.mock.calls[3]!).input_type).toBe('query');
    expect(e.usage.texts).toBe(301);
  });

  it('retries on 429 and 5xx with backoff, then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(ok({}, 429)).mockResolvedValueOnce(ok({}, 503)).mockResolvedValueOnce(ok(vecs(1)));
    const waits: number[] = [];
    const e = mk(f as unknown as typeof fetch, { sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });
    expect(await e.embedQuery(['q'])).toEqual([[1, 0]]);
    expect(f).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([500, 1000]);
  });

  it('gives up after the retries; a 400 is not retried', async () => {
    const f = vi.fn().mockResolvedValue(ok({}, 500));
    await expect(mk(f as unknown as typeof fetch, { retries: 2 }).embed(['a'])).rejects.toThrow(/failed after 3 tries/);
    expect(f).toHaveBeenCalledTimes(3);
    const g = vi.fn().mockResolvedValue(ok({}, 400));
    await expect(mk(g as unknown as typeof fetch).embed(['a'])).rejects.toThrow(/http 400/);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('no key: null, no request; VOYAGE_MODEL overrides the model', () => {
    expect(voyageFromEnv({})).toBeNull();
    expect(voyageFromEnv({ VOYAGE_API_KEY: ' ' })).toBeNull();
    expect(voyageFromEnv({ VOYAGE_API_KEY: 'k', VOYAGE_MODEL: 'voyage-3.5' })?.model).toBe('voyage-3.5');
    expect(voyageFromEnv({ VOYAGE_API_KEY: 'k' })?.model).toBe('voyage-3.5-lite');
  });
});

/** A toy "semantic" embedder: concepts, not words (price ~ cost ~ сколько стоит). */
class ConceptEmbedder implements Embedder {
  readonly dims = 3;
  calls: string[][] = [];
  failQuery = false;
  failDocs = false;
  private v(t: string): number[] {
    const s = t.toLowerCase();
    return [/цен|стоит|прайс|тариф/.test(s) ? 1 : 0, /час|график|работаем|открыт/.test(s) ? 1 : 0, 0.05];
  }
  embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return this.failDocs ? Promise.reject(new Error('down')) : Promise.resolve(texts.map((t) => this.v(t)));
  }
  embedQuery(texts: string[]): Promise<number[][]> {
    return this.failQuery ? Promise.reject(new Error('down')) : Promise.resolve(texts.map((t) => this.v(t)));
  }
}

describe('knowledge with embeddings', () => {
  it('a semantically close chunk beats a keyword-only match', async () => {
    const k = new InMemoryKnowledge(new ConceptEmbedder());
    await k.add([
      chunk('tariff', 'Тарифы', 'Прайс на сайты начинается от 500 долларов.'),
      chunk('noise', 'Блог', 'Мы часто пишем в блог про то как сколько-то людей решили что-то.'),
    ]);
    const hits = await k.search('c', 'сколько стоит сайт', 3);
    expect(hits[0]!.id).toBe('tariff');
    expect(hits[0]!.via).toBe('meaning');
  });

  it('re-embeds only changed chunks (by content hash)', async () => {
    const e = new ConceptEmbedder();
    const k = new InMemoryKnowledge(e);
    const a = chunk('a', 'Тарифы', 'Прайс один.');
    const b = chunk('b', 'График', 'Работаем с десяти.');
    await k.add([a, b]);
    expect(e.calls.map((c) => c.length)).toEqual([2]);
    await k.add([a, b]);
    expect(e.calls).toHaveLength(1); // nothing changed: no call at all
    await k.add([a, { ...b, text: 'Работаем с девяти.' }]);
    expect(e.calls.map((c) => c.length)).toEqual([2, 1]);
  });

  it('query embedding failure: words-only for that turn, no error', async () => {
    const e = new ConceptEmbedder();
    const k = new InMemoryKnowledge(e);
    await k.add([chunk('a', 'Часы работы', 'Работаем ежедневно с десяти до восьми.')]);
    e.failQuery = true;
    const hits = await k.search('c', 'работаем ежедневно', 3);
    expect(hits[0]!.id).toBe('a');
    expect(hits[0]!.via).toBe('words');
  });

  it('document embedding failure keeps chunks for word search; the next add retries them', async () => {
    const e = new ConceptEmbedder();
    e.failDocs = true;
    const k = new InMemoryKnowledge(e);
    const a = chunk('a', 'Часы работы', 'Работаем ежедневно с десяти до восьми.');
    expect(await k.add([a])).toBe(1);
    expect((await k.search('c', 'работаем ежедневно', 3))[0]!.id).toBe('a');
    e.failDocs = false;
    await k.add([a]);
    expect(e.calls).toHaveLength(2);
  });

  it('over the char cap nothing is embedded, search still works by words', async () => {
    const e = new ConceptEmbedder();
    const k = new InMemoryKnowledge(e, 50);
    await k.add([chunk('a', 'Часы работы', 'Работаем ежедневно с десяти до восьми часов вечера каждый день.')]);
    expect(e.calls).toHaveLength(0);
    expect((await k.search('c', 'работаем ежедневно', 3))[0]!.id).toBe('a');
  });

  it('tier filtering and secret are kept with embeddings', async () => {
    const k = new InMemoryKnowledge(new ConceptEmbedder());
    await k.add([{ ...chunk('i', 'Тарифы', 'Прайс внутренний.'), tier: 'internal' }, { ...chunk('s', 'Тарифы', 'Прайс секрет.'), tier: 'secret' }]);
    expect(await k.search('c', 'сколько стоит', 5)).toEqual([]);
    expect((await k.search('c', 'сколько стоит', 5, { audience: 'owner' })).map((h) => h.id)).toEqual(['i']);
  });
});
