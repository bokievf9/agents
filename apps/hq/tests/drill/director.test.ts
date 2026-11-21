/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER, drillWorld, type DrillWorld } from './world.js';
import { seedEverything } from './seed.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;
beforeAll(async () => {
  w = await drillWorld({ tgCards: true });
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  await seedEverything(w);
}, 60_000);
afterAll(async () => { await w?.close(); });

const answered = (calls: { method: string }[]) => calls.some((c) => c.method === 'answerCallbackQuery');

describe('TG_APPROVAL_CARDS=on (legacy): the Director buttons through the real bot glue', () => {
  const taskId = () => w.hq.tasks({ dept: 'support', limit: 5 })[0]!.id;
  const BUTTONS = ['pg:all:0', 'pg:all:5', 'pg:sales:0', 'pg:support:1', 'pg:nope:0', 'pg:all:9999', 'dp:list', 'dp:sales:o', 'dp:sales:p', 'dp:sales:r', 'dp:nope:p', 'dp:marketing:o', 'ap:all', 'ap:later', 'ap:show', 'ap:99999:f', 'ap:99999:s', 'tk:99999:o', 'tk:99999:r', 'tk:99999:x', 'tk:99999:X', 'tk:99999:j', 'pk:99999:o', 'pk:99999:v', 'pb:99999', 'rl:99999:y', 'rl:99999:n', 'pc:99999:c', 'ce:99999:caption', 'ap:99999:a', 'ap:99999:e', 'ap:99999:r', 'zz:unknown', 'garbage', '', 'ap:', 'tk:abc:o'];
  it.each(BUTTONS)('%s is answered, never left spinning', async (data) => {
    const calls = await w.press(data);
    await w.settle();
    expect(answered(calls), `${data}: no answerCallbackQuery`).toBe(true);
    expect(g.rejections).toEqual([]);
    expect(g.errors().map((l) => `${l.msg}: ${String(l.err)}`)).toEqual([]);
  });
  it('task card buttons on a real task: open, journal, retry, reject-confirm, reject, and again', async () => {
    const id = taskId();
    for (const d of [`tk:${id}:o`, `tk:${id}:j`, `tk:${id}:r`, `tk:${id}:x`, `tk:${id}:o:support:0`, `tk:${id}:j:all:0`, `tk:${id}:X`, `tk:${id}:X`, `tk:${id}:o`]) {
      const calls = await w.press(d);
      expect(answered(calls), d).toBe(true);
    }
    expect(g.errors()).toEqual([]);
  });
  it('a stranger cannot decide an approval through the button', async () => {
    const r = w.queue.pending()[0]!;
    await w.press(`ap:${r.id}:a`, { from: 777 });
    expect(w.queue.get(r.id)!.status).toBe('pending');
  });
  it('«Скопировать» on a Scout card sends the draft', async () => {
    const card = w.queue.pending().find((r) => r.kind === 'prospect_first')!;
    const n = w.tg.sent.length;
    const calls = await w.press(`pc:${card.id}:c`);
    expect(answered(calls)).toBe(true);
    expect(w.tg.sent.length).toBeGreaterThan(n);
  });
  it('«Одобрить все обычные» approves what is ordinary and leaves money and prices', async () => {
    const calls = await w.press('ap:all');
    await w.settle();
    expect(answered(calls)).toBe(true);
    expect(w.queue.pending().every((r) => w.queue.isLocked(r.kind) || !w.queue.isBulk(r.kind))).toBe(true); // only locked or own-button cards are left
    expect(g.errors()).toEqual([]);
  });
});

describe('the one HQ bot: free text is a question, old buttons and commands, strangers and groups', () => {
  it.each(['📥 Одобрения', '📊 Статус', 'задачи', 'что висит?', 'Сколько заявок сегодня?'])('%s is a question: the assistant answers with a link to the Пульт', async (text) => {
    const w2 = await drillWorld({ withServer: false });
    const n = w2.tg.sent.length;
    await w2.say(text);
    await w2.settle();
    const out = w2.tg.sent.slice(n);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain('https://firtech.pro/admin');
    expect(out[0]!.buttons ?? []).toEqual([]);
    expect(w2.chatCalls.length).toBeGreaterThan(0); // the model was asked, with the tools
    expect(w2.chatCalls[0]!.tools!.map((t) => t.name)).toContain('hq_overview');
    expect(g.errors()).toEqual([]);
    await w2.close();
  });
  it('a request to act gets the screen of the Пульт, without a model call and without doing anything', async () => {
    const w2 = await drillWorld({ withServer: false });
    for (const [text, url] of [['Одобри КП для Шифо', 'https://firtech.pro/admin/review'], ['ответь клиенту, что всё готово', 'https://firtech.pro/admin/chats'], ['отметь счёт FT-2026-001 оплаченным', 'panel=backoffice'], ['создай задачу маркетингу', 'panel=director']] as const) {
      const n = w2.tg.sent.length;
      await w2.say(text);
      await w2.settle();
      expect(w2.tg.sent.slice(n).map((m) => m.text).join('\n'), text).toContain(url);
    }
    expect(w2.chatCalls).toHaveLength(0);
    expect(w2.hq.tasks({ limit: 100 }).filter((t) => t.creator === 'owner')).toEqual([]);
    await w2.close();
  });
  it('/start and /pult answer; every old command gets the hint; old buttons answer «в Пульте»; strangers and groups are ignored', async () => {
    const w2 = await drillWorld({ withServer: false });
    const start = await w2.say('/start');
    await w2.settle();
    const reply = start.find((c) => c.method === 'sendMessage')!;
    expect(reply.payload.reply_markup).toEqual({ remove_keyboard: true }); // the old reply keyboard goes away
    expect(String(reply.payload.text)).toContain('Пульт');
    const n = w2.tg.sent.length;
    await w2.say('/pult');
    await w2.settle();
    expect(w2.tg.sent.slice(n).at(-1)!.text).toContain('https://firtech.pro/admin/review');
    for (const old of ['/status', '/approve', '/paid FT-2026-001', '/level lead_reply 1', '/mdone 1 1', '/nope']) {
      const m = w2.tg.sent.length;
      await w2.say(old);
      await w2.settle();
      expect(w2.tg.sent.slice(m).map((x) => x.text).join(' '), old).toContain('Команд в Telegram больше нет');
    }
    for (const data of ['ap:1:a', 'pg:all:0', 'tk:1:o', 'dp:list', 'garbage']) {
      const calls = await w2.press(data);
      expect(JSON.stringify(calls.find((c) => c.method === 'answerCallbackQuery')?.payload ?? {}), data).toContain('Пульте');
    }
    const b2 = w2.tg.sent.length;
    await w2.say('/status', { from: 555 });
    await w2.say('привет', { from: 555 });
    await w2.say('что висит?', { from: OWNER, chat: -100123, type: 'supergroup' });
    await w2.settle();
    expect(w2.tg.sent.length).toBe(b2);
    // the group becomes a supergroup: the topic manager hears it and the glue does not throw
    await w2.bot.handleUpdate({ update_id: 9001, message: { message_id: 5, date: 0, chat: { id: -500, type: 'group', title: 'HQ' }, from: { id: OWNER, is_bot: false, first_name: 'o' }, migrate_to_chat_id: -100500 } } as any);
    expect(g.rejections).toEqual([]);
    expect(g.errors()).toEqual([]);
    await w2.close();
  });

  const intents: [string, string][] = [
    ['task', '{"type":"task","title":"Сделать пост про бота","dept":"marketing","body":"","priority":1,"due":"2026-11-30"}'],
    ['task unknown dept', '{"type":"task","title":"Что-то","dept":"legal","body":"","priority":0,"due":null}'],
    ['status', '{"type":"status","dept":null}'],
    ['status of a dept', '{"type":"status","dept":"sales"}'],
    ['status of a bad dept', '{"type":"status","dept":"zzz"}'],
    ['setting rule', '{"type":"rule","target":"setting","key":"quiet_from","value":"22:00"}'],
    ['bad setting', '{"type":"rule","target":"setting","key":"nope","value":"1"}'],
    ['bad value', '{"type":"rule","target":"setting","key":"summary_time","value":"banana"}'],
    ['instruction rule', '{"type":"rule","target":"instructions","agent_id":"sales-head","text":"Не писать в ночное время"}'],
    ['rule for a missing agent', '{"type":"rule","target":"instructions","agent_id":"ghost","text":"x"}'],
    ['sales reply', '{"type":"sales_reply","id":99999,"text":"Да, интересно"}'],
    ['builder', '{"type":"builder","title":"Нужен новый инструмент","body":"описание"}'],
    ['production command', '{"type":"production_command","command":"pstatus","arg":"1"}'],
    ['production command that is not registered', '{"type":"production_command","command":"rm -rf","arg":""}'],
    ['backoffice command', '{"type":"backoffice_command","command":"kb","arg":"цены"}'],
    ['unknown with a question', '{"type":"unknown","question":"Какой отдел?"}'],
    ['unknown', '{"type":"unknown"}'],
    ['garbage', 'не json вообще'],
    ['wrong shape', '{"type":"task"}'],
  ];
  it.each(intents)('free text parsed as %s is answered', async (_name, reply) => {
    const w2 = await drillWorld({ withServer: false });
    w2.state.intent = () => reply;
    const before = w2.tg.sent.length + w2.channel.list({ limit: 500 }).length;
    await w2.director.onText('сделай что-нибудь, пожалуйста');
    expect(w2.tg.sent.length + w2.channel.list({ limit: 500 }).length, 'free text answered nothing').toBeGreaterThan(before);
    expect(g.rejections).toEqual([]);
    expect(g.errors().map((l) => `${l.msg}: ${String(l.err)}`)).toEqual([]);
    await w2.close();
  });
  it('TG_APPROVAL_CARDS=on (legacy): a rule card: apply, cancel, press again (stale), unknown id', async () => {
    const w2 = await drillWorld({ withServer: false, tgCards: true });
    w2.state.intent = () => '{"type":"rule","target":"setting","key":"summary_time","value":"09:30"}';
    await w2.channel.asReply(() => w2.director.onText('утреннюю сводку в 9:30'));
    await w2.settle();
    const seq = Number(w2.hq.setting('pending_seq'));
    expect(seq).toBeGreaterThan(0);
    expect(answered(await w2.press(`rl:${seq}:y`))).toBe(true);
    expect(w2.hq.setting('summary_time')).toBe('09:30');
    const again = await w2.press(`rl:${seq}:y`);
    expect(JSON.stringify(again.find((c) => c.method === 'answerCallbackQuery')!.payload)).toContain('Уже обработано');
    expect(answered(await w2.press('rl:424242:n'))).toBe(true);
    expect(g.errors()).toEqual([]);
    await w2.close();
  });
  it('the model gateway is down: the question still gets the main numbers said by code, with the link', async () => {
    const w2 = await drillWorld({ withServer: false, gatewayDown: true });
    const n = w2.tg.sent.length;
    await w2.say('что висит?');
    await w2.settle();
    const out = w2.tg.sent.slice(n).at(-1)!.text;
    expect(out).toMatch(/Модель сейчас недоступна/);
    expect(out).toMatch(/ждёт одобрения \d+/);
    expect(out).toContain('https://firtech.pro/admin');
    expect(g.rejections).toEqual([]);
    await w2.close();
  });
});
