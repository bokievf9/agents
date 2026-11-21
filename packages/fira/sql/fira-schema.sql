-- Fira schema for Supabase (Postgres 15 + pgvector). DRAFT for review (docs/fira-architecture.md, §7): not applied anywhere yet.
-- Applying it to the production project needs the owner's go-ahead. Every table carries company_id; RLS lets a signed-in cabinet user
-- read only the rows of his company, HQ writes with the service role (bypasses RLS) and sets company_id itself.
-- At apply time the tables go into their own schema (`create schema fira; set search_path = fira, public;`), apart from the site's tables.

create extension if not exists vector;

-- tenants: Fir Tech is tenant 0 ('firtech')
create table if not exists companies (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  name text not null,
  about text not null default '',
  facts jsonb not null default '[]',
  style jsonb not null,             -- CompanyStyle
  rights jsonb not null,            -- CompanyRights
  retention jsonb not null default '{"liveDays":90,"anonHours":24}',
  monthly_budget_usd numeric,
  created_at timestamptz not null default now()
);

-- who of the cabinet belongs to which company (auth.users of the site's Supabase)
create table if not exists company_members (
  company_id text not null references companies(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner','member')),
  primary key (company_id, user_id)
);

create table if not exists role_packs (
  id text not null,
  version int not null,
  body_md text not null,            -- the Markdown of role-packs/<id>.md
  created_at timestamptz not null default now(),
  primary key (id, version)
);

create table if not exists niche_packs (
  id text not null,
  version int not null,
  body_md text not null,
  created_at timestamptz not null default now(),
  primary key (id, version)
);

create table if not exists agents (
  id text primary key,              -- '<company>/<role>' or '<company>/<role>-<n>'
  company_id text not null references companies(id) on delete cascade,
  role_id text not null,
  role_version int not null,
  niche_id text not null,
  niche_version int not null,
  model jsonb not null,             -- ModelPolicy
  guards jsonb not null,            -- GuardPolicy
  state text not null default 'draft' check (state in ('draft','live','paused')),
  spec_version int not null default 1,
  evals text[] not null default '{}',
  updated_at timestamptz not null default now()
);
create index if not exists agents_company on agents (company_id);

create table if not exists knowledge_chunks (
  company_id text not null references companies(id) on delete cascade,
  id text not null,
  source text not null check (source in ('site','instagram','price','document','builder','faq','manual','niche')),
  -- secrecy (2026-11-23): public for anyone, internal for the owner only; secret is never stored (the check refuses it)
  tier text not null default 'public' check (tier in ('public','internal')),
  title text not null,
  text text not null,
  ref text,
  confirmed boolean not null default false,   -- auto-generated FAQ: false until the client confirms in the cabinet
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('simple', title || ' ' || text)) stored,
  updated_at timestamptz not null default now(),
  primary key (company_id, id)
);
create index if not exists knowledge_chunks_tsv on knowledge_chunks using gin (tsv);
create index if not exists knowledge_chunks_vec on knowledge_chunks using hnsw (embedding vector_cosine_ops);

create table if not exists knowledge_misses (
  company_id text not null references companies(id) on delete cascade,
  query text not null,
  count int not null default 1,
  last_at timestamptz not null default now(),
  primary key (company_id, query)
);

-- people of a company (its customers), by a contact key
create table if not exists people (
  company_id text not null references companies(id) on delete cascade,
  contact_key text not null,
  name text,
  facts jsonb not null default '[]',
  summary text not null default '',
  conversations int not null default 0,
  last_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (company_id, contact_key)
);

create table if not exists conversations (
  company_id text not null references companies(id) on delete cascade,
  id text not null,
  agent_id text not null references agents(id) on delete cascade,
  channel text not null,            -- web, widget, telegram, cabinet
  mode text not null check (mode in ('live','anon')),   -- demo never reaches the database
  contact_key text,
  started_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  expires_at timestamptz not null,  -- live: +retention.liveDays, anon: +retention.anonHours
  primary key (company_id, id)
);
create index if not exists conversations_expiry on conversations (expires_at);

create table if not exists messages (
  company_id text not null,
  conversation_id text not null,
  n int not null,
  role text not null check (role in ('user','assistant')),
  text text not null,
  at timestamptz not null default now(),
  primary key (company_id, conversation_id, n),
  foreign key (company_id, conversation_id) references conversations(company_id, id) on delete cascade
);

create table if not exists lessons (
  id bigint generated always as identity primary key,
  company_id text not null references companies(id) on delete cascade,
  agent_id text not null,           -- '*' = every agent of the company with role_id
  role_id text not null,
  question text not null,
  bad text not null default '',
  good text not null,
  source text not null check (source in ('owner_review','client_cabinet','eval')),
  tag text not null default '',      -- price, tone, handoff, thread...
  embedding vector(1024),
  created_at timestamptz not null default now()
);
create index if not exists lessons_agent on lessons (company_id, agent_id);

-- journal: counters always; texts never here (they are in messages, with their TTL)
create table if not exists turns (
  id bigint generated always as identity primary key,
  company_id text not null,
  agent_id text not null,
  spec_version int not null,
  conversation_id text not null,
  at timestamptz not null default now(),
  mode text not null,
  tier text not null,
  rounds int not null,
  tools text[] not null default '{}',
  handoff boolean not null,
  contact boolean not null,
  removed int not null,
  flagged int not null,
  fallback boolean not null,
  unknown boolean not null,
  input_tokens int,
  output_tokens int
);
create index if not exists turns_agent_at on turns (company_id, agent_id, at);

create table if not exists evals (
  id bigint generated always as identity primary key,
  agent_id text not null,
  spec_version int not null,
  set_name text not null,
  passed int not null,
  total int not null,
  metrics jsonb not null,
  live boolean not null,
  at timestamptz not null default now()
);

-- hybrid search: words (ts_rank) and meaning (cosine), half and half, one company only
create or replace function fira_match_chunks(p_company text, p_query text, p_embedding vector, p_k int, p_tiers text[] default array['public'])
returns table (id text, title text, text text, source text, score real) language sql stable as $$
  select c.id, c.title, c.text, c.source,
         (0.5 * least(1, ts_rank(c.tsv, plainto_tsquery('simple', p_query)) * 10)
        + 0.5 * greatest(0, 1 - (c.embedding <=> p_embedding)))::real as score
  from knowledge_chunks c
  where c.company_id = p_company and c.tier = any(p_tiers)
  order by score desc
  limit p_k
$$;

create or replace function fira_note_miss(p_company text, p_query text, p_at timestamptz)
returns void language sql as $$
  insert into knowledge_misses (company_id, query, count, last_at) values (p_company, lower(p_query), 1, p_at)
  on conflict (company_id, query) do update set count = knowledge_misses.count + 1, last_at = excluded.last_at
$$;

-- RLS: members read their company; nobody but the service role writes
alter table companies enable row level security;
alter table agents enable row level security;
alter table knowledge_chunks enable row level security;
alter table knowledge_misses enable row level security;
alter table people enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table lessons enable row level security;
alter table turns enable row level security;

create or replace function fira_is_member(p_company text) returns boolean language sql stable security definer as $$
  select exists (select 1 from company_members m where m.company_id = p_company and m.user_id = auth.uid())
$$;

create policy companies_read on companies for select using (fira_is_member(id));
create policy agents_read on agents for select using (fira_is_member(company_id));
create policy chunks_read on knowledge_chunks for select using (fira_is_member(company_id));
create policy misses_read on knowledge_misses for select using (fira_is_member(company_id));
create policy people_read on people for select using (fira_is_member(company_id));
create policy conversations_read on conversations for select using (fira_is_member(company_id));
create policy messages_read on messages for select using (fira_is_member(company_id));
create policy lessons_read on lessons for select using (fira_is_member(company_id));
create policy turns_read on turns for select using (fira_is_member(company_id));

-- TTL: a cron (pg_cron or the HQ sweep) deletes what expired
-- delete from conversations where expires_at < now();   -- messages go by cascade
-- delete from people where expires_at < now();
