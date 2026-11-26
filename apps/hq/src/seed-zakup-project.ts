import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

/**
 * One-off ops script (owner, 2026-11-26): puts the zakup.gov.kz agent project into the Пульт as a draft `pm_project` (source `owner`) with five
 * stage milestones and a first task. No money anywhere in the rows (`amount_usd` stays NULL): the offer sits only in the notes, not approved by the
 * owner. Idempotent by the exact title. The code of the agent itself lives in ~/fir-tech/zakup-agent (a note only, nothing here reads it).
 */
export const ZAKUP_TITLE = 'ИИ-агент госзакупок zakup.gov.kz';
export const ZAKUP_CLIENT = 'Знакомый владельца (zakup)';
const DAY = 86_400_000;

export const ZAKUP_STAGES: { no: number; ru: string; en: string; weeks: number }[] = [
  { no: 1, ru: 'Бот-знакомство + наблюдатель лотов', en: 'Intro bot + lot watcher', weeks: 1 },
  { no: 2, ru: 'Программа на ПК: запись рецепта, прямые запросы, подпись NCALayer', en: 'PC program: recipe recording, direct requests, NCALayer signature', weeks: 1.5 },
  { no: 3, ru: 'ИИ-ремонтник рецептов', en: 'AI recipe repairer', weeks: 1 },
  { no: 4, ru: 'ИИ-заполнение, дозапросы, разбор лота и цена', en: 'AI form filling, follow-up questions, lot analysis and price', weeks: 1 },
  { no: 5, ru: 'Аукцион (опционально)', en: 'Auction (optional)', weeks: 1 },
];

export const ZAKUP_SPEC = `Агент для Единой платформы закупок Казахстана (zakup.gov.kz).
Клиент: знакомый владельца, заявок с сайта нет. Приоритет клиента: скорость, самые короткие сроки.

Что делает:
1. Наблюдатель лотов: следит за лотами и присылает подходящие в Telegram.
2. Бот-знакомство: клиент называет БИН, агент сам берёт открытые данные и историю участия, задаёт по одному вопросу и только о том, чего не хватает.
3. Программа на ПК подаёт заявку примерно за 1 секунду: записанный «рецепт» из прямых запросов плюс подпись NCALayer. Ключ ЭЦП никогда не покидает ПК клиента.
4. ИИ-ремонтник переписывает рецепт, когда сайт меняется.
5. ИИ заполняет формы по профилю клиента.
6. Автоставки на аукционе: по желанию.

Этапы (сроки): 1) бот-знакомство и наблюдатель, 1 нед; 2) программа на ПК, 1,5 нед; 3) ИИ-ремонтник, 1 нед; 4) ИИ-заполнение, дозапросы, разбор лота и цена, 1 нед; 5) аукцион (опционально), +1 нед.

Предложение (не утверждено владельцем): автоматизация 2200 USD, аукцион 600 USD, поддержка 100 USD/мес; оплата автоматизации 20/50/30.

Код проекта: ~/fir-tech/zakup-agent (заметка, не часть этого проекта).`;

export interface SeedOptions {
  db: string;
  /** `YYYY-MM-DD` in the HQ clock; default: today there. */
  today?: string;
  tz?: string;
  dryRun?: boolean;
  now?: () => number;
}

export interface SeedResult { created: boolean; projectId: number; taskId?: number; plan?: { project: unknown; milestones: unknown[]; task: unknown } }

/** Today's `YYYY-MM-DD` on the clock `tz`. */
export function todayOn(now: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

/** Epoch ms of `date` 23:59 on the clock `tz`. */
export function endOfDay(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 23, 59);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)])) as Record<string, number>;
  const asLocal = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
  return guess - (asLocal - guess);
}

export function seed(o: SeedOptions): SeedResult {
  const db = new Database(o.db, { fileMustExist: true, timeout: 5000, ...(o.dryRun ? { readonly: true } : {}) });
  try {
    const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
    for (const t of ['pm_projects', 'pm_milestones', 'tasks']) if (!has(t)) throw new Error(`table ${t} is missing in ${o.db}: is this hq.db?`);
    const found = db.prepare('SELECT id FROM pm_projects WHERE what = ? ORDER BY id LIMIT 1').get(ZAKUP_TITLE) as { id: number } | undefined;
    if (found) return { created: false, projectId: found.id };
    const now = (o.now ?? Date.now)();
    const setting = has('settings') ? (db.prepare("SELECT value FROM settings WHERE key = 'tz'").get() as { value: string } | undefined)?.value : undefined;
    const tz = o.tz ?? setting ?? 'Asia/Dushanbe';
    const today = o.today ?? todayOn(now, tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('--today must be YYYY-MM-DD');
    const start = endOfDay(today, tz);
    let acc = 0;
    const milestones = ZAKUP_STAGES.map((s) => {
      acc += s.weeks;
      return { kind: 'stage', title: `Этап ${s.no}: ${s.ru}`, due_at: start + Math.round(acc * 7 * DAY), stage_no: s.no, amount_usd: null, title_en: s.en };
    });
    const project = { client: ZAKUP_CLIENT, what: ZAKUP_TITLE, product: 'automation', status: 'draft', spec: ZAKUP_SPEC, source: 'owner', created_at: now };
    const task = {
      title: 'Созвон с клиентом: заметки', dept: 'production', creator: 'owner', status: 'inbox', due_at: start,
      body: `Первый шаг проекта «${ZAKUP_TITLE}»: созвониться с клиентом и записать заметки (БИН, что подаёт сейчас, какие лоты, кто владеет ЭЦП, сроки).`,
    };
    if (o.dryRun) return { created: false, projectId: 0, plan: { project, milestones, task } };
    return db.transaction((): SeedResult => {
      const pid = Number(db.prepare('INSERT INTO pm_projects (client, what, product, status, spec, source, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
        .run(project.client, project.what, project.product, project.status, project.spec, project.source, project.created_at).lastInsertRowid);
      const ins = db.prepare('INSERT INTO pm_milestones (project_id, kind, title, due_at, stage_no, amount_usd, title_en) VALUES (?, ?, ?, ?, ?, NULL, ?)');
      for (const m of milestones) ins.run(pid, m.kind, m.title, m.due_at, m.stage_no, m.title_en);
      const tid = Number(db.prepare(`INSERT INTO tasks (title, body, dept, assignee_id, creator, parent_id, status, priority, due_at, meta, tags, routine_id, created_at, updated_at)
        VALUES (?, ?, ?, NULL, 'owner', NULL, 'inbox', 0, ?, ?, '', NULL, ?, ?)`).run(task.title, task.body, task.dept, task.due_at, JSON.stringify({ projectId: pid }), now, now).lastInsertRowid);
      if (has('task_events')) db.prepare('INSERT INTO task_events (task_id, kind, actor, body, at) VALUES (?, ?, ?, ?, ?)').run(tid, 'status', 'owner', 'created: inbox', now);
      if (has('activity')) {
        db.prepare('INSERT INTO activity (agent_id, action, object_type, object_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)').run('owner', 'project_seeded', 'project', String(pid), ZAKUP_TITLE, now);
      }
      return { created: true, projectId: pid, taskId: tid };
    })();
  } finally {
    db.close();
  }
}

/** CLI: `node dist/seed-zakup-project.js [--db <path>] [--today YYYY-MM-DD] [--tz <zone>] [--dry-run]`. */
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const db = arg('--db') ?? `${env.DATA_DIR ?? '/app/data'}/hq.db`;
  try {
    if (!existsSync(db)) throw new Error(`${db} does not exist`);
    const r = seed({ db, ...(arg('--today') ? { today: arg('--today')! } : {}), ...(arg('--tz') ? { tz: arg('--tz')! } : {}), dryRun: argv.includes('--dry-run') });
    if (r.plan) console.log(`dry run, would insert:\n${JSON.stringify(r.plan, null, 2)}`);
    else if (!r.created) console.log(`already exists: project id ${r.projectId}, nothing done`);
    else console.log(`created project id ${r.projectId}, first task id ${r.taskId}`);
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file://').href) process.exit(main(process.argv.slice(2)));
