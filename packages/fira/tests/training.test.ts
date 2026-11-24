import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyGuards, compile, firtechGuardContext, FIRTECH_TOOLS, hasDatePromise, InMemoryLessons, loadRolePack, PACKAGE_DIR, parseEvalSet, runEval, specOf, teamPackIds, teamSpec,
  TEAM_PACK_DIR, TRAINING_LESSONS, DEFAULT_GUARDS,
} from '../src/index.js';

/** The training of 2026-11-25: every role pack carries the dated section, its eval dialogs pass in script mode, the new facts reach the compiled prompt. */
const DIR = join(PACKAGE_DIR, 'evals', 'training');
const TOP = ['executive-assistant', 'lead-manager', 'marketing-head'];
const files = readdirSync(DIR).filter((f) => f.endsWith('.eval.json')).sort();
const load = (f: string) => parseEvalSet(JSON.parse(readFileSync(join(DIR, f), 'utf8')) as unknown);
const specFor = (s: ReturnType<typeof load>['spec']) => (s.team ? teamSpec(s.role) : specOf({ role: s.role, niche: s.niche, company: s.company }));

describe('training 2026-11-25', () => {
  it('every one of the 25 role packs has the dated section and an eval set of at least three dialogs', () => {
    const ids = [...TOP, ...teamPackIds()];
    expect(ids.length).toBe(25);
    for (const id of ids) {
      const pack = TOP.includes(id) ? loadRolePack(id) : loadRolePack(id, TEAM_PACK_DIR);
      expect(pack.updates.length, id).toBeGreaterThanOrEqual(4);
      const f = `${id}.eval.json`;
      expect(files, id).toContain(f);
      expect(load(f).cases.length, id).toBeGreaterThanOrEqual(3);
    }
    expect(files).toContain('company-firtech.eval.json');
  });

  it('the section reaches the compiled prompt of each agent, and the new truth is in it (no crypto, no founder as the answerer)', () => {
    for (const id of [...TOP, ...teamPackIds()]) {
      const spec = TOP.includes(id) ? specOf({ role: id, niche: 'it-services', company: 'firtech' }) : teamSpec(id);
      const text = compile(spec, FIRTECH_TOOLS).system[0]!.text;
      expect(text, id).toContain('## Что изменилось');
      expect(spec.role.updates.join(' '), id).toMatch(/\S/);
    }
    const lm = compile(specOf({ role: 'lead-manager', niche: 'it-services', company: 'firtech' }), FIRTECH_TOOLS).system[0]!.text;
    expect(lm).toMatch(/Криптовалюту[^.]*не принимаем/);
    expect(lm).toContain('через 3 рабочих дня после первого платежа');
    expect(lm).toContain('cabinet10');
    expect(lm).toMatch(/менеджер проекта/);
    expect(lm).not.toMatch(/USDT \(TRC20 или TON\) или|подтверждает основатель|пилота бесплатно/);
  });

  it('packs keep the voice: no long dashes, no «не X, а Y» turns, no «бот» in the new sections', () => {
    for (const id of [...TOP, ...teamPackIds()]) {
      const spec = TOP.includes(id) ? specOf({ role: id, niche: 'it-services', company: 'firtech' }) : teamSpec(id);
      const t = spec.role.updates.join('\n');
      expect(t, id).not.toMatch(/[—–]/);
      expect(t, id).not.toMatch(/(^|[^а-яё«])не [^.,;:!?«»]{1,40}, а [^.]/iu);
      expect(t, id).not.toMatch(/(^|[^а-яё«])бот/iu);
    }
  });

  for (const f of files) {
    it(`eval set ${f} passes in script mode (offline)`, async () => {
      const set = load(f);
      const report = await runEval(set, { spec: specFor(set.spec), tools: FIRTECH_TOOLS, guard: firtechGuardContext });
      expect(report.results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.failures.join('; ')}`)).toEqual([]);
    }, 60_000);
  }

  it('the published terms pass the date guard word for word, any other duration is still dropped', () => {
    expect(hasDatePromise('Старт через 3 рабочих дня после первого платежа.')).toBe(false);
    expect(hasDatePromise('Смету проверяем до 1 рабочего дня, обычно быстрее.')).toBe(false);
    expect(hasDatePromise('Купон действует 30 дней с создания аккаунта.')).toBe(false);
    expect(hasDatePromise('Start within 3 business days after the first payment.')).toBe(false);
    expect(hasDatePromise('Сделаем за 5 дней.')).toBe(true);
    expect(hasDatePromise('Старт через 2 рабочих дня.')).toBe(true);
    const g = applyGuards('Старт через 3 рабочих дня после первого платежа. Сделаем за неделю.', DEFAULT_GUARDS, firtechGuardContext('ru'));
    expect(g.text).toContain('3 рабочих дня');
    expect(g.text).not.toContain('за неделю');
  });

  it('the lessons of the training: fifteen few-shots of the lead manager, no amounts, found by a close question', async () => {
    expect(TRAINING_LESSONS.length).toBeGreaterThanOrEqual(15);
    expect(new Set(TRAINING_LESSONS.map((l) => l.key)).size).toBe(TRAINING_LESSONS.length);
    for (const l of TRAINING_LESSONS) {
      expect(l.good, l.key).not.toMatch(/\$\s?\d|\d\s?(usd|долл)|[—–]|основател|(^|[^а-яё])бот/iu);
      expect(l.roleId).toBe('lead-manager');
    }
    const store = new InMemoryLessons();
    for (const l of TRAINING_LESSONS) await store.add({ companyId: l.companyId, agentId: l.agentId, roleId: l.roleId, question: l.question, bad: l.bad, good: l.good, source: l.source, createdAt: l.createdAt });
    const near = async (q: string) => (await store.near('firtech', 'firtech/lead-manager', 'lead-manager', q, 2)).map((x) => x.question);
    expect((await near('А можно оплатить USDT?')).join(' ')).toMatch(/USDT/);
    expect((await near('есть пробный период?')).join(' ')).toMatch(/пробный/);
    expect((await near('что дальше после заявки?')).join(' ')).toMatch(/после заявки/);
    expect((await near('какие языки?')).join(' ')).toMatch(/языки/);
  });

  it('pass 2: the heads instructions, Content Maker prompt, cabinet and journey strings, client texts and their pack copies keep no old facts', () => {
    const repo = join(PACKAGE_DIR, '..', '..');
    const files = [
      ...readdirSync(join(repo, 'apps/hq/instructions')).map((f) => `apps/hq/instructions/${f}`),
      ...readdirSync(join(repo, 'packages/workers/content-maker/prompts')).map((f) => `packages/workers/content-maker/prompts/${f}`),
      'apps/hq/src/cabinet.ts', 'apps/hq/src/journey.ts', 'apps/hq/src/client/texts.ts', 'apps/hq/src/client/web-texts.ts', 'apps/hq/src/client/receptionist.ts',
      'knowledge/voice.md', 'knowledge/playbooks/sales.md',
      ...readdirSync(join(PACKAGE_DIR, 'company-packs', 'firtech')).filter((f) => /^internal-(apps-hq-instructions|knowledge-playbooks-sales)/.test(f)).map((f) => `packages/fira/company-packs/firtech/${f}`),
    ];
    for (const f of files) {
      const t = readFileSync(join(repo, f), 'utf8');
      expect(t, f).not.toMatch(/usdt/i);
      expect(t, f).not.toMatch(/основател/i);
      expect(t, f).not.toMatch(/бесплатн\S* пилот/iu);
      for (const part of t.split(/[.;\n]/)) {
        if (/менеджер/iu.test(part) && /круглосуточно/iu.test(part)) expect(part, `${f}: ${part}`).toMatch(/рабоч(ее|их) (время|часы)|in working hours/iu);
      }
    }
    for (const h of ['director', 'sales-head', 'backoffice-head', 'marketing-head', 'production-head', 'support-head']) {
      expect(readFileSync(join(repo, 'apps/hq/instructions', `${h}.md`), 'utf8'), h).toContain('## Что изменилось (2026-11-25)');
    }
    expect(readFileSync(join(repo, 'packages/workers/content-maker/prompts/system.md'), 'utf8')).toContain('Что изменилось (2026-11-25)');
  });
});
