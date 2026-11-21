import type { Knowledge, KnowledgeChunk, KnowledgeHit, KnowledgeMiss } from '../stores.js';

/**
 * STUB of the Supabase adapter (no network in this package yet). It fixes the shape of the requests the real adapter will send to PostgREST
 * (`/rest/v1/...` and the RPC `fira_match_chunks` of `sql/fira-schema.sql`) so the schema, the RLS and the code can be reviewed together.
 * Every method that would touch the network throws `FiraNotWired`; `requestFor` builds the request without sending it.
 * Wiring it is step 2 of the migration plan (`docs/fira-architecture.md`, §9), with the owner's go-ahead for the production project.
 */
export class FiraNotWired extends Error {
  constructor(what: string) {
    super(`fira: the Supabase adapter is a stub (${what}); use the in-memory adapters until it is wired`);
    this.name = 'FiraNotWired';
  }
}

export interface SupabaseConfig {
  /** https://<project>.supabase.co */
  url: string;
  /** The HQ service key: kept in env, never logged. The adapter sets `company_id` on every row and every filter itself. */
  serviceKey: string;
  /** Embedding size of the column `knowledge_chunks.embedding`. */
  dims: number;
}

export interface SupabaseRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export class SupabaseKnowledge implements Knowledge {
  constructor(private readonly cfg: SupabaseConfig) {
    if (!/^https:\/\//.test(cfg.url)) throw new Error('fira: Supabase url must be https');
  }

  /** The request each method would send (for review and tests); never sent here. Headers (apikey, Authorization) are added by the transport. */
  readonly requestFor = {
    add: (chunks: KnowledgeChunk[], embeddings: number[][]): SupabaseRequest => ({
      method: 'POST',
      path: '/rest/v1/knowledge_chunks',
      query: { on_conflict: 'company_id,id' },
      body: chunks.map((c, i) => ({
        id: c.id, company_id: c.companyId, source: c.source, title: c.title, text: c.text, ref: c.ref ?? null,
        updated_at: new Date(c.updatedAt).toISOString(), embedding: embeddings[i] ?? null,
      })),
    }),
    search: (companyId: string, query: string, embedding: number[], k: number): SupabaseRequest => {
      if (embedding.length !== this.cfg.dims) throw new Error(`fira: embedding has ${embedding.length} dims, the column has ${this.cfg.dims}`);
      return { method: 'POST', path: '/rest/v1/rpc/fira_match_chunks', body: { p_company: companyId, p_query: query, p_embedding: embedding, p_k: k } };
    },
    missed: (companyId: string, query: string, at: number): SupabaseRequest => ({
      method: 'POST', path: '/rest/v1/rpc/fira_note_miss', body: { p_company: companyId, p_query: query.slice(0, 200), p_at: new Date(at).toISOString() },
    }),
    misses: (companyId: string, limit: number): SupabaseRequest => ({
      method: 'GET', path: '/rest/v1/knowledge_misses', query: { company_id: `eq.${companyId}`, order: 'count.desc,last_at.desc', limit: String(limit) },
    }),
  };

  add(): Promise<number> {
    return Promise.reject(new FiraNotWired('knowledge.add'));
  }
  search(): Promise<KnowledgeHit[]> {
    return Promise.reject(new FiraNotWired('knowledge.search'));
  }
  missed(): Promise<void> {
    return Promise.reject(new FiraNotWired('knowledge.missed'));
  }
  misses(): Promise<KnowledgeMiss[]> {
    return Promise.reject(new FiraNotWired('knowledge.misses'));
  }
}
