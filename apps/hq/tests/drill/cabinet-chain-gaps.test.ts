/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { PmStore } from '@fir/worker-project-manager';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBuilderPlan, wantsPlayground } from '../../src/builder-plan.js';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

/**
 * The cabinet chain gaps (2026-11-22): the client SEES every step. A finished stage and an accepted stage reach his project thread and his email, the last one
 * closes the project with an act; the playground agent is made when he accepts a КП that has it and goes live with the first payment; a lead from the
 * Telegram bot gets the sign-up link and his papers join the account when he signs up with the same email.
 */
const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

const EMAIL = 'dilya.gaps@example.com';
const LINK = 'https://firtech.pro/ru/builder?b=k.salon~p.agent~g.answer24~l.telegram-playground~z.no';
const LEAD = { name: 'Диля Gaps', contact: '@dilya_gaps', service: 'bots', budget: '$300-500', message: 'Нужен агент для салона', estimate: `Ниша: салон красоты\nЦели: запись клиентов; ответы\nСборка: ${LINK}`, locale: 'ru', source: 'miniapp', clientEmail: EMAIL, cabinetId: 'sb-gaps', clientName: 'Диля' };

const review = async (kind: string) => ((await w.adm('GET', '/admin/review?status=pending&limit=200')).json.items as any[]).filter((i) => i.kind === kind);
async function approvePack(): Promise<void> {
  await w.director.sendApprovalBatch(false);
  const it = (await review('presales_pack'))[0];
  expect(it).toBeDefined();
  expect((await w.adm('POST', `/admin/review/${it.id}`, { action: 'approve' })).status).toBe(200);
}
async function approveByButton(kind: string): Promise<void> {
  await w.director.sendApprovalBatch(false);
  const row = w.queue.pending().find((r) => r.kind === kind);
  expect(row, `no ${kind} card waits`).toBeDefined();
  await w.decide('approve', row!.id);
}
/** A lead of a signed-in client up to the approved КП; returns the ids. */
async function toQuote(lead: Record<string, unknown> = LEAD) {
  w = await drillWorld({ flow: true });
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  const r = await w.http('POST', '/lead', lead, { 'x-lead-token': TOKENS.lead });
  const { leadId } = (await r.json()) as any;
  await w.beat();
  await w.beat();
  await approvePack();
  await w.cabinet!.docs.idle();
  const cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
  const cid = cab.client.id as number;
  const quote = ((await w.adm('GET', `/admin/clients/${cid}/documents`)).json.items as any[]).find((d) => d.kind === 'quote');
  // the project is reserved only when the client accepts the КП (P-10, 2026-11-22)
  expect(cab.projects).toEqual([]);
  return { leadId: leadId as number, cid, quote };
}
/** The client accepts the КП: the project is reserved now; returns its id. */
async function acceptQuote(cid: number, quoteId: number): Promise<number> {
  expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quoteId}/accept`)).status).toBe(200);
  const cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
  return cab.projects[0].id as number;
}
const threadMsgs = async (cid: number, id: string) => (await w.adm('GET', `/admin/clients/${cid}/threads/${id}/messages`)).json.items as any[];
const unreadOf = async (cid: number, id: string) => ((await w.adm('GET', `/admin/clients/${cid}/threads`)).json.items as any[]).find((t) => t.id === id)?.unread as number;
const inboxTitles = async () => ((await w.adm('GET', '/admin/hub')).json.inbox as any[]).map((i) => i.title as string);

describe('the builder link: delivery and site need', () => {
  it('reads the l. and z. chunks, drops unknown ids, tolerates an encoded link and a missing one', () => {
    expect(parseBuilderPlan(LINK)).toEqual({ delivery: ['telegram', 'playground'], siteNeed: 'no' });
    expect(parseBuilderPlan('x', 'Сборка: /en/builder/estimate?b=k.cafe~l.none~z.have')).toEqual({ delivery: [], siteNeed: 'have' });
    expect(parseBuilderPlan('/ru/builder?b=k.cafe%7El.widget-bogus%7Ez.maybe')).toEqual({ delivery: ['widget'], siteNeed: null });
    expect(parseBuilderPlan('Хочу бота', '')).toEqual({ delivery: null, siteNeed: null });
    expect(wantsPlayground(parseBuilderPlan(LINK), 'site')).toBe(true);
    expect(wantsPlayground({ delivery: ['telegram'], siteNeed: 'no' }, 'agent')).toBe(true);
    expect(wantsPlayground({ delivery: ['telegram'], siteNeed: 'need' }, 'agent')).toBe(false);
    expect(wantsPlayground({ delivery: null, siteNeed: 'no' }, 'site')).toBe(false);
    expect(wantsPlayground({ delivery: null, siteNeed: null }, 'agent')).toBe(false);
  });
});

describe('every stage step reaches the client: thread line, unread flag, email, act', () => {
  it('ready for acceptance, accepted with the next stage, the last one closes the project with an act; nothing twice, nothing without a cabinet', async () => {
    const { cid, quote } = await toQuote();
    const projectId = await acceptQuote(cid, quote.id);
    const pm = new PmStore(w.db, w.hq.now);
    const stages = pm.stageMilestones(projectId);
    expect(stages.length).toBeGreaterThan(1);
    const before = w.emails.length;
    const tick = async (no: number) => {
      const m = pm.stageMilestone(projectId, no)!;
      pm.markStagePaid(m.id, `FT-T-${no}`);
      expect(pm.markDone(m.id)).toBe(true);
      (w.production as any).afterMilestone(projectId, pm.stageMilestone(projectId, no)!);
      await w.cabinet!.docs.idle();
    };

    // stage 1 finished: a line in the project thread, the tab's unread flag, an email with a link and no text of the work
    await tick(1);
    let lines = (await threadMsgs(cid, `project-${projectId}`)).map((m) => m.text as string);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Этап 1 «.+» готов к приёмке: откройте вкладку «Проекты» и нажмите «Принять этап»\.$/);
    expect(await unreadOf(cid, `project-${projectId}`)).toBe(1);
    expect(w.emails).toHaveLength(before + 1);
    expect(w.emails.at(-1)).toMatchObject({ to: EMAIL, subject: 'Этап 1 готов к приёмке' });
    expect(w.emails.at(-1)!.text).toContain('https://firtech.pro/ru/cabinet');
    // the client reads it: the flag drops
    expect((await w.adm('POST', `/admin/clients/${cid}/threads/project-${projectId}/read`)).status).toBe(200);
    expect(await unreadOf(cid, `project-${projectId}`)).toBe(0);
    w.clock.t += 1000;

    // he accepts: the confirmation names the next stage and says the invoice is being prepared (it is only proposed to the owner here)
    const acc = await w.adm('POST', `/admin/clients/${cid}/projects/${projectId}/milestones/1/accept`);
    expect(acc.status, acc.text).toBe(200);
    await w.cabinet!.docs.idle();
    lines = (await threadMsgs(cid, `project-${projectId}`)).map((m) => m.text as string);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Этап 1 принят\. Следующий этап: 2 «.+»\. Счёт на него готовим, он придёт в раздел «Документы» и на почту\.$/);
    expect(w.emails.at(-1)!.subject).toBe('Этап 1 принят');
    expect(await unreadOf(cid, `project-${projectId}`)).toBe(1);
    // accepting twice does nothing twice
    await w.adm('POST', `/admin/clients/${cid}/projects/${projectId}/milestones/1/accept`);
    await w.cabinet!.docs.idle();
    expect(await threadMsgs(cid, `project-${projectId}`)).toHaveLength(2);

    // the middle stages, then the last: the project closes with an act in his Documents
    for (let no = 2; no < stages.length; no++) {
      await tick(no);
      await w.adm('POST', `/admin/clients/${cid}/projects/${projectId}/milestones/${no}/accept`);
      await w.cabinet!.docs.idle();
    }
    const last = stages.length;
    expect(((await w.adm('GET', `/admin/clients/${cid}/documents`)).json.items as any[]).some((d) => d.kind === 'act')).toBe(false);
    await tick(last);
    const done = await w.adm('POST', `/admin/clients/${cid}/projects/${projectId}/milestones/${last}/accept`);
    expect(done.status, done.text).toBe(200);
    await w.cabinet!.docs.idle();
    lines = (await threadMsgs(cid, `project-${projectId}`)).map((m) => m.text as string);
    expect(lines.at(-1)).toBe(`Этап ${last} принят. Проект завершён, спасибо! Акт сдачи-приёмки в разделе «Документы».`);
    expect(w.emails.at(-1)!.subject).toBe('Проект завершён');
    expect(pm.project(projectId)!.status).toBe('done');
    const docs = (await w.adm('GET', `/admin/clients/${cid}/documents`)).json.items as any[];
    const acts = docs.filter((d) => d.kind === 'act');
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ state: 'issued', number: `АКТ-${projectId}`, projectId, acceptedAt: expect.any(String), pdfUrl: expect.stringMatching(/\/act-\d+\.pdf\?e=\d+$/) });
    const body = (w.db.prepare("SELECT body FROM cab_documents WHERE kind = 'act'").get() as { body: string }).body;
    expect(body).toContain('Акт сдачи-приёмки');
    expect(body).not.toMatch(/\[заполнить|____/);
    expect(body).toContain(`- Этап ${last}:`);
    const pdf = await w.http('GET', acts[0].pdfUrl.replace(/^https:\/\/hq\.test/, ''));
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    // a manual «акт» approved by the owner afterwards for the same project is not a second one
    await w.cabinet!.docs.onDocApproved({ id: 9001, type: 'act', client: 'Диля', version: 1, text: 'Акт № 1', taskId: null });
    expect(((await w.adm('GET', `/admin/clients/${cid}/documents`)).json.items as any[]).filter((d) => d.kind === 'act')).toHaveLength(1);
    expect(g.errors()).toEqual([]);
  }, 120_000);

  it('a project of a lead without a cabinet account says nothing to anybody and the owner still gets the /doc hint', async () => {
    w = await drillWorld({ flow: true });
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    await w.http('POST', '/lead', { ...LEAD, clientEmail: undefined, cabinetId: undefined, clientName: undefined, contact: 'plain-gaps@example.com' }, { 'x-lead-token': TOKENS.lead });
    await w.beat();
    await w.beat();
    await approvePack();
    const pm = new PmStore(w.db, w.hq.now);
    const p = w.db.prepare('SELECT id FROM pm_projects').get() as { id: number };
    const before = w.emails.length;
    const stages = pm.stageMilestones(p.id);
    for (const s of stages) {
      pm.markStagePaid(s.id, `FT-N-${s.stageNo}`);
      pm.markDone(s.id);
    }
    (w.production as any).afterMilestone(p.id, pm.stageMilestone(p.id, 1)!);
    for (const s of stages) {
      const r = w.production.acceptStage(p.id, s.stageNo!, 'owner');
      if (s.stageNo === stages.length) expect(r.text).toContain('/doc акт');
    }
    await w.cabinet!.docs.idle();
    expect(w.emails.length).toBe(before);
    expect(w.db.prepare("SELECT COUNT(*) n FROM cab_tmsgs WHERE thread LIKE 'project-%'").get()).toEqual({ n: 0 });
    expect(w.db.prepare("SELECT COUNT(*) n FROM cab_documents WHERE kind = 'act'").get()).toEqual({ n: 0 });
  }, 60_000);
});

describe('the playground agent: made with the accepted КП, live with the first payment', () => {
  it('accepting a КП whose build lists the playground makes the demo agent at once; the first payment makes it live; the owner sees both; once', async () => {
    const { cid, leadId, quote } = await toQuote();
    expect(((await w.adm('GET', `/admin/clients/${cid}/agents`)).json.items as any[])).toEqual([]); // the КП alone makes nothing
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/accept`)).status).toBe(200);
    const agents = (await w.adm('GET', `/admin/clients/${cid}/agents`)).json.items as any[];
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ state: 'draft', mode: 'demo', leadId, company: 'Диля Gaps', niche: 'салон красоты', limits: { msgsPerDay: 50 }, goals: ['запись клиентов', 'ответы'] });
    expect(agents[0].persona).toContain('салон красоты');
    // his tab is there: the agent thread with the line that explains what he can do now
    const th = ((await w.adm('GET', `/admin/clients/${cid}/threads`)).json.items as any[]).find((t) => t.id === `agent-${agents[0].id}`);
    expect(th).toMatchObject({ kind: 'agent', unread: 1 });
    const demoLines = (await threadMsgs(cid, `agent-${agents[0].id}`)).map((m) => m.text as string);
    expect(demoLines[0]).toContain('демо-режиме');
    expect(demoLines[0]).toContain('после оплаты первого этапа');
    // the demo does not answer the public route yet
    expect((await w.http('POST', `/agent/${agents[0].publicId}/chat`, { text: 'Привет' }, { authorization: 'Bearer nope' })).status).not.toBe(200);
    // the owner's Пульт inbox
    expect((await inboxTitles()).some((t) => /Агент «.+» клиента Диля создан в демо-режиме/.test(t))).toBe(true);

    // the first payment: simulated on the invoice document row that the paid hook reads (the whole invoice chain is drilled in cabinet-flow)
    w.db.prepare("INSERT INTO cab_documents (client_id, kind, title, number, lead_id, state, src, src_id, stage_no, created_at) VALUES (?, 'invoice', 'Счёт', 'FT-G-1', ?, 'issued', 'bl', 4242, 1, 1)").run(cid, leadId);
    w.cabinet!.docs.onPaid({ id: 4242, number: 'FT-G-1', leadId, stageNo: 1 });
    expect(((await w.adm('GET', `/admin/clients/${cid}/agents`)).json.items as any[])[0]).toMatchObject({ state: 'live', mode: 'live', limits: { msgsPerDay: 500 } });
    const lines = (await threadMsgs(cid, `agent-${agents[0].id}`)).map((m) => m.text as string);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('включён в рабочий режим');
    w.clock.t += 6000; // the hub is cached for 5 s
    expect((await inboxTitles()).some((t) => /Агент «.+» клиента Диля включён в рабочий режим/.test(t))).toBe(true);
    // a second payment event or a second accept changes nothing
    w.cabinet!.docs.onPaid({ id: 4242, number: 'FT-G-1', leadId, stageNo: 1 });
    expect((await threadMsgs(cid, `agent-${agents[0].id}`))).toHaveLength(2);
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/accept`)).status).toBe(409);
    expect(((await w.adm('GET', `/admin/clients/${cid}/agents`)).json.items as any[])).toHaveLength(1);
    // a payment of stage 2 does not touch anything (already live; a draft agent would stay draft)
    expect(g.errors()).toEqual([]);
  }, 120_000);

  it('an agent product without a site (z.no) gets the agent without the playground chip; a КП without either gets none', async () => {
    const { cid, quote } = await toQuote({ ...LEAD, source: 'agent', estimate: 'Ниша: клиника\nСборка: https://firtech.pro/ru/builder?b=k.clinic~p.agent~l.telegram~z.no' });
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/accept`)).status).toBe(200);
    expect(((await w.adm('GET', `/admin/clients/${cid}/agents`)).json.items as any[])).toHaveLength(1);
    await w.close();

    const plain = await toQuote({ ...LEAD, source: 'agent', estimate: 'Сборка: https://firtech.pro/ru/builder?b=k.clinic~p.agent~l.telegram~z.need' });
    expect((await w.adm('POST', `/admin/clients/${plain.cid}/documents/${plain.quote.id}/accept`)).status).toBe(200);
    expect(((await w.adm('GET', `/admin/clients/${plain.cid}/agents`)).json.items as any[])).toEqual([]);
  }, 120_000);
});

describe('a lead from the Telegram bot (no account): the sign-up link, and the papers follow the account', () => {
  it('the papers the owner sends by hand carry the cabinet link with the same email; signing up with it attaches the papers', async () => {
    w = await drillWorld({ flow: true });
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    const email = 'tg.lead@example.com';
    await w.http('POST', '/lead', { ...LEAD, clientEmail: undefined, cabinetId: undefined, clientName: undefined, contact: email, estimate: '' }, { 'x-lead-token': TOKENS.lead });
    await w.beat();
    await w.beat();
    await w.director.sendApprovalBatch(false);
    // «Скопировать документы» on the КП pack card: the papers, then the line with the link
    const pack = w.queue.pending().find((r) => r.kind === 'presales_pack')!;
    const before = w.ownerSaw();
    await w.sales.onCopy(pack.id);
    const copy = w.ownerSaw().slice(before.length);
    expect(copy).toContain(`https://firtech.pro/ru/cabinet/login?email=${encodeURIComponent(email)}`);
    expect(copy).toContain(`Зарегистрируйтесь с той же почтой, ${email}`);
    await approvePack();
    await w.beat();
    // the contract: filled and approved, the owner gets the text with the link under it
    await w.director.sendApprovalBatch(false);
    const row = w.queue.pending().find((r) => r.kind === 'bo_document')!;
    await w.queue.applyEdit(row.id, String(row.payload.text).replace('[срок]', '20 рабочих дней'));
    const mark = w.ownerSaw().length;
    await approveByButton('bo_document');
    expect(w.ownerSaw().slice(mark)).toContain('/cabinet/login?email=tg.lead%40example.com');
    // the invoice too
    await w.beat();
    const mark2 = w.ownerSaw().length;
    await approveByButton('billing_invoice');
    expect(w.ownerSaw().slice(mark2)).toContain('/cabinet/login?email=tg.lead%40example.com');
    expect(w.emails).toEqual([]); // nothing goes to him by HQ: no account yet

    // he signs up with the same email: the lead is linked and the papers join the account
    const reg = await w.adm('POST', '/admin/clients', { email, name: 'Тг Лид', supabaseId: 'sb-tg' });
    expect(reg.json).toMatchObject({ ok: true, linkedLeads: 1 });
    const cid = reg.json.client.id as number;
    const docs = (await w.adm('GET', `/admin/clients/${cid}/documents`)).json.items as any[];
    expect(docs.map((d) => d.kind).sort()).toEqual(['contract', 'invoice', 'other', 'quote']);
    expect(docs.find((d) => d.kind === 'quote')).toMatchObject({ state: 'issued', title: 'Коммерческое предложение' });
    expect(docs.find((d) => d.kind === 'contract')).toMatchObject({ state: 'issued' });
    expect(docs.find((d) => d.kind === 'invoice')).toMatchObject({ state: 'issued', stageNo: 1, payUrl: expect.stringMatching(/^https:\/\/firtech\.pro\/ru\/pay\/FT-/) });
    // nothing to accept or sign here: the client is not asked to do a step twice
    const cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(email)}`)).json;
    expect(cab.projects[0].nextAction.kind).toBe('pay_stage');
    // idempotent: the next read adds nothing, the old list under `documents` does not repeat the papers
    expect(((await w.adm('GET', `/admin/clients/${cid}/documents`)).json.items as any[])).toHaveLength(4);
    expect(cab.documents.filter((d: any) => d.source !== 'billing')).toEqual([]);
    expect(w.emails).toEqual([]);
    await w.cabinet!.docs.idle();
    expect(g.errors()).toEqual([]);
  }, 120_000);
});
