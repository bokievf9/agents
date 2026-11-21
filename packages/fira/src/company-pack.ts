import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { chunkText } from './knowledge.js';
import { PACKAGE_DIR } from './packs.js';
import { KNOWLEDGE_TIERS, type KnowledgeChunk, type KnowledgeTier } from './stores.js';

/**
 * The knowledge pack of a company (owner 2026-11-23: «Fira должна получить все знания по всей компании Fir Tech и жёсткие правила о неразглашении»).
 * `scripts/build-company-pack.ts` reads the sources (the site's public content and documents, the company's internal documents) and writes
 * `company-packs/<id>/*.md` with an `index.json`; HQ loads them into its knowledge store at start and every night (`loadCompanyKnowledge`).
 * Live facts (prices, call windows, statuses) are never in the pack: the agent's tools read them at the time of the answer.
 *
 * Every document has a tier. `public` (the site and its documents) any audience reads, `internal` (how the company works) only the owner, `secret`
 * never becomes knowledge: the builder refuses secret files (`.env*`, `server-env`, `data/`, keys) and cuts every line that carries a token, a key,
 * an IP address or a password, whatever the tier of the document.
 */

export interface PackDoc {
  /** `public-terms`, `internal-company`... (file name without `.md`). */
  id: string;
  title: string;
  tier: Exclude<KnowledgeTier, 'secret'>;
  /** Where it came from (a path relative to the workspace), for the owner; never an instruction. */
  source: string;
  text: string;
}

export const PackIndexSchema = z.object({
  company: z.string().regex(/^[a-z0-9-]+$/),
  docs: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    tier: z.enum(['public', 'internal']),
    source: z.string(),
    file: z.string().regex(/^[a-z0-9-]+\.md$/),
    chars: z.number().int().nonnegative(),
    sha: z.string().regex(/^[0-9a-f]{12}$/),
  })),
});
export type PackIndex = z.output<typeof PackIndexSchema>;

/** Files that are secret by their path: never read into a pack. */
export function isSecretPath(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase();
  return /(^|\/)\.env(\.|$|\/)|(^|\/)\.env[^/]*$/.test(p) || /server-env/.test(p) || /(^|\/)data\//.test(p) || /(^|\/)secrets?(\/|\.|$)/.test(p)
    || /\.(pem|key|p12|pfx|sqlite|db)$/.test(p) || /id_(rsa|ed25519|ecdsa)/.test(p) || /(^|\/)\.ssh\//.test(p);
}

/**
 * A line that carries a secret: an API key or token (`sk-…`, `re_…`, `sb_…`, `age1…`, `ghp_…`, `xox…`, a Telegram bot token, a JWT), a password
 * or a secret assignment, an IP address (`127.0.0.1` too), a private key block.
 */
const SECRET_LINE = [
  /\bsk-[A-Za-z0-9_-]{8,}/, /\bre_[A-Za-z0-9]{8,}/, /\bsb_[A-Za-z0-9_]{8,}/, /\bage1[0-9a-z]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/, /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\./, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/, /(?<![\p{L}])(password|passwd|пароль)\s*[:=]/iu, /\b[A-Z][A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)\s*=\s*\S+/,
];

export const hasSecret = (line: string): boolean => SECRET_LINE.some((re) => re.test(line));

/** The text without its secret lines; `cut` is how many lines went. */
export function redactSecrets(text: string): { text: string; cut: number } {
  let cut = 0;
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => {
    if (!hasSecret(l)) return true;
    cut++;
    return false;
  });
  return { text: lines.join('\n'), cut };
}

/** All human sentences of a content object of the site (strings of at least `min` characters, in order, without repeats). */
export function flattenContent(value: unknown, min = 25): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof v === 'string') {
      const s = v.replace(/\s+/g, ' ').trim();
      // UI ids, paths, class names and templates are not knowledge
      if (s.length >= min && /\p{L}{3}/u.test(s) && !/^[\w./#:-]+$/.test(s) && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(value, 0);
  return out;
}

const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** A document as the Markdown file of the pack (front matter, then the text). */
export function docFile(d: PackDoc): string {
  return `---\nid: ${d.id}\ntitle: ${d.title}\ntier: ${d.tier}\nsource: ${d.source}\n---\n${d.text.trim()}\n`;
}

/** The pack's index (stable order: by tier, then id). */
export function packIndex(company: string, docs: PackDoc[]): PackIndex {
  const sorted = [...docs].sort((a, b) => KNOWLEDGE_TIERS.indexOf(a.tier) - KNOWLEDGE_TIERS.indexOf(b.tier) || a.id.localeCompare(b.id));
  return { company, docs: sorted.map((d) => ({ id: d.id, title: d.title, tier: d.tier, source: d.source, file: `${d.id}.md`, chars: d.text.length, sha: sha12(d.text) })) };
}

/** A document checked before it goes into a pack: its secret lines cut (a document that is secret as a whole never gets here). */
export function cleanDoc(d: PackDoc): { doc: PackDoc; cut: number } {
  const r = redactSecrets(d.text);
  return { doc: { ...d, text: r.text }, cut: r.cut };
}

const bodyOf = (md: string): string => md.replace(/^---\n[\s\S]*?\n---\n?/, '');

/**
 * The knowledge chunks of a company's pack on disk (`company-packs/<id>/index.json` and its files), each with the tier of its document. Lines with
 * secrets are cut again on the way in (defence in depth: a hand-edited pack file cannot smuggle a key into the store). No pack: no chunks.
 */
export function loadCompanyKnowledge(company: string, o: { dir?: string; now?: number } = {}): KnowledgeChunk[] {
  const dir = o.dir ?? join(PACKAGE_DIR, 'company-packs', company);
  const indexPath = join(dir, 'index.json');
  if (!existsSync(indexPath)) return [];
  const index = PackIndexSchema.parse(JSON.parse(readFileSync(indexPath, 'utf8')) as unknown);
  const out: KnowledgeChunk[] = [];
  for (const d of index.docs) {
    const path = join(dir, d.file);
    if (!existsSync(path)) continue;
    const text = redactSecrets(bodyOf(readFileSync(path, 'utf8'))).text;
    chunkText(text).forEach((c, i) => out.push({ id: `${d.id}#${i}`, companyId: index.company, source: 'document', title: d.title, text: c, ref: d.source, tier: d.tier, updatedAt: o.now ?? 0 }));
  }
  return out;
}
