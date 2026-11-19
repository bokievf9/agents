import type { Hq, Routine } from '@fir/hq';
import { deptRu } from './progress.js';

/**
 * What wakes each executor: a routine (by name, its time is read from the database), a command of the owner, or an event.
 * The one source for `/workers` and for the table in `docs/architecture-hq.md` (a test keeps it complete).
 */
export interface Trigger {
  routines?: string[];
  commands?: string[];
  events?: string[];
}

export const WORKER_TRIGGERS: Record<string, Trigger> = {
  'content-maker': { routines: ['marketing-weekly-pack', 'marketing-article-daily'], commands: ['profile', 'article'], events: ['просьба владельца: «пакет», «рилс», «пост» (Директор)'] },
  'trend-scout': { routines: ['marketing-trends-daily', 'marketing-trends-weekly'] },
  publisher: { routines: ['marketing-daily-today'] },
  seo: { routines: ['marketing-seo-weekly'], events: ['заявка на аудит: POST /audit и /audit в клиентском боте'] },
  analyst: { routines: ['marketing-analyst-weekly'] },
  'lead-intake': { events: ['заявка с сайта (POST /lead)', 'анкета в клиентском боте', 'контакт в веб-чате'] },
  prospector: { routines: ['sales-daily-cards', 'sales-followups'], commands: ['reply'] },
  presales: { commands: ['kp'], events: ['лид стал квалифицированным (есть услуга и бюджет или смета): КП делается само'] },
  referral: { routines: ['sales-referral-reminders'], commands: ['referral', 'referrals'], events: ['первый счёт лида с меткой ref: оплачен: выплата рекомендателю'] },
  'client-bot': { events: ['сообщения в клиентском боте и веб-чате (только учёт расходов на модель)'] },
  'customer-support': { commands: ['ticket'], events: ['«я уже клиент» в клиентском боте и веб-чате'] },
  monitoring: { events: ['каждые 5 минут (свой cron головы сопровождения, не рутина)'] },
  finance: { routines: ['support-daily', 'support-weekly'] },
  billing: { routines: ['support-billing'], commands: ['invoice', 'sub', 'paid'], events: ['КП утверждено: счёт на 50% делается вместе с договором'] },
  onboarding: { commands: ['onboard'], events: ['оплачен счёт с пометкой нового проекта'], routines: ['support-billing'] },
  'project-manager': { commands: ['project', 'pstatus'], events: ['оплачен первый счёт КП: проект и этапы'] },
  reviewer: { events: ['строитель вернул результат со ссылкой на ветку или PR'] },
  deployer: { commands: ['mdone'], events: ['этап «Сдача» закрыт'] },
  documents: { commands: ['doc'], events: ['КП утверждено: договор делается вместе со счётом'] },
  knowledge: { routines: ['backoffice-lessons-weekly'], commands: ['lesson', 'kb'] },
};

const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const CITY = (tz: Routine['tz']) => (tz === 'owner' ? 'Куала-Лумпур' : 'Душанбе');

/** «пн 06:00 Куала-Лумпур» from a simple cron (minute hour * * day-of-week); anything else stays as the cron. */
export function cronWords(r: Pick<Routine, 'cron' | 'tz'>): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|\d)$/.exec(r.cron.trim());
  if (!m) return `${r.cron} ${CITY(r.tz)}`;
  const time = `${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}`;
  return `${m[3] === '*' ? 'каждый день' : DOW[Number(m[3])]} ${time} ${CITY(r.tz)}`;
}

/** The table for `/workers`: every executor of the database, what wakes it, with the real routine times. */
export function workersText(hq: Hq): string {
  const workers = hq.agents().filter((a) => a.role === 'worker');
  const lines = workers.map((a) => {
    const t = WORKER_TRIGGERS[a.id];
    const parts: string[] = [];
    for (const name of t?.routines ?? []) {
      const r = hq.routineByName(name);
      parts.push(r ? `рутина ${name} (${cronWords(r)})` : `рутина ${name} (не создана)`);
    }
    for (const c of t?.commands ?? []) parts.push(`/${c}`);
    for (const e of t?.events ?? []) parts.push(e);
    return `${deptRu(a.dept)} · ${a.title} (${a.id}): ${parts.join('; ') || 'только по просьбе головы отдела'}`;
  });
  return `Исполнители (${workers.length}) и что их запускает:\n${lines.join('\n')}\n\nВремя рутин: «Куала-Лумпур» ваше (то, что приходит вам утром), «Душанбе» рынок (клиенты, публикации).`;
}
