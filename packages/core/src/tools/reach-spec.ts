import type { Dept } from './result.js';

/**
 * What the agents may ask the owner's Mac to read through Agent Reach (`~/Agent-Reach`, MIT): channel, action, the CLI's parameter order and the
 * departments allowed. The CLI itself is the Mac helper's business (`packages/mac-poster`, `reach:run`); this table only fixes the vocabulary.
 * Read-only: Agent Reach has no write actions and none is listed here.
 */
export type ReachParam = 'query' | 'target' | 'username' | 'name' | 'lang' | 'location' | 'limit';

export interface ReachActionSpec {
  /** Positional CLI parameters, in order. */
  pos: readonly ReachParam[];
  /** `--flag value` parameters (all optional). */
  flags: readonly ReachParam[];
  summary: string;
}

export const REACH_ACTIONS = {
  youtube: {
    read: { pos: ['target'], flags: [], summary: 'title, channel, date and description of a video (yt-dlp)' },
    search: { pos: ['query'], flags: ['limit'], summary: 'search YouTube videos' },
    subtitle: { pos: ['target'], flags: ['lang'], summary: 'full subtitle text of a video (manual or auto captions)' },
    transcribe: { pos: ['target'], flags: [], summary: 'speech-to-text of a video audio (needs a Groq key on the Mac)' },
  },
  web: {
    search: { pos: ['query'], flags: ['limit'], summary: 'web search (public routes)' },
    read: { pos: ['target'], flags: [], summary: 'read a page as text' },
  },
  instagram: {
    search: { pos: ['query'], flags: ['limit'], summary: 'search Instagram (needs the Mac login)' },
    profile: { pos: ['username'], flags: [], summary: 'a public profile (needs the Mac login)' },
    posts: { pos: ['username'], flags: ['limit'], summary: 'recent posts of a profile (needs the Mac login)' },
  },
  twitter: {
    search: { pos: ['query'], flags: ['limit'], summary: 'search tweets (needs the Mac login)' },
    profile: { pos: ['username'], flags: [], summary: 'a profile on X (needs the Mac login)' },
    tweets: { pos: ['username'], flags: ['limit'], summary: 'recent tweets of a user (needs the Mac login)' },
    thread: { pos: ['target'], flags: [], summary: 'a tweet with its replies (needs the Mac login)' },
  },
  reddit: {
    search: { pos: ['query'], flags: ['limit'], summary: 'search Reddit posts' },
    read: { pos: ['target'], flags: [], summary: 'a post and its comments' },
    subreddit: { pos: ['name'], flags: ['limit'], summary: 'latest posts of a subreddit' },
  },
  linkedin: {
    jobs: { pos: ['query'], flags: ['location', 'limit'], summary: 'LinkedIn job search (needs the Mac login)' },
    read: { pos: ['target'], flags: [], summary: 'a LinkedIn job or page (needs the Mac login)' },
  },
  github: {
    search: { pos: ['query'], flags: ['limit'], summary: 'search GitHub repositories' },
    read: { pos: ['target'], flags: [], summary: 'a repository with README, an issue or a PR' },
  },
} as const satisfies Record<string, Record<string, ReachActionSpec>>;

export type ReachChannel = keyof typeof REACH_ACTIONS;

/** Marketing (and its Analyst): YouTube, web, Instagram, X, Reddit. Sales (the Scout): LinkedIn, Reddit, web, GitHub. Support: none. */
export const REACH_DEPTS: Record<ReachChannel, readonly Dept[]> = {
  youtube: ['marketing'],
  web: ['marketing', 'sales'],
  instagram: ['marketing'],
  twitter: ['marketing'],
  reddit: ['marketing', 'sales'],
  linkedin: ['sales'],
  github: ['sales'],
};

export const REACH_CHANNELS = Object.keys(REACH_ACTIONS) as ReachChannel[];

export function reachSpec(channel: string, action: string): ReachActionSpec | undefined {
  if (!Object.hasOwn(REACH_ACTIONS, channel)) return undefined;
  const ch = REACH_ACTIONS[channel as ReachChannel] as Record<string, ReachActionSpec>;
  return Object.hasOwn(ch, action) ? ch[action] : undefined;
}

const noCtl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

/**
 * One parameter, checked and normalised; a string never starts with `-` (the CLI would read it as an option) and has no control
 * characters. `undefined`: invalid.
 */
export function cleanParam(kind: ReachParam, v: unknown): string | number | undefined {
  if (kind === 'limit') return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 25 ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.startsWith('-') || !noCtl(s)) return undefined;
  switch (kind) {
    case 'query':
      return s.length <= 200 ? s : undefined;
    case 'target':
      return s.length <= 500 && !/\s/.test(s) ? s : undefined;
    case 'username': {
      const u = s.replace(/^@/, '');
      return /^[A-Za-z0-9._]{1,60}$/.test(u) ? u : undefined;
    }
    case 'name':
      return /^[A-Za-z0-9_]{2,40}$/.test(s) ? s : undefined;
    case 'lang':
      return /^[A-Za-z0-9_-]{2,12}(,[A-Za-z0-9_-]{2,12}){0,5}$/.test(s) ? s : undefined;
    case 'location':
      return s.length <= 100 ? s : undefined;
  }
}

/** Validates the arguments of one call: positional ones required, flags optional, nothing else allowed. Returns the canonical object or the reason. */
export function cleanArgs(spec: ReachActionSpec, args: unknown): { ok: true; args: Record<string, string | number> } | { ok: false; reason: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: 'args: an object' };
  const a = args as Record<string, unknown>;
  const allowed = new Set<string>([...spec.pos, ...spec.flags]);
  for (const k of Object.keys(a)) if (!allowed.has(k) && a[k] !== undefined) return { ok: false, reason: `args.${k}: not a parameter of this action` };
  const out: Record<string, string | number> = {};
  for (const k of spec.pos) {
    const v = cleanParam(k, a[k]);
    if (v === undefined) return { ok: false, reason: `args.${k}: required, valid ${k}` };
    out[k] = v;
  }
  for (const k of spec.flags) {
    if (a[k] === undefined) continue;
    const v = cleanParam(k, a[k]);
    if (v === undefined) return { ok: false, reason: `args.${k}: not valid` };
    out[k] = v;
  }
  return { ok: true, args: out };
}
