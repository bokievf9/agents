import { describe, expect, it } from 'vitest';
import { isPersonalLead, personalBriefMeta, personalOf, personalSummary } from '../src/personal.js';
import { parseEnrichment } from '../src/store.js';
import { KIND_REPLY, leadStoreFor, webLeadSchema } from '../src/worker.js';
import { setup, webLead } from './helpers.js';

const brief = { v: 1, type: 'personal', who: 'student', hand: ['mail', 'study'], where: ['telegram', 'voice'], connect: ['google', 'moodle'], tone: { formality: 0, brevity: 0, initiative: 2 }, tier: 'plus', byok: true };
// the site's estimate text of a personal lead may still mention a business word: the card must not pick it up
const personalLead = (over: Record<string, unknown> = {}) => webLead({ service: 'personal', message: 'Персональный ИИ', estimate: 'Итого: $390\nкафе + ИИ-менеджер заявок', brief, ...over });

describe('Персональный ИИ lead', () => {
  it('summary line uses human labels', () => {
    const s = personalSummary(personalOf(brief));
    expect(s).toBe('Персональный ИИ · уровень Второй пилот · свой ключ да · кто: студент · передать: почта, учёба · каналы: Telegram, голос · подключить: Google, Moodle · характер: дружелюбный, кратко, проактивный');
  });

  it('is tolerant to a malformed brief', () => {
    const p = personalOf({ type: 'personal', hand: 'x', tier: 'gold', tone: { formality: 9 }, byok: 'yes' });
    expect(p?.hand).toBeUndefined();
    expect(p?.where).toBeUndefined();
    expect(p?.tier).toBeUndefined();
    expect(personalOf({ type: 'business' })).toBeNull();
    expect(isPersonalLead('personal', undefined)).toBe(true);
    expect(personalBriefMeta({ ...brief, junk: 1 })).not.toHaveProperty('junk');
  });

  it('webLeadSchema accepts service personal and the brief', () => {
    const w = webLeadSchema.parse(personalLead());
    expect(w.service).toBe('personal');
    expect(w.brief).toMatchObject({ type: 'personal', tier: 'plus', byok: true, hand: ['mail', 'study'] });
    expect(webLeadSchema.parse(webLead({ brief: 'oops' })).brief).toBeUndefined();
  });

  it('the card, the task and the enrichment carry the personal line and no niche or business product', async () => {
    const { run, task, staged, db } = setup();
    const r = await run(task(personalLead()));
    expect(r.ok).toBe(true);
    const card = staged.find((s) => s.kind === KIND_REPLY)!.summary;
    expect(card).toContain('Персональный ИИ · уровень Второй пилот · свой ключ да · кто: студент');
    expect(card).not.toMatch(/Ниша|кафе|ИИ-менеджер заявок|смета по частям/i);
    const lead = leadStoreFor({ db, now: () => 0 }).get(1)!;
    expect(lead.niche).toBe('');
    expect(lead.service).toBe('personal');
    expect(lead.task).toContain('Персональный ИИ');
    expect(lead.enrichment?.personal).toEqual({ tier: 'plus', byok: true });
    expect(parseEnrichment(JSON.stringify(lead.enrichment))?.personal).toEqual({ tier: 'plus', byok: true });
    expect(r.result).not.toMatch(/кафе/i);
  });

  it('a business lead card keeps its niche line', async () => {
    const { run, task, staged } = setup();
    await run(task());
    const card = staged.find((s) => s.kind === KIND_REPLY)!.summary;
    expect(card).toContain('Ниша: салон красоты / барбершоп');
    expect(card).not.toContain('Персональный ИИ');
  });
});
