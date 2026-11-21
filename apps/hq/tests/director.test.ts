import { describe, expect, it } from 'vitest';
import { appendRule } from '../src/director.js';
import { dailyCron, loadConfig } from '../src/config.js';
import { seedOrg } from '../src/org.js';
import { OWNER, OffLlm, instructionsDir, routedLlm, world } from './helpers.js';

const J = JSON.stringify;

describe('Director: owner messages', () => {
  it('a message for a department becomes a task and wakes the head', async () => {
    const w = world({ llm: routedLlm({ intent: () => J({ type: 'task', title: 'Ролик про барбершоп', dept: 'marketing', priority: 2, due: '2026-11-25' }) }) });
    await w.director.onText('сделай ролик про барбершоп');
    const t = w.hq.tasks({ dept: 'marketing' })[0]!;
    expect(t).toMatchObject({ title: 'Ролик про барбершоп', creator: 'owner', priority: 2, status: 'inbox' });
    expect(t.dueAt).toBe(Date.UTC(2026, 10, 25, 15, 59)); // 23:59 on the owner's clock (Kuala Lumpur, UTC+8)
    expect(w.hq.pendingHeartbeats()).toBe(1);
    const live = w.messenger.last()!;
    expect(live.text).toContain(`#${t.id} Маркетинг: «Ролик про барбершоп»`);
    expect(live.text).toContain('✅ принял');
    expect(live.text).toContain('Маркетинг взял задачу');
    expect(live.text).toContain('Я обновлю это сообщение');
  });

  it('an unknown department creates nothing', async () => {
    const w = world({ llm: routedLlm({ intent: () => J({ type: 'task', title: 'X', dept: 'legal' }) }) });
    await w.director.onText('юристам');
    expect(w.hq.tasks()).toHaveLength(0);
    expect(w.messenger.last()!.text).toContain('Не нашёл отдел');
  });

  it('"нужен строитель" makes a blocked task tagged builder, in the director department', async () => {
    const w = world({ llm: routedLlm({ intent: () => J({ type: 'builder', title: 'Интеграция с Kaspi' }) }) });
    await w.director.onText('нужна интеграция с Kaspi');
    expect(w.hq.tasks({ status: 'blocked' })[0]).toMatchObject({ title: 'Интеграция с Kaspi', dept: 'hq', tags: ['builder'] });
    expect(w.messenger.last()!.text).toContain('строителя');
  });

  it('a status question answers from the data; unknown asks back; garbage and LLM off are handled', async () => {
    const w = world({ llm: routedLlm({ intent: (t) => (t.includes('как дела') ? J({ type: 'status', dept: 'marketing' }) : t.includes('хм') ? J({ type: 'unknown', question: 'какой отдел?' }) : 'мусор') }) });
    w.hq.createTask({ title: 'Открытая', dept: 'marketing', creator: 'owner' });
    await w.director.onText('как дела в маркетинге');
    expect(w.messenger.last()!.text).toContain('Открытая');
    await w.director.onText('хм');
    expect(w.messenger.last()!.text).toBe('Уточните: какой отдел?');
    await w.director.onText('что-то');
    expect(w.messenger.last()!.text).toContain('Не смог разобрать');
    const off = world({ llm: new OffLlm() });
    await off.director.onText('привет');
    expect(off.messenger.last()!.text).toContain('Не смог разобрать');
  });
});

describe('Director: rule changes need the button', () => {
  it('a setting is written only after "Применить", and the card has two buttons', async () => {
    const w = world({ llm: routedLlm({ intent: () => J({ type: 'rule', target: 'setting', key: 'summary_time', value: '07:30' }) }) });
    await w.director.onText('сводку присылай в 7:30');
    const card = w.messenger.last()!;
    expect(card.text).toContain('«08:00» → «07:30»');
    expect(w.hq.setting('summary_time')).toBe('08:00');
    const seq = Number(/rl:(\d+):y/.exec(card.buttons![0]![0]!.data)![1]);
    expect(await w.director.onRuleButton(seq, true)).toBe('Применено');
    expect(w.hq.setting('summary_time')).toBe('07:30');
    expect(await w.director.onRuleButton(seq, true)).toBe('Уже обработано');
    w.director.stop();
  });

  it('cancel writes nothing; unknown keys and bad values are refused before any card', async () => {
    let n = 0;
    const replies = [
      J({ type: 'rule', target: 'setting', key: 'tz', value: 'Asia/Samarkand' }),
      J({ type: 'rule', target: 'setting', key: 'hq_secret', value: 'x' }),
      J({ type: 'rule', target: 'setting', key: 'approval_time', value: '25:99' }),
    ];
    const w = world({ llm: routedLlm({ intent: () => replies[n++]! }) });
    await w.director.onText('a');
    const seq = Number(/rl:(\d+):n/.exec(w.messenger.last()!.buttons![0]![1]!.data)![1]);
    expect(await w.director.onRuleButton(seq, false)).toBe('Отменено');
    expect(w.hq.tz).toBe('Asia/Dushanbe');
    const before = w.messenger.sent.length;
    await w.director.onText('b');
    await w.director.onText('c');
    expect(w.messenger.sent.slice(before).every((m) => !m.buttons)).toBe(true);
    expect(w.messenger.last()!.text).toContain('не подходит');
    expect(w.hq.setting('hq_secret')).toBe('');
  });

  it('an instruction rule is appended under "Правила владельца" after the button; the rest stays', async () => {
    const w = world({ llm: routedLlm({ intent: () => J({ type: 'rule', target: 'instructions', agent_id: 'marketing-head', text: 'Не используй слово «бесплатно»' }) }) });
    const before = w.hq.agent('marketing-head')!.instructions;
    await w.director.onText('маркетинг: не говори бесплатно');
    expect(w.hq.agent('marketing-head')!.instructions).toBe(before);
    const seq = Number(/rl:(\d+):y/.exec(w.messenger.last()!.buttons![0]![0]!.data)![1]);
    await w.director.onRuleButton(seq, true);
    const after = w.hq.agent('marketing-head')!.instructions;
    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after).toContain('## Правила владельца\n- Не используй слово «бесплатно»');
    expect(w.hq.activity().some((a) => a.action === 'instructions_changed')).toBe(true);
  });

  it('appendRule adds lines to an existing section', () => {
    const once = appendRule('# A\n\ntext', 'one');
    const twice = appendRule(`${once}\n## После\nконец`, 'two');
    expect(twice).toContain('## Правила владельца\n- one\n- two');
    expect(twice).toContain('## После\nконец');
  });
});

describe('Director: commands, summary, batch, alerts', () => {
  it('/status /tasks /org /costs /pause /resume', async () => {
    const w = world();
    w.hq.createTask({ title: 'Задача А', dept: 'marketing', creator: 'owner' });
    await w.director.onCommand('status');
    expect(w.messenger.last()!.text).toContain('Маркетинг: работает 1 · ждут вас 0 · застряли 0');
    await w.director.onCommand('tasks', 'marketing');
    expect(w.messenger.last()!.text).toContain('Задача А');
    await w.director.onCommand('tasks', 'nope');
    expect(w.messenger.last()!.text).toContain('Нет отдела');
    await w.director.onCommand('org');
    expect(w.messenger.last()!.text).toContain('marketing/marketing-head: Голова маркетинга, голова');
    await w.director.onCommand('costs');
    expect(w.messenger.last()!.text).toContain('marketing: $0.00 (без лимита)');
    await w.director.onCommand('pause', 'marketing');
    expect(w.hq.agent('marketing-head')!.status).toBe('paused');
    await w.director.onCommand('status');
    expect(w.messenger.last()!.text).toContain('Маркетинг (пауза)');
    await w.director.onCommand('resume', 'marketing');
    expect(w.hq.agent('marketing-head')!.status).toBe('active');
    await w.director.onCommand('pause', 'x');
    expect(w.messenger.last()!.text).toContain('Укажите отдел');
    await w.director.onCommand('help');
    expect(w.messenger.last()!.text).toContain('/approve');
  });

  it('the morning summary is one message: reports, approvals, blocked, costs, held alerts', async () => {
    const w = world({ groupTopics: true });
    const t = w.hq.createTask({ title: 'Пакет', dept: 'marketing', creator: 'routine' });
    w.hq.addEvent(t.id, 'report', 'marketing-head', 'Пакет недели готов: 8 материалов');
    const b = w.hq.createTask({ title: 'Сломанная', dept: 'marketing', creator: 'owner' });
    w.hq.block(b.id, 'marketing-head', 'x');
    w.hq.recordCost({ agentId: 'content-maker', model: 'm', inputTokens: 1, outputTokens: 1, usd: 0.25 });
    w.hq.setSetting('held_alerts', J(['ночной инцидент']));
    const before = w.messenger.sent.length;
    await w.director.sendMorningSummary();
    expect(w.messenger.sent.length - before).toBe(1);
    const text = w.messenger.last()!.text;
    expect(text).toContain('Утренняя сводка, 18.11');
    expect(text).toContain('marketing: Пакет недели готов');
    expect(text).toContain(`#${b.id} marketing: Сломанная`);
    expect(text).toContain('marketing $0.25');
    expect(text).toContain('ночной инцидент');
    expect(w.posted.find((p) => p.threadId === 2)?.text).toContain('Утренняя сводка'); // mirrored into "general"
    expect(w.hq.setting('held_alerts')).toBe('[]');
  });

  it('alerts go out at once, and wait for the summary in quiet hours', async () => {
    const w = world();
    await w.hq.alert('диск почти полон');
    expect(w.messenger.last()!.text).toBe('Алерт: диск почти полон');
    w.hq.setSetting('quiet_hours', '14:00-16:00'); // the owner's clock: the test clock is 15:00 in Kuala Lumpur
    const n = w.messenger.sent.length;
    await w.hq.alert('ночью упал сервис');
    expect(w.messenger.sent).toHaveLength(n);
    expect(w.director.morningSummary()).toContain('ночью упал сервис');
  });

  it('/approve with nothing says so; the batch sends everything queued as a numbered series', async () => {
    const w = world();
    await w.director.onCommand('approve');
    expect(w.messenger.last()!.text).toBe('Нечего одобрять.');
    w.hq.registerKind('post', { initialLevel: 0, execute: () => Promise.resolve() });
    for (const title of ['A', 'B']) {
      const t = w.hq.createTask({ title, dept: 'marketing', creator: 'owner' });
      w.hq.claim(t.id, 'marketing-head');
      await w.hq.requestApproval(t.id, 'marketing-head', 'post', { text: title }, `карточка ${title}`);
    }
    expect(await w.director.sendApprovalBatch(false)).toBe(2);
    const texts = w.messenger.sent.map((m) => m.text);
    expect(texts.some((x) => x.startsWith('Пачка на одобрение: 2'))).toBe(true);
    expect(texts.some((x) => x.includes('[1/2] marketing') && x.includes('карточка A'))).toBe(true);
    expect(texts.some((x) => x.includes('[2/2] marketing'))).toBe(true);
    await w.director.onCommand('approve');
    expect(w.messenger.last()!.text).toContain('Ждут вашего решения ранее присланные: 2');
  });
});

describe('org and config', () => {
  it('seedOrg creates director, head, workers and routines once; edits survive a second start', () => {
    const w = world();
    expect(w.hq.agents().map((a) => a.id)).toEqual(['director', 'marketing-head', 'analyst', 'content-maker', 'publisher', 'seo', 'trend-scout']);
    expect(w.hq.agent('director')!.instructions).toContain('Директор Fir Tech');
    expect(w.hq.agent('marketing-head')).toMatchObject({ bot: 'MARKETING_BOT_TOKEN', bossId: 'director' });
    expect(w.hq.routines().map((r) => [r.name, r.cron])).toEqual([
      ['marketing-weekly-pack', '0 6 * * 1'], ['marketing-daily-today', '0 9 * * *'], ['marketing-trends-daily', '30 7 * * *'],
      ['marketing-trends-weekly', '0 20 * * 0'], ['marketing-analyst-weekly', '0 7 * * 1'], ['marketing-article-daily', '30 7 * * *'], ['marketing-seo-weekly', '30 7 * * 1'],
    ]);
    w.hq.setInstructions('marketing-head', 'edited');
    w.hq.scheduleRoutine({ ...w.hq.routineByName('marketing-daily-today')!, cron: '0 10 * * *' });
    seedOrg(w.hq, { instructionsDir, marketingBudgetUsd: 0 });
    expect(w.hq.agent('marketing-head')!.instructions).toBe('edited');
    expect(w.hq.routineByName('marketing-daily-today')!.cron).toBe('0 10 * * *');
  });

  it('config: required vars, group and topics, bad values', () => {
    const base = { HQ_BOT_TOKEN: 't', OWNER_TELEGRAM_ID: '1' };
    const c = loadConfig({ ...base, HQ_GROUP_ID: '-100123', HQ_TOPICS: '{"general":2,"marketing":3}', MARKETING_BOT_TOKEN: 'm', SALES_BOT_TOKEN: 's', CONTENT_BOT_TOKEN: 'c' });
    // the department bots are retired (2026-11-22): their tokens are only named in one log line, never used; cards and group reports are off
    expect(c).toMatchObject({ botToken: 't', ownerId: 1, groupId: -100123, topics: { general: 2, marketing: 3 }, retiredBots: ['MARKETING_BOT_TOKEN', 'SALES_BOT_TOKEN', 'CONTENT_BOT_TOKEN'], tgApprovalCards: false, tgGroupReports: false, clipsPerWeek: 7, carouselsPerWeek: 2, postsPerWeek: 3, storiesPerWeek: 5 });
    expect(JSON.stringify(c)).not.toMatch(/"m"|"s"|"c"/);
    expect(loadConfig({ ...base, TG_APPROVAL_CARDS: 'on', TG_GROUP_REPORTS: 'ON' })).toMatchObject({ retiredBots: [], tgApprovalCards: true, tgGroupReports: true });
    expect(loadConfig(base).groupId).toBeUndefined();
    expect(loadConfig(base)).toMatchObject({ trendsRegions: ['KZ', 'UZ', 'RU'], siteUrl: 'https://firtech.pro', youtubeApiKey: undefined, gscSiteUrl: undefined });
    expect(loadConfig({ ...base, TRENDS_REGIONS: 'kz, uz ,bad', SITE_URL: 'https://example.com/' })).toMatchObject({ trendsRegions: ['KZ', 'UZ'], siteUrl: 'https://example.com' });
    expect(() => loadConfig({ OWNER_TELEGRAM_ID: '1' })).toThrow(/HQ_BOT_TOKEN/);
    expect(() => loadConfig({ ...base, HQ_TOPICS: 'nope' })).toThrow(/HQ_TOPICS/);
    expect(() => loadConfig({ ...base, HQ_GROUP_ID: 'abc' })).toThrow(/HQ_GROUP_ID/);
    expect(() => loadConfig({ ...base, CLIPS_PER_WEEK: '9' })).toThrow(/CLIPS_PER_WEEK/);
    expect(() => loadConfig({ ...base, POSTS_PER_WEEK: '9' })).toThrow(/POSTS_PER_WEEK/);
    expect(loadConfig({ ...base, POSTS_PER_WEEK: '1', STORIES_PER_WEEK: '0', DATA_DIR: '/d' })).toMatchObject({ postsPerWeek: 1, storiesPerWeek: 0, rendersDir: '/d/renders' });
    expect(dailyCron('08:00')).toBe('0 8 * * *');
    expect(dailyCron('7:05')).toBe('5 7 * * *');
    expect(() => dailyCron('25:00')).toThrow();
    expect(OWNER).toBe(100);
  });
  it('/builder <id> hands an existing task to the builders; bad ids and closed tasks are refused', async () => {
    const w = world();
    const t = w.hq.createTask({ title: 'Исправление ошибки на проде', dept: 'production', creator: 'owner' });
    await w.director.onCommand('builder', String(t.id));
    expect(w.hq.task(t.id)).toMatchObject({ status: 'blocked', tags: ['builder'], meta: { kind: 'adhoc' } });
    expect(w.messenger.last()!.text).toContain('передана строителям');
    await w.director.onCommand('builder', String(t.id));
    expect(w.messenger.last()!.text).toContain('уже у строителей');
    await w.director.onCommand('builder', 'abc');
    expect(w.messenger.last()!.text).toContain('Укажите номер');
    w.hq.setStatus(t.id, 'rejected', 'owner', 'не нужно');
    await w.director.onCommand('builder', String(t.id));
    expect(w.messenger.last()!.text).toContain('уже закрыта');
  });
});
