import { z } from 'zod';

/**
 * The site's «Персональный ИИ» brief (`brief.type === 'personal'`, contract: firtech `docs/builder-v2.md` «brief v4 contract»). Every part is tolerant:
 * a malformed part is dropped (`.catch`), strings are clipped, arrays capped. A personal lead has no niche and no business products.
 */
const text = (n: number) => z.string().trim().max(n);
const list = (n: number, max: number) => z.array(text(n)).max(max).optional().catch(undefined);
const axis = z.number().int().min(0).max(2);

export const personalBriefSchema = z.object({
  who: text(40).optional().catch(undefined),
  hand: list(30, 12),
  where: list(30, 8),
  connect: list(30, 12),
  tone: z.object({ formality: axis.optional().catch(undefined), brevity: axis.optional().catch(undefined), initiative: axis.optional().catch(undefined) }).optional().catch(undefined),
  tier: z.enum(['basic', 'plus', 'max']).optional().catch(undefined),
  byok: z.boolean().optional().catch(undefined),
});
export type PersonalBrief = z.output<typeof personalBriefSchema>;

/** The brief fields the HQ webhook keeps on `meta.lead.brief` (shape of the site's `brief`, personal part optional). */
export const briefFieldsSchema = personalBriefSchema.extend({ type: text(20).optional().catch(undefined) });

export const TIER_RU = { basic: 'Спутник', plus: 'Второй пилот', max: 'Второе я' } as const;
const WHO_RU: Record<string, string> = { student: 'студент', founder: 'основатель', doctor: 'врач', freelancer: 'фрилансер', manager: 'руководитель', parent: 'родитель', blogger: 'блогер', teacher: 'преподаватель', other: 'другое' };
const HAND_RU: Record<string, string> = { mail: 'почта', calendar: 'календарь', study: 'учёба', money: 'деньги', health: 'здоровье', languages: 'языки', content: 'контент', home: 'дом', docs: 'документы', reminders: 'напоминания', calls: 'звонки', search: 'поиск' };
const WHERE_RU: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp', webchat: 'веб-чат', cabinet: 'кабинет', voice: 'голос', email: 'почта', desktop: 'компьютер' };
const CONNECT_RU: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', apple: 'Apple', moodle: 'Moodle', notion: 'Notion', telegram: 'Telegram', whatsapp: 'WhatsApp', bank: 'банк', other: 'другое' };
const TONE_AXIS: Array<['formality' | 'brevity' | 'initiative', [string, string, string]]> = [
  ['formality', ['дружелюбный', 'ровный', 'формальный']],
  ['brevity', ['кратко', 'средне', 'подробно']],
  ['initiative', ['ждёт просьбы', 'иногда сам', 'проактивный']],
];
const words = (ids: string[], map: Record<string, string>): string => ids.map((x) => map[x] ?? x).join(', ');

/** The personal part of a webhook `brief` when it is one (`type: 'personal'`), else null. */
export function personalOf(brief: unknown): PersonalBrief | null {
  if (!brief || typeof brief !== 'object' || (brief as { type?: unknown }).type !== 'personal') return null;
  return personalBriefSchema.parse(brief);
}

/** `service` and `brief` of a lead: is it a Персональный ИИ lead. */
export const isPersonalLead = (service: string, brief: unknown): boolean => service === 'personal' || personalOf(brief) !== null;

/** One compact Russian line: «Персональный ИИ · уровень … · свой ключ да/нет · кто: … · передать: … · каналы: … · подключить: … · характер: …». */
export function personalSummary(b: PersonalBrief | null): string {
  const p = { ...(b ?? personalBriefSchema.parse({})) };
  const hand = p.hand ?? [], where = p.where ?? [], connect = p.connect ?? [];
  const parts = ['Персональный ИИ'];
  if (p.tier) parts.push(`уровень ${TIER_RU[p.tier]}`);
  if (p.byok !== undefined) parts.push(`свой ключ ${p.byok ? 'да' : 'нет'}`);
  if (p.who) parts.push(`кто: ${WHO_RU[p.who] ?? p.who}`);
  if (hand.length) parts.push(`передать: ${words(hand, HAND_RU)}`);
  if (where.length) parts.push(`каналы: ${words(where, WHERE_RU)}`);
  if (connect.length) parts.push(`подключить: ${words(connect, CONNECT_RU)}`);
  const tone = TONE_AXIS.filter(([k]) => p.tone?.[k] !== undefined).map(([k, names]) => names[p.tone![k]!]);
  if (tone.length) parts.push(`характер: ${tone.join(', ')}`);
  return parts.join(' · ');
}

/** What goes into `meta.lead.brief` for a personal lead: only the validated personal fields. */
export const personalBriefMeta = (brief: unknown): { type: 'personal' } & PersonalBrief => ({ type: 'personal', ...personalBriefSchema.parse(brief ?? {}) });
