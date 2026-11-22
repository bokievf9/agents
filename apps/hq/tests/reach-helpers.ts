/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import type { ShellWorld } from './shell-helpers.js';

/** What `agent-reach youtube read` prints (real shape, shortened). */
export const YT_READ = {
  ok: true, items: [{ title: 'Бот для салона за минуту', url: 'https://www.youtube.com/shorts/xyz789', author: 'Мастер Айдар', published_at: '2026-11-01', text: 'Описание', raw: { id: 'xyz789', duration: 24, view_count: 120_000, like_count: 8_500 } }], meta: { elapsed_ms: 2000 },
};
/** What `agent-reach youtube subtitle` prints: plain text, lines broken, no times. */
export const YT_SUBTITLE = {
  ok: true, items: [{ title: 'Бот для салона за минуту', url: 'https://www.youtube.com/shorts/xyz789', author: null, published_at: null, text: 'Клиент пишет вам в два часа ночи.\nА салон закрыт.\nБот отвечает за вас и записывает его на среду.\nВот как это настроить за минуту.\nНапишите слово БОТ в комментариях.', raw: { lang: 'ru' } }], meta: { elapsed_ms: 2100 },
};
export const NO_SUBTITLES = { ok: false, items: [], meta: {}, error: { code: 'NOT_FOUND', message: 'no subtitles for this video' } };

type Answer = (job: { id: number; channel: string; action: string; args: Record<string, unknown> }) => unknown | { error: string };

/** The Mac in a test: lists the queued jobs, claims each, answers with `answer(job)` (a CLI JSON or `{ error }`). Returns the jobs answered. */
export async function macAnswers(p: ShellWorld, answer: Answer, channels: string[] = ['youtube', 'web']): Promise<{ id: number; channel: string; action: string }[]> {
  const list = (await p.call('GET', `/admin/reach/jobs?status=queued&channels=${channels.join(',')}`)).json.items as any[];
  const done: { id: number; channel: string; action: string }[] = [];
  for (const j of list) {
    expectOk((await p.call('POST', `/admin/reach/jobs/${j.id}/claim`, { channels })).status);
    const a = answer(j) as any;
    const body = a && typeof a === 'object' && 'error' in a && !('ok' in a) ? { ok: false, error: a.error } : { ok: true, result: a };
    expectOk((await p.call('POST', `/admin/reach/jobs/${j.id}/result`, body)).status);
    done.push({ id: j.id, channel: j.channel, action: j.action });
  }
  return done;
}
const expectOk = (status: number) => {
  if (status !== 200) throw new Error(`reach helper: HTTP ${status}`);
};
