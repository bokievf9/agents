import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface KbEntry {
  id: string;
  title: string;
  keywords: string[];
  answer: string;
}

/** Default folder: `kb/` next to `src/` (and next to `dist/` in the built image). */
export const DEFAULT_KB_DIR = new URL('../kb', import.meta.url).pathname;

/**
 * Entry format: `# Title`, a line `ключи: a, b, c`, an empty line, then the answer text. One file per answer;
 * the owner edits the files, no code. A file without a title or keywords is skipped.
 */
export function parseKbEntry(id: string, raw: string): KbEntry | null {
  const lines = raw.replace(/\r/g, '').split('\n');
  const title = /^#\s+(.+)$/.exec(lines[0] ?? '')?.[1]?.trim();
  const kw = /^(?:ключи|keywords):\s*(.+)$/i.exec(lines[1] ?? '')?.[1];
  if (!title || !kw) return null;
  const answer = lines.slice(2).join('\n').trim();
  if (!answer) return null;
  return { id, title, keywords: kw.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean), answer };
}

export function loadKb(dir: string = DEFAULT_KB_DIR): KbEntry[] {
  const out: KbEntry[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const e = parseKbEntry(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8'));
    if (e) out.push(e);
  }
  return out;
}

/** Word stem: the first 5 letters survive Russian endings well enough ("оплатить", "оплата", "оплаты"). */
const stem = (w: string): string => w.slice(0, 5);
const words = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2);

/**
 * Best entry for a question: a keyword phrase scores by how many of its words (by stem) appear in the question,
 * a full phrase match scores higher. Needs at least one full phrase match or two matching stems; otherwise null.
 */
export function lookup(kb: KbEntry[], question: string): { entry: KbEntry; score: number } | null {
  const q = question.toLowerCase();
  const qStems = new Set(words(question).map(stem));
  let best: { entry: KbEntry; score: number } | null = null;
  for (const entry of kb) {
    let score = 0;
    let phrase = false;
    for (const k of entry.keywords) {
      if (q.includes(k)) {
        score += 3;
        phrase = true;
        continue;
      }
      const ks = words(k).map(stem);
      if (ks.length > 0 && ks.every((s) => qStems.has(s))) score += 2;
      else score += ks.filter((s) => qStems.has(s)).length * 0.5;
    }
    if ((phrase || score >= 2) && (!best || score > best.score)) best = { entry, score };
  }
  return best;
}

/** Refunds, discounts, disputed or double charges: the owner answers these himself (level 0, locked). */
export const isMoneyTopic = (text: string): boolean =>
  /возврат|верните|вернит[еь]|вернуть\s+деньги|деньги\s+назад|refund|компенсац|скидк|списали|двойн\w*\s+(списан|оплат)|переплат|претензи|chargeback|неправильн\w+\s+счёт|не\s+та\s+сумм/i.test(text);
