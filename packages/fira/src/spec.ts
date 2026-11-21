/**
 * Fira: the agent specification. An agent is **role × niche × company** (`docs/fira-architecture.md`, §1): the role pack says what the job is,
 * the niche pack what the field knows, the company pack whose agent it is (facts, style, rights). The model policy and the eval set complete it.
 * A spec is data: it is compiled into a prompt and a tool list (`compile.ts`) and run by one runtime (`run.ts`) for every agent of every company.
 */

/** Model tiers by difficulty (owner's rule: Haiku simple, Sonnet normal, Opus hard). */
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** What a call is for: the policy picks a tier per task. */
export const TASK_KINDS = ['dialog', 'extract', 'faq', 'consult', 'write', 'judge'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** A question and its answer (niche FAQ, objections). */
export interface QA {
  q: string;
  a: string;
}

/** The job: what the agent is for, what it does, where it stops, how it is measured, which tools it gets by default. */
export interface RolePack {
  id: string;
  title: string;
  /** One or two sentences: the goal of the role. */
  goal: string;
  duties: string[];
  boundaries: string[];
  /** When the conversation goes to a person. */
  handoff: string[];
  metrics: string[];
  style: string[];
  /** Default tools (names of the tool registry). */
  tools: string[];
  /** Default tier of the dialogue. */
  tier: ModelTier;
  /** Selling roles (`lead-manager`): who buys and what hurts them, the offer, objections with answers, how a good manager sells. Empty elsewhere. */
  segments: string[];
  offer: string[];
  objections: QA[];
  selling: string[];
}

/** The field: words, services, typical questions, objections, limits of the field (medicine, law, money), tone. */
export interface NichePack {
  id: string;
  title: string;
  /** Business kinds of the builder (`k.` chunk) this niche covers, e.g. `salon, barber, nails` (front matter `kinds`). */
  kinds: string[];
  terms: string[];
  services: string[];
  faq: QA[];
  objections: QA[];
  boundaries: string[];
  tone: string[];
}

/** How the company speaks to its people. */
export interface CompanyStyle {
  /** «вы» or «ты». */
  address: 'vy' | 'ty';
  /** Upper bound of sentences in one reply. */
  maxSentences: number;
  emoji: boolean;
  /** Languages it answers in; the first is the default. */
  languages: string[];
  /** Extra lines of the company's voice. */
  voice: string[];
  /** Topics the agent never discusses for this company. */
  forbiddenTopics: string[];
}

/** What the company lets its agents do. */
export interface CompanyRights {
  /** Tools added on top of the role's defaults. */
  allow: string[];
  /** Tools removed from them (wins over allow). */
  deny: string[];
  /** Kinds of action that always need a person's approval (money, contracts, prices). */
  locked: string[];
}

/** How long texts live (owner 2026-11-22: live 90 days at the company that owns the agent, anonymous without contact 24 hours). */
export interface RetentionPolicy {
  liveDays: number;
  anonHours: number;
}

/** The company: tenant 0 is Fir Tech itself. Knowledge, lessons and memory are not here: they live behind their adapters, keyed by `id`. */
export interface CompanyPack {
  id: string;
  name: string;
  about: string;
  facts: string[];
  style: CompanyStyle;
  rights: CompanyRights;
  retention: RetentionPolicy;
}

/** Which model answers what, and what the company may spend. */
export interface ModelPolicy {
  /** Tier of the dialogue unless a task says otherwise. */
  default: ModelTier;
  byTask: Partial<Record<TaskKind, ModelTier>>;
  maxTokens: number;
  /** Monthly budget of the company for this agent, USD (absent: no cap). */
  monthlyBudgetUsd?: number;
  /** Model calls one conversation may make in one turn (tool rounds). */
  maxRounds: number;
}

/** Guards every reply passes before a person reads it (`guards.ts`). */
export interface GuardPolicy {
  /** Sentences with money not on the price list are dropped. */
  prices: boolean;
  /** Sentences that promise a date or a duration are dropped. */
  dates: boolean;
  /** Stock phrases are flagged (`text.detect`); the app may rewrite once. */
  stock: boolean;
  /** Upper bound of characters of a reply. */
  maxChars: number;
  /** The honest line that replaces a dropped sentence. */
  note: string;
}

export interface AgentSpec {
  /** `<company>/<role>` by convention, e.g. `firtech/lead-manager`. */
  id: string;
  /** Bumped on every change of the spec; journaled with each turn, so an eval can be tied to a version. */
  version: number;
  role: RolePack;
  niche: NichePack;
  company: CompanyPack;
  model: ModelPolicy;
  guards: GuardPolicy;
  /** Eval sets (file names under `evals/`) the spec must pass before it goes live. */
  evals: string[];
}

export const DEFAULT_RETENTION: RetentionPolicy = { liveDays: 90, anonHours: 24 };

export const DEFAULT_GUARDS: GuardPolicy = {
  prices: true,
  dates: true,
  stock: true,
  maxChars: 600,
  note: 'Точную цену и срок команда назовёт в смете.',
};

export function defaultModelPolicy(role: RolePack): ModelPolicy {
  return { default: role.tier, byTask: { extract: 'haiku', faq: 'haiku', judge: 'haiku', consult: 'opus', write: 'sonnet' }, maxTokens: 600, maxRounds: 4 };
}

/** A spec from its three packs with the defaults filled in. */
export function makeSpec(o: { role: RolePack; niche: NichePack; company: CompanyPack; version?: number; model?: Partial<ModelPolicy>; guards?: Partial<GuardPolicy>; evals?: string[] }): AgentSpec {
  return {
    id: `${o.company.id}/${o.role.id}`,
    version: o.version ?? 1,
    role: o.role,
    niche: o.niche,
    company: o.company,
    model: { ...defaultModelPolicy(o.role), ...o.model },
    guards: { ...DEFAULT_GUARDS, ...o.guards },
    evals: o.evals ?? [],
  };
}
