import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productList, productName } from '@fir/core';
import { OFFERS as PRESALES_OFFERS } from '@fir/worker-presales';
import { OFFERS as PROSPECT_OFFERS } from '@fir/worker-prospector';
import { describe, expect, it } from 'vitest';
import { PRODUCT_IDS, PRODUCTS } from '../src/client/products.js';
import { receptionistPrompt, newQ } from '../src/client/receptionist.js';
import { FALLBACK_INSTRUCTIONS } from '../src/client/prompt.js';
import { COMMANDS, T } from '../src/client/texts.js';
import { W } from '../src/client/web-texts.js';
import { instructionsDir } from './helpers.js';

/**
 * Owner 2026-11-22: the word «бот» is banned in the names of our AI products. The names live in ONE map (`@fir/core` `product-names.ts`); every client-facing text takes
 * them from it. This test greps the code and the texts the agents say to people and forbids the old names; the internal role word «Приёмщик лидов» may stay (README, docs).
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCAN = ['apps/hq/src', 'apps/hq/instructions', 'knowledge', 'packages/workers/*/templates', 'packages/workers/*/prompts', 'packages/workers/*/src', 'packages/core/src', 'packages/renderer/src', 'packages/clips/src', 'packages/clips/samples'];
const FORBIDDEN: [string, RegExp][] = [
  ['бот-администратор', /бот[а-яё]*-администратор/iu],
  ['ИИ-приёмщик', /ии-приём?щик/iu],
  ['приёмщик заявок', /приём?щик[а-яё]*\s+заявок/iu],
  ['booking bot', /booking (assistant )?bot/i],
  ['AI request handler', /ai request handler/i],
];

function expand(pattern: string): string[] {
  const parts = pattern.split('/');
  let dirs = [ROOT];
  for (const part of parts) {
    const next: string[] = [];
    for (const d of dirs) {
      if (part === '*') {
        for (const e of readdirSync(d)) if (statSync(join(d, e)).isDirectory()) next.push(join(d, e));
      } else if (statSync(join(d, part), { throwIfNoEntry: false })?.isDirectory()) next.push(join(d, part));
    }
    dirs = next;
  }
  return dirs;
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    if (e === 'node_modules' || e === 'dist') return [];
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|md|json|txt)$/.test(e) ? [p] : [];
  });
}

describe('product names: one map, no «бот» in the name of an AI product', () => {
  it('the code, the instructions, the knowledge and the templates never name a product the old way', () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const pattern of SCAN) {
      for (const dir of expand(pattern)) {
        for (const f of files(dir)) {
          scanned++;
          const text = readFileSync(f, 'utf8');
          for (const [name, re] of FORBIDDEN) if (re.test(text)) hits.push(`${relative(ROOT, f)}: «${name}»`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(150);
    expect(hits).toEqual([]);
  });

  it('the scan really sees the dirs it is told about (a template, an instruction, a playbook)', () => {
    const seen = SCAN.flatMap((p) => expand(p)).map((d) => relative(ROOT, d));
    expect(seen).toEqual(expect.arrayContaining(['apps/hq/src', 'apps/hq/instructions', 'knowledge', 'packages/workers/presales/templates', 'packages/workers/documents/templates']));
  });

  it('the catalogue of the chat and the bot takes its names from the map, RU and EN', () => {
    const ids: Record<string, string> = { admin: 'adminbot', receptionist: 'intake', automation: 'automation', content: 'content', miniapp: 'miniapp', agent: 'agent', ai: 'aiteam' };
    for (const id of PRODUCT_IDS) {
      expect(PRODUCTS[id].name.ru, id).toBe(productName(ids[id]!, 'ru'));
      expect(PRODUCTS[id].name.en, id).toBe(productName(ids[id]!, 'en'));
      expect(PRODUCTS[id].name.ru, id).not.toMatch(/бот/i);
    }
    expect(PRODUCTS.admin.name.ru).toBe('ИИ-администратор');
    expect(PRODUCTS.receptionist.name.en).toBe('AI lead manager');
  });

  it('the fixed texts, the welcome, the help, the commands and the fallback prompt say the new names', () => {
    for (const lang of ['ru', 'en'] as const) {
      expect(W[lang].welcome).toContain(productList(lang));
      expect(W[lang].demo).toContain(productName('adminbot', lang));
      expect(T[lang].welcome('Анна')).toContain(productList(lang));
      expect(T[lang].help).toContain(productName('adminbot', lang));
      expect(COMMANDS[lang].find((c) => c.command === 'demo')!.description).toContain(productName('adminbot', lang));
    }
    expect(FALLBACK_INSTRUCTIONS).toContain(productList('ru'));
    expect(FALLBACK_INSTRUCTIONS).not.toMatch(/Telegram-бот-/);
  });

  it('the receptionist introduces itself as «ИИ-менеджер заявок Fir Tech»: in the welcome and in its prompt', () => {
    expect(W.ru.welcome).toMatch(/Я ИИ-менеджер заявок Fir Tech/);
    expect(W.en.welcome).toMatch(/I am the Fir Tech AI lead manager/);
    expect(T.ru.welcome('')).toMatch(/Я ИИ-менеджер заявок Fir Tech/);
    const system = receptionistPrompt(readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8'), 'ru', newQ(), 'ask');
    expect(system).toContain('«ИИ-менеджер заявок Fir Tech»');
    expect(system).toMatch(/слово «бот» в названии ИИ-продукта не используй/);
    expect(system).toContain(productName('adminbot', 'ru'));
    expect(system).toContain(productName('intake', 'ru'));
    expect(readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8')).toContain('«ИИ-менеджер заявок Fir Tech»');
  });

  it('the КП, the estimate and the contract name the product from the map (the presales and prospector offers)', () => {
    expect(PRESALES_OFFERS.admin.title).toBe(productName('adminbot', 'ru'));
    expect(PRESALES_OFFERS.receptionist.title).toBe(productName('intake', 'ru'));
    expect(PRESALES_OFFERS.automation.title).toBe('Автоматизация процессов');
    expect(PRESALES_OFFERS.implementation.title).toBe('ИИ-отдел под ключ');
    expect(PROSPECT_OFFERS.admin.title).toBe('ИИ-администратор');
    expect(PROSPECT_OFFERS.receptionist.title).toBe('ИИ-менеджер заявок');
  });
});
