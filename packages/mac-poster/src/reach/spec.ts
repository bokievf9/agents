/**
 * What the Mac runs for HQ jobs: the channels and actions of Agent Reach (`agent-reach <channel> <action> ...`), their parameters in CLI order, and the check of
 * every value. HQ validates the same on its side (`packages/core/src/tools/reach-spec.ts`); the Mac does not trust it: a job is only turned into an argument list
 * through this table (no shell, no value that starts with `-`, no control characters), so nothing a job says can become another command.
 */
export type Param = 'query' | 'target' | 'username' | 'name' | 'lang' | 'location' | 'limit';

export const ACTIONS: Record<string, Record<string, { pos: Param[]; flags: Param[] }>> = {
  youtube: { read: { pos: ['target'], flags: [] }, search: { pos: ['query'], flags: ['limit'] }, subtitle: { pos: ['target'], flags: ['lang'] }, transcribe: { pos: ['target'], flags: [] } },
  web: { search: { pos: ['query'], flags: ['limit'] }, read: { pos: ['target'], flags: [] } },
  instagram: { search: { pos: ['query'], flags: ['limit'] }, profile: { pos: ['username'], flags: [] }, posts: { pos: ['username'], flags: ['limit'] } },
  twitter: { search: { pos: ['query'], flags: ['limit'] }, profile: { pos: ['username'], flags: [] }, tweets: { pos: ['username'], flags: ['limit'] }, thread: { pos: ['target'], flags: [] } },
  reddit: { search: { pos: ['query'], flags: ['limit'] }, read: { pos: ['target'], flags: [] }, subreddit: { pos: ['name'], flags: ['limit'] } },
  linkedin: { jobs: { pos: ['query'], flags: ['location', 'limit'] }, read: { pos: ['target'], flags: [] } },
  github: { search: { pos: ['query'], flags: ['limit'] }, read: { pos: ['target'], flags: [] } },
};

const noCtl = (s: string) => [...s].every((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127);

function clean(kind: Param, v: unknown): string | undefined {
  if (kind === 'limit') return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 25 ? String(v) : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.startsWith('-') || !noCtl(s)) return undefined;
  switch (kind) {
    case 'query':
      return s.length <= 200 ? s : undefined;
    case 'target':
      return s.length <= 500 && !/\s/.test(s) ? s : undefined;
    case 'username':
      return /^[A-Za-z0-9._]{1,60}$/.test(s.replace(/^@/, '')) ? s.replace(/^@/, '') : undefined;
    case 'name':
      return /^[A-Za-z0-9_]{2,40}$/.test(s) ? s : undefined;
    case 'lang':
      return /^[A-Za-z0-9_-]{2,12}(,[A-Za-z0-9_-]{2,12}){0,5}$/.test(s) ? s : undefined;
    case 'location':
      return s.length <= 100 ? s : undefined;
  }
}

/** The CLI arguments of a job: `[channel, action, <positional...>, --flag value...]`, or the reason it is refused. */
export function buildArgv(channel: string, action: string, args: unknown): { ok: true; argv: string[] } | { ok: false; reason: string } {
  if (!Object.hasOwn(ACTIONS, channel) || !Object.hasOwn(ACTIONS[channel]!, action)) return { ok: false, reason: `unknown job ${channel}.${action}` };
  const spec = ACTIONS[channel]![action]!;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: 'args are not an object' };
  const a = args as Record<string, unknown>;
  const allowed = new Set<string>([...spec.pos, ...spec.flags]);
  for (const k of Object.keys(a)) if (!allowed.has(k)) return { ok: false, reason: `unexpected argument ${k}` };
  const argv = [channel, action];
  for (const k of spec.pos) {
    const v = clean(k, a[k]);
    if (v === undefined) return { ok: false, reason: `argument ${k} is missing or not valid` };
    argv.push(v);
  }
  for (const k of spec.flags) {
    if (a[k] === undefined) continue;
    const v = clean(k, a[k]);
    if (v === undefined) return { ok: false, reason: `argument ${k} is not valid` };
    argv.push(`--${k}`, v);
  }
  return { ok: true, argv };
}

/** What the CLI printed, reduced to the four fields HQ stores. The text is data: nothing in it is ever executed or followed. */
export interface CliResult {
  ok: boolean;
  items: Record<string, unknown>[];
  meta: Record<string, unknown>;
  error?: { code?: string; message?: string; hint?: string };
}

const str = (v: unknown, n: number): string | undefined => (typeof v === 'string' ? v.slice(0, n) : undefined);

export function parseCliOutput(stdout: string): CliResult | null {
  let j: unknown;
  try {
    j = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (typeof o.ok !== 'boolean') return null;
  const items = Array.isArray(o.items) ? o.items.filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && !Array.isArray(i)).slice(0, 200) : [];
  const meta = o.meta && typeof o.meta === 'object' && !Array.isArray(o.meta) ? { ...(o.meta as Record<string, unknown>) } : {};
  delete meta.update; // the owner's «a new version exists» note is for him, not for the agents
  const e = o.error && typeof o.error === 'object' && !Array.isArray(o.error) ? (o.error as Record<string, unknown>) : null;
  const error = e ? { ...(str(e.code, 60) ? { code: str(e.code, 60)! } : {}), ...(str(e.message, 500) ? { message: str(e.message, 500)! } : {}), ...(str(e.hint, 500) ? { hint: str(e.hint, 500)! } : {}) } : undefined;
  return { ok: o.ok, items, meta, ...(error && Object.keys(error).length ? { error } : {}) };
}

/** HQ takes a body up to ~400 KB: long texts are halved, then items dropped, until the JSON fits (HQ caps what it stores at 200 KB on its own). */
export function fitBody(r: CliResult, max = 380_000): CliResult {
  const size = (x: CliResult) => Buffer.byteLength(JSON.stringify(x));
  if (size(r) <= max) return r;
  const out: CliResult = { ...r, items: r.items.map((i) => ({ ...i })), meta: { ...r.meta, truncated: true } };
  for (let n = 0; n < 24 && size(out) > max; n++) {
    for (const i of out.items) for (const k of ['text', 'raw']) if (typeof i[k] === 'string' && (i[k] as string).length > 400) i[k] = (i[k] as string).slice(0, Math.floor((i[k] as string).length / 2));
    if (n > 8) while (out.items.length > 1 && size(out) > max) out.items.pop();
  }
  if (size(out) > max) out.items = [];
  return out;
}
