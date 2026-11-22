/**
 * The four stores of Fira, as interfaces: `Knowledge` (what the company knows), `Memory` (turns and people), `Lessons` (corrections that teach),
 * `Journal` (what happened, for metrics). Production: Supabase with pgvector and RLS by company (`adapters/supabase.ts`, `sql/fira-schema.sql`);
 * tests and evals: the in-memory adapters (`adapters/memory.ts`). Every row carries `companyId`: one company never reads another's data.
 */

/** How a conversation is kept: `live` (texts kept `retention.liveDays` at the owning company), `anon` (no contact yet: turns kept
 * `retention.anonHours`, the journal never has texts), `demo` (nothing is kept at all). */
export const MODES = ['live', 'anon', 'demo'] as const;
export type Mode = (typeof MODES)[number];

export const KNOWLEDGE_SOURCES = ['site', 'instagram', 'price', 'document', 'builder', 'faq', 'manual', 'niche'] as const;
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];

/**
 * Secrecy of a knowledge document (owner 2026-11-23: «все знания компании и жёсткие правила о неразглашении»). `public`: what the site and its
 * documents say to anyone. `internal`: how the company works inside (processes, playbooks, architecture): the owner only. `secret`: keys, env, the
 * server, clients' data and dialogues, finances, margins, other clients' projects: never becomes knowledge at all (the store refuses it).
 */
export const KNOWLEDGE_TIERS = ['public', 'internal', 'secret'] as const;
export type KnowledgeTier = (typeof KNOWLEDGE_TIERS)[number];

/** Who the agent is talking to: an anonymous visitor, a signed-in client of the company, or the owner of the company. */
export const AUDIENCES = ['visitor', 'client', 'owner'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** The tiers an audience may read. A client reads what a visitor reads (its own pack lives in its own company); `secret` nobody. */
export function tiersFor(audience: Audience): KnowledgeTier[] {
  return audience === 'owner' ? ['public', 'internal'] : ['public'];
}

export interface KnowledgeChunk {
  id: string;
  companyId: string;
  source: KnowledgeSource;
  title: string;
  text: string;
  /** Where it came from (a URL, a file name), for the cabinet; never sent to the model as an instruction. */
  ref?: string;
  /** Secrecy; absent is `public`. A `secret` chunk is refused by every store. */
  tier?: KnowledgeTier;
  updatedAt: number;
}

export interface KnowledgeHit extends KnowledgeChunk {
  /** 0..1, higher is better. */
  score: number;
  /** Which half of the hybrid search found it. */
  via: 'words' | 'meaning' | 'both';
}

/** A question the agent could not answer (the cabinet's «Агент не знал» list, turned into FAQ drafts). */
export interface KnowledgeMiss {
  query: string;
  count: number;
  lastAt: number;
}

export interface Knowledge {
  /** Adds or replaces chunks by id; returns how many were written (`secret` chunks are dropped, never written). */
  add(chunks: KnowledgeChunk[]): Promise<number>;
  /** Hybrid search (words + meaning) inside one company, only the tiers the audience may read (default: a visitor, `public`). */
  search(companyId: string, query: string, k: number, o?: { audience?: Audience }): Promise<KnowledgeHit[]>;
  /** Drops the chunks of one company whose id starts with `idPrefix` (an edited or deleted owner note); returns how many. Optional: a store without it keeps stale chunks. */
  remove?(companyId: string, idPrefix: string): Promise<number>;
  /** Notes a question nothing answered. */
  missed(companyId: string, query: string, at: number): Promise<void>;
  misses(companyId: string, limit: number): Promise<KnowledgeMiss[]>;
}

export interface MemTurn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

/** What the agent remembers about one person of the company (by a contact key: a phone, a Telegram id, a widget cookie). */
export interface PersonProfile {
  companyId: string;
  contactKey: string;
  name?: string;
  /** Short facts the person gave («клиент салона, стрижка раз в месяц»). */
  facts: string[];
  /** Summary of past conversations, a few lines. */
  summary: string;
  conversations: number;
  lastAt: number;
  expiresAt: number;
}

export interface Memory {
  /** The last `limit` turns of a conversation that are not expired. */
  turns(companyId: string, conversationId: string, limit: number, now: number): Promise<MemTurn[]>;
  /** Appends turns that live until `expiresAt` (the whole conversation takes the latest expiry). */
  append(companyId: string, conversationId: string, turns: MemTurn[], expiresAt: number): Promise<void>;
  /** A contact appeared: the conversation is tied to the person and lives as long as live texts do. */
  promote(companyId: string, conversationId: string, contactKey: string, expiresAt: number): Promise<void>;
  profile(companyId: string, contactKey: string, now: number): Promise<PersonProfile | null>;
  saveProfile(p: PersonProfile): Promise<void>;
  /** Deletes everything expired; returns the number of rows removed. */
  sweep(now: number): Promise<number>;
}

export const LESSON_SOURCES = ['owner_review', 'client_cabinet', 'eval', 'rating'] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];

/** A correction as text: on this kind of question, this is how to answer. Few-shot by closeness to the current question. */
export interface Lesson {
  id: string;
  companyId: string;
  /** The agent it belongs to; `*` for every agent of the company with this role. */
  agentId: string;
  roleId: string;
  question: string;
  /** What the agent said (may be empty). */
  bad: string;
  /** What it should have said. */
  good: string;
  source: LessonSource;
  /** What kind of correction (`price`, `tone`, `handoff`, `thread`...), for the owner's review of lessons. */
  tag?: string;
  createdAt: number;
}

export interface Lessons {
  add(l: Omit<Lesson, 'id'>): Promise<string>;
  /** Closest lessons of this agent (and of `*` for its role) to the query. */
  near(companyId: string, agentId: string, roleId: string, query: string, k: number): Promise<Lesson[]>;
}

/** One turn in the journal: counters always, texts only in `live` mode. */
export interface JournalEntry {
  companyId: string;
  agentId: string;
  specVersion: number;
  conversationId: string;
  at: number;
  mode: Mode;
  tier: string;
  rounds: number;
  tools: string[];
  handoff: boolean;
  contact: boolean;
  /** Sentences the guards dropped. */
  removed: number;
  /** Stock-phrase flags. */
  flagged: number;
  fallback: boolean;
  /** The agent did not know (no knowledge hit for a question it had to answer). */
  unknown: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** Non-disclosure: the turn was a probe (refused by code), sentences the leak guard cut and what they gave away (kinds only, never text). */
  probe?: boolean;
  leaked?: number;
  leakKinds?: string[];
  texts?: { user: string; reply: string };
}

export interface Journal {
  record(e: JournalEntry): Promise<void>;
}

/** Turns text into vectors for the «meaning» half of the search. Production: an embeddings API behind the gateway; tests: `HashEmbedder`. */
export interface Embedder {
  readonly dims: number;
  /** Vectors of documents (knowledge chunks). */
  embed(texts: string[]): Promise<number[][]>;
  /** Vectors of questions, when the model tells them from documents (Voyage `input_type: query`); absent: `embed`. */
  embedQuery?(texts: string[]): Promise<number[][]>;
}
