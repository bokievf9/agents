import { cosine, hybrid, MIN_SCORE, wordScore, HashEmbedder } from '../knowledge.js';
import { tiersFor } from '../stores.js';
import type {
  Audience, Embedder, Journal, JournalEntry, Knowledge, KnowledgeChunk, KnowledgeHit, KnowledgeMiss, Lesson, Lessons, MemTurn, Memory, PersonProfile,
} from '../stores.js';

/** In-memory adapters: tests, evals and local runs. Same contracts as Supabase (company isolation, TTL, no texts outside `live`). */

export class InMemoryKnowledge implements Knowledge {
  private readonly rows = new Map<string, { c: KnowledgeChunk; v: number[] }>();
  private readonly miss = new Map<string, KnowledgeMiss>();
  constructor(private readonly embedder: Embedder = new HashEmbedder()) {}

  async add(chunks: KnowledgeChunk[]): Promise<number> {
    const keep = chunks.filter((c) => c.tier !== 'secret');
    const vs = await this.embedder.embed(keep.map((c) => `${c.title}\n${c.text}`));
    keep.forEach((c, i) => this.rows.set(`${c.companyId}\u0000${c.id}`, { c, v: vs[i]! }));
    return keep.length;
  }

  async search(companyId: string, query: string, k: number, o: { audience?: Audience } = {}): Promise<KnowledgeHit[]> {
    const [q] = await this.embedder.embed([query]);
    const tiers = tiersFor(o.audience ?? 'visitor');
    const hits: KnowledgeHit[] = [];
    for (const { c, v } of this.rows.values()) {
      if (c.companyId !== companyId || !tiers.includes(c.tier ?? 'public')) continue;
      const h = hybrid(wordScore(query, `${c.title} ${c.text}`), cosine(q!, v));
      if (h.score >= MIN_SCORE) hits.push({ ...c, score: h.score, via: h.via });
    }
    return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
  }

  remove(companyId: string, idPrefix: string): Promise<number> {
    let n = 0;
    for (const [k, v] of this.rows) if (v.c.companyId === companyId && v.c.id.startsWith(idPrefix)) { this.rows.delete(k); n++; }
    return Promise.resolve(n);
  }

  missed(companyId: string, query: string, at: number): Promise<void> {
    const key = `${companyId}\u0000${query.trim().toLowerCase().slice(0, 200)}`;
    const m = this.miss.get(key);
    this.miss.set(key, { query: query.trim().slice(0, 200), count: (m?.count ?? 0) + 1, lastAt: at });
    return Promise.resolve();
  }

  misses(companyId: string, limit: number): Promise<KnowledgeMiss[]> {
    const out = [...this.miss.entries()].filter(([k]) => k.startsWith(`${companyId}\u0000`)).map(([, v]) => v);
    return Promise.resolve(out.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, limit));
  }
}

export class InMemoryMemory implements Memory {
  private readonly convs = new Map<string, { turns: MemTurn[]; expiresAt: number; contactKey?: string }>();
  private readonly people = new Map<string, PersonProfile>();
  private key = (c: string, id: string): string => `${c}\u0000${id}`;

  turns(companyId: string, conversationId: string, limit: number, now: number): Promise<MemTurn[]> {
    const c = this.convs.get(this.key(companyId, conversationId));
    if (!c || c.expiresAt <= now) return Promise.resolve([]);
    return Promise.resolve(c.turns.slice(-limit));
  }

  append(companyId: string, conversationId: string, turns: MemTurn[], expiresAt: number): Promise<void> {
    const k = this.key(companyId, conversationId);
    const c = this.convs.get(k) ?? { turns: [], expiresAt };
    c.turns.push(...turns);
    c.expiresAt = Math.max(c.expiresAt, expiresAt);
    this.convs.set(k, c);
    return Promise.resolve();
  }

  promote(companyId: string, conversationId: string, contactKey: string, expiresAt: number): Promise<void> {
    const c = this.convs.get(this.key(companyId, conversationId));
    if (c) {
      c.contactKey = contactKey;
      c.expiresAt = Math.max(c.expiresAt, expiresAt);
    }
    return Promise.resolve();
  }

  profile(companyId: string, contactKey: string, now: number): Promise<PersonProfile | null> {
    const p = this.people.get(this.key(companyId, contactKey));
    return Promise.resolve(p && p.expiresAt > now ? p : null);
  }

  saveProfile(p: PersonProfile): Promise<void> {
    this.people.set(this.key(p.companyId, p.contactKey), p);
    return Promise.resolve();
  }

  sweep(now: number): Promise<number> {
    let n = 0;
    for (const [k, c] of this.convs) {
      if (c.expiresAt <= now) {
        this.convs.delete(k);
        n++;
      }
    }
    for (const [k, p] of this.people) {
      if (p.expiresAt <= now) {
        this.people.delete(k);
        n++;
      }
    }
    return Promise.resolve(n);
  }

  /** Conversations held (a count for tests, never the contents). */
  size(): number {
    return this.convs.size;
  }
}

export class InMemoryLessons implements Lessons {
  private readonly rows: { l: Lesson; v: number[] }[] = [];
  private seq = 0;
  constructor(private readonly embedder: Embedder = new HashEmbedder()) {}

  async add(l: Omit<Lesson, 'id'>): Promise<string> {
    const id = `ls_${++this.seq}`;
    const [v] = await this.embedder.embed([l.question]);
    this.rows.push({ l: { ...l, id }, v: v! });
    return id;
  }

  async near(companyId: string, agentId: string, roleId: string, query: string, k: number): Promise<Lesson[]> {
    const [q] = await this.embedder.embed([query]);
    return this.rows
      .filter(({ l }) => l.companyId === companyId && (l.agentId === agentId || (l.agentId === '*' && l.roleId === roleId)))
      .map(({ l, v }) => ({ l, s: hybrid(wordScore(query, l.question), cosine(q!, v)).score }))
      .filter((x) => x.s >= MIN_SCORE)
      .sort((a, b) => b.s - a.s || a.l.id.localeCompare(b.l.id))
      .slice(0, k)
      .map((x) => x.l);
  }
}

/** Keeps entries in memory; drops texts of anything that is not `live`, whatever the caller passed (defence in depth). */
export class InMemoryJournal implements Journal {
  readonly entries: JournalEntry[] = [];
  /** `cap`: entries kept (a long-running process keeps the newest; absent: all, for tests and evals). */
  constructor(private readonly cap?: number) {}
  record(e: JournalEntry): Promise<void> {
    const copy: JournalEntry = { ...e, tools: [...e.tools] };
    if (copy.mode !== 'live') delete copy.texts;
    this.entries.push(copy);
    if (this.cap !== undefined && this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
    return Promise.resolve();
  }
}

/** All four in-memory stores at once. */
export function memoryStores(embedder: Embedder = new HashEmbedder()): { knowledge: InMemoryKnowledge; memory: InMemoryMemory; lessons: InMemoryLessons; journal: InMemoryJournal } {
  return { knowledge: new InMemoryKnowledge(embedder), memory: new InMemoryMemory(), lessons: new InMemoryLessons(embedder), journal: new InMemoryJournal() };
}
