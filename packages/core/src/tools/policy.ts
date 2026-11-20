import { DEPARTMENTS, type Dept } from './result.js';

/** Limits a tool runs with (shown in `/admin/company`). Absent fields: not applicable. */
export interface ToolLimits {
  timeoutMs?: number;
  maxBytes?: number;
  /** Parallel calls per host, and the minimum pause between two calls to one host. */
  perHost?: number;
  minGapMs?: number;
  /** Extra attempts after a retryable failure. */
  retries?: number;
  cacheTtlMs?: number;
  /** Calls a day for the whole company (counted in settings). */
  perDay?: number;
  /** Calls in any 60 seconds for the whole company (counted in settings). */
  perMinute?: number;
  /** Results per call. */
  maxResults?: number;
}

export interface ToolPolicy {
  name: string;
  departments: readonly Dept[];
  limits: ToolLimits;
  /** Env keys the tool reads (any of them makes it configured unless `configured` in the registry says otherwise). */
  env: readonly string[];
  /** No `activity` line for successful calls (cheap local reads); counters still kept. */
  quiet?: boolean;
  /** Departments that may pass `internal: true` (http hosts of our own network, no public-address check). Absent: nobody. */
  internal?: readonly Dept[];
  summary: string;
}

const ALL = DEPARTMENTS;
const TEXT_DEPTS: readonly Dept[] = ['marketing', 'sales', 'support'];
const NET = { timeoutMs: 8000, maxBytes: 1_000_000, perHost: 2, minGapMs: 250, retries: 2 } as const;

/**
 * Who may call what. The single place of tool rights: the registry refuses a call outside this table with `not_allowed`, the
 * `/admin/company` listing is built from it, and a test checks that every tool of the registry is here and in `docs/tools.md`.
 */
export const TOOL_POLICY: readonly ToolPolicy[] = [
  { name: 'web.getJson', departments: ALL, limits: NET, env: [], internal: ['support'], summary: 'GET JSON from listed https hosts' },
  { name: 'web.getText', departments: ['marketing', 'sales', 'support', 'director'], limits: { ...NET, maxBytes: 300_000 }, env: [], internal: ['support'], summary: 'GET HTML or text, cut at 300 KB' },
  { name: 'web.readable', departments: ['marketing', 'sales', 'director'], limits: { ...NET, maxBytes: 300_000 }, env: [], summary: 'article text of a page' },
  { name: 'web.search', departments: ['marketing', 'sales', 'director'], limits: { timeoutMs: 8000, minGapMs: 1000, perHost: 1, retries: 1, cacheTtlMs: 3_600_000, maxResults: 10 }, env: ['BRAVE_SEARCH_KEY'], summary: 'web search: Brave API, else DuckDuckGo HTML' },
  { name: 'web.post', departments: ALL, limits: { timeoutMs: 60_000, maxBytes: 1_000_000, perHost: 2, minGapMs: 250, retries: 0 }, env: [], summary: 'POST to listed https hosts (no retries)' },
  { name: 'cache.get', departments: ALL, limits: {}, env: [], quiet: true, summary: 'read the tool cache' },
  { name: 'cache.set', departments: ALL, limits: { maxBytes: 65_536 }, env: [], quiet: true, summary: 'write the tool cache (64 KB a value)' },
  { name: 'cache.del', departments: ALL, limits: {}, env: [], quiet: true, summary: 'delete from the tool cache' },
  { name: 'files.put', departments: ['marketing', 'sales', 'backoffice'], limits: { maxBytes: 50 * 1024 * 1024 }, env: ['DATA_DIR'], summary: 'save a file under DATA_DIR/renders' },
  { name: 'files.get', departments: ['marketing', 'sales', 'backoffice'], limits: { maxBytes: 50 * 1024 * 1024 }, env: ['DATA_DIR'], quiet: true, summary: 'read a saved file' },
  { name: 'files.list', departments: ['marketing', 'sales', 'backoffice'], limits: {}, env: ['DATA_DIR'], quiet: true, summary: 'list a folder of saved files' },
  { name: 'files.url', departments: ['marketing', 'backoffice'], limits: {}, env: ['MEDIA_SECRET', 'IG_PUBLIC_BASE'], quiet: true, summary: 'signed public /media/ URL of a file' },
  { name: 'media.png', departments: ['marketing'], limits: {}, env: [], summary: 'PNG from a frame (content-maker renderer)' },
  { name: 'media.qr', departments: ['sales', 'support', 'backoffice'], limits: { maxBytes: 1000 }, env: [], summary: 'QR code as SVG' },
  { name: 'media.pdf', departments: ['sales', 'backoffice'], limits: { maxBytes: 5 * 1024 * 1024 }, env: [], summary: 'A4 PDF of a structured document' },
  { name: 'llm.json', departments: ALL, limits: {}, env: ['LLM_API_KEY', 'ANTHROPIC_API_KEY'], summary: 'structured answer (tryJson), metered' },
  { name: 'llm.text', departments: ALL, limits: {}, env: ['LLM_API_KEY', 'ANTHROPIC_API_KEY'], summary: 'text answer (tryComplete), metered' },
  { name: 'prices.get', departments: ALL, limits: {}, env: [], quiet: true, summary: 'the site price list' },
  { name: 'playbook.excerpt', departments: ALL, limits: { maxBytes: 2500 }, env: [], quiet: true, summary: 'playbook excerpt for a prompt' },
  { name: 'knowledge.search', departments: ALL, limits: { maxResults: 20 }, env: ['KNOWLEDGE_DIR'], quiet: true, summary: 'search knowledge/*.md and lessons' },
  { name: 'knowledge.add', departments: ALL, limits: { maxBytes: 2000 }, env: [], summary: 'add a lesson (exported weekly)' },
  { name: 'crm.leads', departments: ['sales', 'marketing', 'backoffice', 'director'], limits: { maxResults: 100 }, env: [], quiet: true, summary: 'leads (marketing: without contacts)' },
  { name: 'crm.clients', departments: ['sales', 'support', 'backoffice', 'marketing', 'director'], limits: { maxResults: 100 }, env: [], quiet: true, summary: 'clients (marketing: without contacts)' },
  { name: 'crm.projects', departments: ['production', 'sales', 'support', 'backoffice', 'director'], limits: { maxResults: 100 }, env: [], quiet: true, summary: 'projects' },
  { name: 'crm.invoices', departments: ['support', 'backoffice', 'sales', 'director'], limits: { maxResults: 100 }, env: [], quiet: true, summary: 'invoices' },
  { name: 'crm.tickets', departments: ['support', 'production', 'director'], limits: { maxResults: 100 }, env: [], quiet: true, summary: 'support tickets' },
  { name: 'events.week', departments: ['marketing', 'director'], limits: {}, env: [], quiet: true, summary: 'site events of the last 7 days' },
  { name: 'chain.transfers', departments: ['support', 'backoffice'], limits: { ...NET, retries: 1 }, env: ['TRONGRID_API_KEY', 'TONCENTER_API_KEY'], summary: 'incoming USDT (TronGrid, toncenter)' },
  { name: 'google.youtube.channel', departments: ['marketing', 'director'], limits: { ...NET, timeoutMs: 10_000 }, env: ['YT_OAUTH_CLIENT_JSON', 'YT_REFRESH_TOKEN', 'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID'], summary: 'own channel statistics' },
  { name: 'google.youtube.videos', departments: ['marketing', 'director'], limits: { ...NET, timeoutMs: 10_000, maxResults: 50 }, env: ['YT_OAUTH_CLIENT_JSON', 'YT_REFRESH_TOKEN', 'YOUTUBE_API_KEY'], summary: 'video statistics by id' },
  { name: 'google.youtube.upload', departments: ['marketing'], limits: { timeoutMs: 60_000, maxBytes: 256 * 1024 * 1024, perDay: 5, retries: 0 }, env: ['YT_OAUTH_CLIENT_JSON', 'YT_REFRESH_TOKEN'], summary: 'upload a video (1600 of 10 000 daily units)' },
  { name: 'google.trends', departments: ['marketing', 'director'], limits: { ...NET, cacheTtlMs: 3_600_000, maxResults: 25 }, env: [], summary: 'Google Trends daily RSS of a region' },
  { name: 'google.searchConsole', departments: ['marketing', 'director'], limits: { ...NET, timeoutMs: 10_000, cacheTtlMs: 6 * 3_600_000 }, env: ['GSC_SERVICE_ACCOUNT_JSON', 'GSC_SITE_URL'], summary: 'Search Console top queries and pages' },
  { name: 'telegram.send', departments: ALL, limits: { minGapMs: 1100, retries: 0 }, env: [], summary: 'message to the owner (OutboxMessenger)' },
  { name: 'telegram.sendDocument', departments: ALL, limits: { minGapMs: 1100, maxBytes: 50 * 1024 * 1024, retries: 0 }, env: [], summary: 'file to the owner' },
  { name: 'telegram.sendPhotos', departments: ['marketing', 'production', 'director'], limits: { minGapMs: 1100, retries: 0 }, env: [], summary: 'pictures to the owner' },
  { name: 'email.send', departments: ['support', 'sales', 'backoffice'], limits: { timeoutMs: 15_000, perDay: 100, retries: 0 }, env: ['RESEND_API_KEY', 'RESEND_FROM'], summary: 'email through Resend (only after an approval)' },
  { name: 'mac.poster.enqueue', departments: ['marketing'], limits: {}, env: [], summary: 'queue an item for the Mac poster' },
  { name: 'clock.now', departments: ALL, limits: {}, env: [], quiet: true, summary: 'company time' },
  { name: 'clock.zoned', departments: ALL, limits: {}, env: [], quiet: true, summary: 'wall clock in a zone' },
  { name: 'clock.week', departments: ALL, limits: {}, env: [], quiet: true, summary: 'ISO week of a day' },
  { name: 'text.hookScore', departments: TEXT_DEPTS, limits: { maxResults: 50 }, env: [], quiet: true, summary: 'rank reel hooks on five properties, RU and EN' },
  { name: 'text.beats', departments: TEXT_DEPTS, limits: { maxBytes: 20_000 }, env: [], quiet: true, summary: 'time a reel script into beats, flag hook, long beats, loop' },
  { name: 'text.captionLint', departments: TEXT_DEPTS, limits: { maxBytes: 20_000 }, env: [], quiet: true, summary: 'lint a caption: 125-character window, 2200, hashtags, one ask' },
  { name: 'text.humanize', departments: TEXT_DEPTS, limits: { maxBytes: 20_000 }, env: [], quiet: true, summary: 'strip invisible characters, dashes and AI stock words (RU and EN)' },
  { name: 'text.detect', departments: TEXT_DEPTS, limits: { maxBytes: 20_000 }, env: [], quiet: true, summary: 'five-check score of how machine-written a text looks' },
  { name: 'text.swipeRank', departments: TEXT_DEPTS, limits: { maxResults: 500 }, env: [], quiet: true, summary: 'rank reels by the outlier multiple, name the hook formula' },
  { name: 'media.openverse.search', departments: ['marketing', 'director'], limits: { ...NET, perDay: 150, perMinute: 15, retries: 0, maxResults: 20, cacheTtlMs: 6 * 3_600_000 }, env: ['OPENVERSE_CLIENT_ID', 'OPENVERSE_CLIENT_SECRET'], summary: 'search openly licensed images and audio (Openverse), 15 a minute and 150 a day' },
  { name: 'web.getBytes', departments: ['marketing', 'director'], limits: { ...NET, maxBytes: 3_000_000, retries: 1 }, env: [], summary: 'GET a picture (bytes, up to 3 MB) from listed https hosts' },
];

const BY_NAME = new Map(TOOL_POLICY.map((p) => [p.name, p]));

export const policyOf = (name: string): ToolPolicy | undefined => BY_NAME.get(name);

/** True when `dept` may call `name` (unknown tools and unknown departments: never). */
export function isAllowed(name: string, dept: string): boolean {
  return BY_NAME.get(name)?.departments.includes(dept as Dept) ?? false;
}

/** Tools a department may call. */
export const toolNamesFor = (dept: string): string[] => TOOL_POLICY.filter((p) => p.departments.includes(dept as Dept)).map((p) => p.name);
