import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCompanyPack, loadNichePack, loadRolePack, nicheBrief, nicheOfKind, nichePackIds, PACKAGE_DIR, parseMd, parseNichePack, parseRolePack } from '../src/index.js';

describe('packs on disk', () => {
  it('the lead manager role pack: goal, duties, boundaries, hand-off, metrics, default tools and tier', () => {
    const r = loadRolePack('lead-manager');
    expect(r.id).toBe('lead-manager');
    expect(r.title).toBe('ИИ-менеджер заявок');
    expect(r.tier).toBe('sonnet');
    expect(r.tools).toEqual(['knowledge_search', 'price_list', 'builder_link', 'call_slots', 'record_brief', 'demo_link', 'capture_contact', 'handoff_owner']);
    expect(r.goal).toMatch(/подобрать подходящий продукт/);
    expect(r.duties.length).toBeGreaterThanOrEqual(6);
    expect(r.duties.join(' ')).toMatch(/Не больше трёх уточняющих вопросов/);
    expect(r.boundaries.join(' ')).toMatch(/Dono, Polly/);
    expect(r.handoff.length).toBeGreaterThanOrEqual(3);
    expect(r.metrics.length).toBeGreaterThanOrEqual(3);
    // from the site's sales playbook (2026-11-23): segments, the offer, objections with answers, how the manager sells
    expect(r.segments.length).toBeGreaterThanOrEqual(7);
    expect(r.offer.join(' ')).toContain('возвращаем оплату первого этапа');
    expect(r.offer.join(' ')).toMatch(/пилот/);
    expect(r.objections.map((x) => x.q)).toContain('Дорого.');
    expect(r.selling.length).toBeGreaterThanOrEqual(5);
    // no day counts in the pack: the date guard would cut them out of any reply that repeats them
    expect(JSON.stringify(r)).not.toMatch(/\d+\s*дн/);
  });

  it('six starting niches (salon, clinic, cafe, courses, car service, shop): services, FAQ, objections, limits, the builder kinds they cover', () => {
    const ids = nichePackIds();
    for (const id of ['salon', 'clinic', 'cafe', 'courses', 'carservice', 'shop']) {
      expect(ids).toContain(id);
      const n = loadNichePack(id);
      expect(n.services.length, id).toBeGreaterThanOrEqual(3);
      expect(n.faq.length, id).toBeGreaterThanOrEqual(3);
      expect(n.objections.length, id).toBeGreaterThanOrEqual(2);
      expect(n.boundaries.length, id).toBeGreaterThanOrEqual(2);
      expect(n.kinds.length, id).toBeGreaterThanOrEqual(3);
    }
    expect(nicheOfKind('barber')?.id).toBe('salon');
    expect(nicheOfKind('dentist')?.id).toBe('clinic');
    expect(nicheOfKind('delivery')?.id).toBe('cafe');
    expect(nicheOfKind('onlineschool')?.id).toBe('courses');
    expect(nicheOfKind('carwash')?.id).toBe('carservice');
    expect(nicheOfKind('flowers')?.id).toBe('shop');
    expect(nicheOfKind('bank')).toBeNull();
    expect(nicheOfKind(undefined)).toBeNull();
    // the clinic never gives medical advice; the brief carries the limits and stays small
    expect(loadNichePack('clinic').boundaries.join(' ')).toMatch(/медицинских советов/);
    const brief = nicheBrief(loadNichePack('clinic'));
    expect(brief).toMatch(/^Ниша собеседника: Клиника/);
    expect(brief).toMatch(/Граница: Никаких медицинских советов/);
    expect(brief.length).toBeLessThanOrEqual(1800);
  });

  it('the IT-services niche pack: services, terms, FAQ and objections as question/answer pairs', () => {
    const n = loadNichePack('it-services');
    expect(n.services.some((s) => s.startsWith('ИИ-администратор'))).toBe(true);
    expect(n.faq.find((x) => /платить/.test(x.q))?.a).toMatch(/По этапам/);
    expect(n.objections.length).toBeGreaterThanOrEqual(3);
    expect(n.tone.length).toBeGreaterThan(0);
  });

  it('Fir Tech is tenant 0: retention 90 days live and 24 hours anonymous, money and contracts locked; stages, guarantee, pilots, demo; prices only live', () => {
    const c = loadCompanyPack('firtech');
    const facts = c.facts.join(' ');
    expect(facts).toContain('Если первый экран сайта или первый сценарий агента не понравился, возвращаем оплату первого этапа.');
    expect(facts).toMatch(/оплата по этапам/);
    expect(facts).toMatch(/Пилот только на флагманах/);
    expect(facts).toMatch(/Демо на данных клиента/);
    // no copy of the price list: the amounts come from price_list (getPrices()) at the time of the answer
    expect(facts).not.toMatch(/\$\s?\d/);
    expect(c.retention).toEqual({ liveDays: 90, anonHours: 24 });
    expect(c.rights.locked).toEqual(['цены', 'договоры', 'деньги']);
    expect(c.style.languages[0]).toBe('ru');
  });

  it('parseMd: front matter, title, bullets with continuation lines, prose', () => {
    const p = parseMd('---\nid: x\ntools: a, b\n---\n# Title\n\n## Цель\nOne line.\nTwo.\n\n## Обязанности\n- first\n  continued\n- second\n');
    expect(p.meta).toEqual({ id: 'x', tools: 'a, b' });
    expect(p.title).toBe('Title');
    expect(p.prose['цель']).toBe('One line. Two.');
    expect(p.sections['обязанности']).toEqual(['first continued', 'second']);
  });

  it('a broken pack is refused with the field that is wrong; a path-like id is refused before any read', () => {
    expect(() => parseRolePack('---\nid: Bad Id\n---\n# X\n## Цель\nкоротко\n')).toThrow();
    expect(() => parseNichePack('---\nid: n\n---\n# N\n')).toThrow(/services/);
    expect(() => loadRolePack('../secrets')).toThrow(/bad pack id/);
  });

  it('no pack and no eval says a banned name (owner 2026-11-22: no «бот» as a product name, no «приёмщик», «калькулятор», «конструктор»)', () => {
    const banned: [string, RegExp][] = [
      ['приёмщик', /приём?щик/iu], ['калькулятор', /калькулятор/iu], ['конструктор', /конструктор/iu],
      ['бот-администратор', /бот[а-яё]*-администратор/iu], ['ИИ-бот', /(ии|ai)[- ]бот/iu], ['50/50', /50\s*(?:на|\/)\s*50/u],
    ];
    const hits: string[] = [];
    let n = 0;
    for (const dir of ['role-packs', 'niche-packs', 'company-packs', 'evals']) {
      // the generated company pack (`company-packs/firtech/`) mirrors documents that have their own checks (the site's copy test, HQ's names test)
      for (const f of readdirSync(join(PACKAGE_DIR, dir))) {
        if (!/\.(md|json)$/.test(f)) continue;
        n++;
        const text = readFileSync(join(PACKAGE_DIR, dir, f), 'utf8');
        // an eval's own `banned` list names the words on purpose
        const body = dir === 'evals' ? text.replace(/"banned":\s*\[[^\]]*\]/, '') : text;
        for (const [name, re] of banned) if (re.test(body)) hits.push(`${dir}/${f}: ${name}`);
      }
    }
    expect(n).toBeGreaterThanOrEqual(4);
    expect(hits).toEqual([]);
  });
});
