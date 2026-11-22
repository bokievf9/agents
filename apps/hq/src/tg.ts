import { escapeHtml, type ApprovalRow, type BotCommand, type Button, type CardFormat, type ReplyKeyboard } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { ApprovalEditor } from './editor.js';
import { DIRECTOR_MENU } from './commands.js';
import { deptRu } from './progress.js';

/** Telegram UX of the Director (patterns: apps/hq/docs/telegram-ux.md). */

export const esc = escapeHtml;
export const bold = (s: string) => `<b>${esc(s)}</b>`;
export const code = (s: string | number) => `<code>${esc(String(s))}</code>`;
export const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---- the reply keyboard (under the input field, kept by Telegram) ----
export const MENU: Record<string, string> = {
  '📥 Одобрения': 'approve',
  '📋 Задачи': 'tasks',
  '📊 Статус': 'status',
  '🏢 Отделы': 'depts',
  '🆘 Помощь': 'help',
};
export const KEYBOARD: ReplyKeyboard = {
  rows: [['📥 Одобрения', '📋 Задачи', '📊 Статус'], ['🏢 Отделы', '🆘 Помощь']],
  placeholder: 'Задача обычным текстом или кнопка',
};
/** The command a reply-keyboard button stands for (tolerates spaces and a missing emoji). */
export function menuCommand(text: string): string | null {
  const t = text.trim();
  if (MENU[t]) return MENU[t];
  const bare = t.replace(/^\p{Extended_Pictographic}️?\s*/u, '').toLowerCase();
  for (const [label, cmd] of Object.entries(MENU)) if (label.replace(/^\p{Extended_Pictographic}️?\s*/u, '').toLowerCase() === bare) return cmd;
  return null;
}

// ---- the command menu ----
/** The owner's menu (scoped to his private chat), made from the one command list (`commands.ts`): at most 20 shown. */
export const DIRECTOR_COMMANDS: BotCommand[] = DIRECTOR_MENU;

/** The profile of the one HQ bot (2026-11-22): a reminder that answers questions; control lives in the Shell. */
export const HQ_PROFILE = {
  description:
    'Shell Fir Tech: напоминает владельцу о главном (новый клиент, заявка, документ на одобрение, оплата, этап) и отвечает на любой вопрос о компании обычным текстом. Управление в Shell firtech.pro/admin. Отвечает только владельцу.',
  short: 'Shell Fir Tech: напоминания и ответы владельцу. Управление в Shell.',
};

export const DIRECTOR_PROFILE = {
  description:
    'Fir Tech Director: единственный голос компании агентов для владельца. Задачи обычным текстом, одобрения карточками с кнопками, статус отделов и задач в одно касание. Отвечает только владельцу.',
  short: 'Fir Tech Director: задачи, одобрения и статус отделов. Только для владельца.',
};

// ---- approval cards ----
export const KIND_RU: Record<string, string> = {
  content_item: 'Контент', article: 'Статья дня', seo_proposal: 'SEO-правка', billing_invoice: 'Счёт', billing_reminder: 'Напоминание об оплате',
  support_answer: 'Ответ клиенту', support_money: 'Деньги клиента', bo_document: 'Документ', lead_reply: 'Ответ лиду',
  lead_price: 'Цена лиду', onboarding_guide: 'Онбординг', presales_pack: 'Пакет пресейла', pm_spec: 'ТЗ проекта',
  pm_client_status: 'Статус клиенту', prospect_first: 'Первое сообщение бизнесу', prospect_followup: 'Дожим бизнеса',
  prospect_reply: 'Ответ бизнесу', referral_reward: 'Награда за рекомендацию', referral_payout: 'Выплата за рекомендацию',
  content_pack: 'Контент: пакет недели', audit: 'Аудит сайта клиенту',
};
export const kindRu = (kind: string) => KIND_RU[kind] ?? kind;

export const PREVIEW_CHARS = 500;
const SUMMARY_CHARS = 600;
/** Cards whose summary is the whole point (a weekly pack lists all its items): shown at the long length at once. */
const WIDE_KINDS = new Set(['content_pack']);
/** Telegram counts 4096 characters after parsing; keep a margin for the markup lines. */
const FULL_CHARS = 3300;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The card look: bold title with department and kind, the summary, a ≤ 500-character preview, buttons in two rows. */
export function approvalCardFormat(hq: Hq, editors: Map<string, ApprovalEditor>): CardFormat {
  /** The batch prefix of the summary («[1/8] marketing, задача #12»): the link row gets the approval id only after the card is sent. */
  const split = (row: ApprovalRow) => {
    const m = /^\[(\d+)\/(\d+)\] ([a-z_]+), задача #(\d+)\n/.exec(row.summary);
    const link = hq.approvalByCoreId(row.id);
    return {
      prefix: m ? m[0].trim() : link ? `задача #${link.taskId}` : '',
      dept: m ? m[3]! : link?.dept ?? null,
      summary: (m ? row.summary.slice(m[0].length) : row.summary).trim(),
    };
  };
  const title = (row: ApprovalRow) => {
    const dept = split(row).dept;
    return `#${row.id} · ${dept ? `${deptRu(dept)} · ` : ''}${kindRu(row.kind)}`;
  };
  return {
    card({ row, level, streak, locked, full }) {
      const { prefix, summary } = split(row);
      const text = typeof row.payload.text === 'string' ? row.payload.text.trim() : '';
      const room = full ? FULL_CHARS : PREVIEW_CHARS;
      const summaryRoom = WIDE_KINDS.has(row.kind) ? FULL_CHARS : SUMMARY_CHARS;
      const truncated = text.length > PREVIEW_CHARS || summary.length > summaryRoom;
      const lines = [
        `📥 ${bold(title(row))}`,
        `<i>${esc(`${prefix ? `${prefix} · ` : ''}${row.kind} (уровень ${level}, подряд ${streak})`)}${locked ? ' · 🔒 только по одной' : ''}</i>`,
        '',
        esc(full ? cut(summary, FULL_CHARS) : cut(summary, summaryRoom)),
      ];
      if (text) lines.push('', `<b>Предлагаю отправить:</b>\n<blockquote>${esc(cut(text, Math.max(200, room - (full ? summary.length : 0))))}</blockquote>`);
      const buttons: Button[][] = [[
        { text: '✅ Одобрить', data: `ap:${row.id}:a` },
        { text: row.kind === 'article' ? '✏️ Переписать' : '✏️ Править', data: `ap:${row.id}:e` },
        { text: '❌ Отклонить', data: `ap:${row.id}:r` },
      ]];
      const parts = editors.get(row.kind)?.parts?.(row.id) ?? null;
      if (parts && parts.length > 1) buttons.push(parts.slice(0, 5).map((p) => ({ text: p.label, data: `ce:${row.id}:${p.id}`.slice(0, 64) })));
      if (truncated) buttons.push([full ? { text: '🔼 Свернуть', data: `ap:${row.id}:s` } : { text: '👁 Полностью', data: `ap:${row.id}:f` }]);
      return { text: lines.join('\n'), buttons };
    },
    settled(row, state) {
      const t = title(row);
      switch (state) {
        case 'executed': return { text: `✅ ${bold('Одобрено')} · ${esc(t)}` };
        case 'rejected': return { text: `❌ ${bold('Отклонено')} · ${esc(t)}` };
        case 'failed': return { text: `⚠️ ${bold('Не выполнено')} · ${esc(t)}\nОдобрили, но выполнить не вышло: задача в /tasks, подробности в логе.` };
        case 'editing':
          return {
            text: `✏️ ${bold('Жду правку')} · ${esc(t)}\nПришлите новый текст одним сообщением.`,
            buttons: [[{ text: '✅ Одобрить как есть', data: `ap:${row.id}:a` }, { text: '❌ Отклонить', data: `ap:${row.id}:r` }]],
          };
        case 'edited': return { text: `✏️ ${bold('Правка принята, одобрите')} · ${esc(t)}\nНовая карточка ниже.` };
        case 'stale': return { text: 'Устарело: этого предложения больше нет.' };
        case 'running': return { text: `⏳ ${bold('Выполняется')} · ${esc(t)}` };
      }
    },
  };
}

// ---- callback data ----
/** Every callback is namespaced and ≤ 64 bytes: `ap:` approvals, `tk:` a task, `pg:` a task list page, `dp:` departments. */
export const cb = {
  page: (filter: string, page: number) => `pg:${filter}:${page}`,
  task: (id: number, op: 'o' | 'r' | 'x' | 'X' | 'j', filter = 'all', page = 0) => `tk:${id}:${op}:${filter}:${page}`,
  dept: (dept: string, op: 'o' | 'p' | 'r' = 'o') => `dp:${dept}:${op}`,
  depts: 'dp:list',
};

export type Nav =
  | { ns: 'pg'; filter: string; page: number }
  | { ns: 'tk'; id: number; op: 'o' | 'r' | 'x' | 'X' | 'j'; filter: string; page: number }
  | { ns: 'dp'; dept: string | null; op: 'o' | 'p' | 'r' | 'list' }
  | { ns: 'ap'; op: 'all' | 'later' | 'show' | 'full' | 'short'; id?: number }
  /** A weekly pack's card: `o` opens its items one by one, `v` sends the previews that exist. */
  | { ns: 'pk'; op: 'o' | 'v'; id: number };

export function parseNav(data: string): Nav | null {
  let m = /^pg:([a-z_]+):(\d{1,4})$/.exec(data);
  if (m) return { ns: 'pg', filter: m[1]!, page: Number(m[2]) };
  m = /^tk:(\d+):([orxXj])(?::([a-z_]+):(\d{1,4}))?$/.exec(data);
  if (m) return { ns: 'tk', id: Number(m[1]), op: m[2] as 'o', filter: m[3] ?? 'all', page: Number(m[4] ?? 0) };
  if (data === 'dp:list') return { ns: 'dp', dept: null, op: 'list' };
  m = /^dp:([a-z_]+):([opr])$/.exec(data);
  if (m) return { ns: 'dp', dept: m[1]!, op: m[2] as 'o' };
  m = /^ap:(all|later|show)$/.exec(data);
  if (m) return { ns: 'ap', op: m[1] as 'all' };
  m = /^pk:(\d+):([ov])$/.exec(data);
  if (m) return { ns: 'pk', op: m[2] as 'o', id: Number(m[1]) };
  m = /^ap:(\d+):([fs])$/.exec(data);
  if (m) return { ns: 'ap', op: m[2] === 'f' ? 'full' : 'short', id: Number(m[1]) };
  return null;
}
