import { errMsg, formatSlot, log, okv, tryChat, tryComplete, turnToolUses } from '@fir/core';
import {
  applyGuards, builderLink as builderLinkStub, DEFAULT_ESCALATION_MODE, DEMO_PAGE_KINDS, demoLinkDef, escalationOf, firtechGuardContext, InMemoryJournal, InMemoryKnowledge,
  InMemoryLessons, InMemoryMemory, isProbe, leakGuard, loadCompanyKnowledge, nicheBrief, nicheOfKind, priceList, recordBriefDef, run, specOf,
  type AgentSpec, type Escalation, type EscalationMode, type FiraTool, type Journal, type Knowledge, type Lessons, type Memory, type MemTurn, type Mode, type RunOut, type ToolRegistry,
} from '@fir/fira';
import { BUILD_CHANNELS, BUILD_GOALS, BUILDER_KINDS, builderPath, DETAIL_DEADLINES } from './builder-link.js';
import { asksCatalogue } from './needs.js';
import { CLASSIC_IDS, KIND_LABELS, PRODUCT_IDS, PRODUCTS } from './products.js';
import {
  briefOf, buildOf, isEnough, lintReply, MAX_QUALIFY_TURNS, merge, needReply, nextSlot, normalizeQ, prepareTurn, productsNamed, rewriteRequest, SITE_ORIGIN, SLOT_ASK,
  slotsKnown, withoutTrailingQuestion, withTimeout, HANDOFF, type QState, type ReceptionistDeps, type ReceptionistIn, type ReceptionistOut, type ReplyOut,
} from './receptionist.js';
import { T, type Lang } from './texts.js';

/**
 * ИИ-менеджер заявок on Fira (шаг 1 миграции, `docs/fira-migration-lead-manager.md`; включается `FIRA_LEAD_MANAGER=on`). The code still owns the state
 * (`QState`), the links, the prices and the order of the offers; Fira's `run()` writes the words with native tools instead of the JSON contract:
 * - the code paths of `prepareTurn` (person, client, window, price, offers asked for, a changed link) are the `before` rule: the same code and the same
 *   answer, no model; the turn still goes into the conversation's memory and the journal;
 * - the model step: the lead manager spec (role × niche × company, the catalogue without prices in the cached block), a per-turn note (what is known,
 *   ask / propose / answer, the visitor's niche brief), the whole conversation from Fira's memory, the tools `price_list`, `builder_link`, `call_slots`,
 *   `record_brief`, `demo_link`, `knowledge_search` (the company pack), `capture_contact`, `handoff_owner`;
 * - `after`: three questions at most, one question per reply, the offers in their order (builder → call → Telegram on request) through `compose`, no
 *   links or sums of the model (the code adds them), the anti-stamp rewrite once, no repeat of an earlier reply, the escalation policy.
 * Logs carry ids and counts only.
 */

export interface FiraLeadOptions {
  now: () => number;
  /** The owner's choice of escalation (`settings.autopilot.leadManager`); default `policy`. */
  mode?: () => EscalationMode;
  /** One line to the owner (HQ: `hq.alert(line, { kind: 'human', short })`). Never throws into the turn. */
  escalate?: (e: Escalation & { channel: 'web' | 'telegram' }) => void | Promise<void>;
  /** Names of the company's clients, for the leak guard (the visitor's own name is dropped per turn). */
  clientNames?: () => readonly string[];
  /** The lead's draft agent of the playground for `demo_link` (when the conversation already is a lead); null: the niche page of the site. */
  demoLink?: (q: QState, lang: Lang) => string | null;
  knowledge?: Knowledge;
  memory?: Memory;
  lessons?: Lessons;
  journal?: Journal;
  /** Haiku reads what the visitor said when the dialogue model did not call `record_brief` (default true). */
  extract?: boolean;
}

export interface FiraLead {
  turn(d: ReceptionistDeps, i: ReceptionistIn): Promise<ReceptionistOut>;
  /** Loads the company pack into the knowledge store again (a new image, the nightly rebuild); returns the number of chunks. */
  reload(): Promise<number>;
  readonly stores: { knowledge: Knowledge; memory: Memory; lessons: Lessons; journal: Journal };
}

export { registerFiraLead, registeredFiraLead } from './fira-registry.js';

const COMPANY = 'firtech';

/** The catalogue in the stable block, without prices (prices only from `price_list`). */
function catalogueFacts(lang: Lang): string[] {
  return [
    ...PRODUCT_IDS.map((id) => {
      const p = PRODUCTS[id];
      const whom = p.kinds.map((k) => KIND_LABELS[k][lang]).join(', ');
      const pair = p.pairs.map((x) => `«${PRODUCTS[x].name[lang]}»`).join(', ');
      return `Продукт «${p.name[lang]}»: ${p.benefit[lang]} Для: ${whom}. Внутри: ${p.inside[lang].join('; ')}. Обычно вместе с: ${pair}.`;
    }),
    `Классика: ${CLASSIC_IDS.map((x) => PRODUCTS[x].name[lang]).join(', ')}.`,
  ];
}

const specs = new Map<Lang, AgentSpec>();
/** The lead manager of Fir Tech (version 2: Fira step 1), one per language (the honest line of the guards and the names of the catalogue). */
export function leadSpec(lang: Lang): AgentSpec {
  let s = specs.get(lang);
  if (!s) {
    const base = specOf({ role: 'lead-manager', niche: 'it-services', company: COMPANY, version: 2 });
    s = { ...base, company: { ...base.company, facts: [...base.company.facts, ...catalogueFacts(lang)] }, guards: { ...base.guards, note: T[lang].priceNote } };
    specs.set(lang, s);
  }
  return s;
}

/** The instruction of this turn (second, uncached block): what is known, ask / propose / answer, the visitor's niche. */
export function turnNote(lang: Lang, q: QState, mode: 'ask' | 'propose' | 'answer', o: { client?: { name: string } | undefined; channel?: 'web' | 'telegram' } = {}): string {
  const slot = nextSlot(q);
  const niche = nicheOfKind(q.kind);
  return [
    `- Язык ответа: ${lang === 'en' ? 'English' : 'русский'}. Канал: ${o.channel === 'telegram' ? 'Telegram' : 'чат на сайте'}.`,
    `- Уже известно: ${slotsKnown(q)}.`,
    mode === 'answer'
      ? '- Сборка уже предложена. Ответь по делу на то, что спросил собеседник; новых квалифицирующих вопросов не задавай.'
      : mode === 'propose'
        ? '- Сейчас НЕ задавай вопроса: назови подходящий продукт одной-двумя фразами по сказанному и вызови builder_link (созвон: call_slots).'
        : `- Сейчас выясни одно: ${slot ? SLOT_ASK[slot] : 'что ещё важно собеседнику'}. Один вопрос своими словами после короткой реакции. Всего вопросов не больше ${MAX_QUALIFY_TURNS}, это вопрос номер ${q.turns + 1}.`,
    '- Ссылки, окна созвона и цены система добавит сама после твоего ответа: в тексте ссылок, сумм и дат не пиши.',
    '- Всё новое, что собеседник рассказал о себе, запиши инструментом record_brief.',
    '- Не повторяй свои прошлые реплики из этого разговора: каждая следующая реплика продвигает дело.',
    ...(o.client ? [`- Собеседник уже клиент студии (вошёл в кабинет как ${o.client.name}). Вопрос про его проект, договор, счёт, этап или статус: record_brief с intent "support". Продукты ему не навязывай.`] : []),
    ...(niche ? ['', nicheBrief(niche)] : []),
  ].join('\n');
}

/** Builder links the model wrote itself: the code adds the right one. */
const stripLinks = (s: string): string => s.replace(/\s*https?:\/\/(www\.)?firtech\.pro\/[^\s)]*\/builder[^\s)]*/gi, '').replace(/\s+([.,!?])/g, '$1').trim();

/** One question per reply: the text up to and including its first question. */
export function oneQuestion(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  const q = parts.findIndex((p) => /\?\s*$/.test(p));
  return q >= 0 && q < parts.length - 1 ? parts.slice(0, q + 1).join(' ') : text;
}

/** Sentences that offer the builder or a call (the code adds the offers with the right link and windows). */
const OFFER = /соберите проект|собрать проект|сборк\p{L}*\s+проект|созвон|голосом|put the project together|project builder|book a call|a call is easier/iu;
export function withoutOffers(text: string): string {
  const kept = text.split(/(?<=[.!?:])\s+/).filter((x) => !OFFER.test(x));
  return kept.join(' ').trim();
}
/** The words already tell the person his question went to a person. */
const TOLD = /основател|передал|передам|уточню у команды|founder|passed (it|your question)|ask the team/iu;

const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The words of the code (a `before` answer) for the memory of the conversation. */
function textOfDone(out: ReceptionistOut, lang: Lang): string {
  if (out.kind === 'reply') return out.text;
  if (out.kind === 'handoff') return HANDOFF[lang][out.why];
  if (out.kind === 'client') return HANDOFF[lang].client;
  return '';
}

export function createFiraLead(o: FiraLeadOptions): FiraLead {
  const knowledge = o.knowledge ?? new InMemoryKnowledge();
  const memory = o.memory ?? new InMemoryMemory();
  const lessons = o.lessons ?? new InMemoryLessons();
  const journal = o.journal ?? new InMemoryJournal(2000);
  let swept = 0;
  const reload = async (): Promise<number> => knowledge.add(loadCompanyKnowledge(COMPANY, { now: o.now() }));
  const loaded = o.knowledge ? Promise.resolve(0) : reload().catch((e) => {
    log('warn', 'fira lead: company pack not loaded', { err: errMsg(e) });
    return 0;
  });

  /** A turn the code answered: it goes into the memory of the conversation and the journal like a model turn (no texts in the journal). */
  async function remember(convId: string, mode: Mode, user: string, reply: string, extra: { probe?: boolean } = {}): Promise<void> {
    const now = o.now();
    const spec = leadSpec('ru');
    try {
      if (reply) {
        const ttl = mode === 'live' ? spec.company.retention.liveDays * 86_400_000 : spec.company.retention.anonHours * 3_600_000;
        await memory.append(COMPANY, convId, [{ role: 'user', text: user, at: now }, { role: 'assistant', text: reply, at: now }], now + ttl);
      }
      await journal.record({
        companyId: COMPANY, agentId: spec.id, specVersion: spec.version, conversationId: convId, at: now, mode, tier: 'none', rounds: 0, tools: [], handoff: false,
        contact: false, removed: 0, flagged: 0, fallback: false, unknown: false, ...extra,
      });
    } catch (e) {
      log('warn', 'fira lead: memory failed', { err: errMsg(e) });
    }
  }

  async function turn(d: ReceptionistDeps, i: ReceptionistIn): Promise<ReceptionistOut> {
    await loaded;
    const now = o.now();
    if (now - swept > 10 * 60_000) {
      swept = now;
      void memory.sweep(now).catch(() => 0);
    }
    const lang = i.lang;
    const channel = i.channel ?? 'web';
    const mode: Mode = i.client ? 'live' : 'anon';
    const audience = i.client ? 'client' : 'visitor';
    // without the conversation's id (the Telegram engine today) the memory of this turn is the engine's last turns
    const ephemeral = i.conversationId === undefined;
    const convId = i.conversationId ?? `tmp-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const mem: Memory = ephemeral ? new InMemoryMemory() : memory;
    if (ephemeral && i.turns.length) await mem.append(COMPANY, convId, i.turns.map((t) => ({ role: t.role, text: t.content, at: now - 1 })), now + 3_600_000);
    const spec = leadSpec(lang);
    const text = i.text.trim();

    // non-disclosure first: the refusal of the code, before any other rule (Fira's run answers it without the model)
    if (isProbe(text)) {
      const q = normalizeQ({ ...i.q, offered: { ...i.q.offered } });
      const repeats = q.lastText === text ? (q.repeats ?? 0) + 1 : 0;
      const out = await run(spec, { id: convId, text, mode, lang, audience }, { llm: d.llm, knowledge, memory: mem, lessons, journal, now: o.now, guard: firtechGuardContext(lang) });
      return { kind: 'reply', text: out.reply, q: { ...q, lastText: text.slice(0, 120), repeats }, cta: { builder: false, call: false, telegram: false }, removed: 0 };
    }

    const channelRu = channel === 'telegram' ? 'Telegram' : 'веб-чат';
    const tell = async (e: Escalation): Promise<void> => {
      try {
        await o.escalate?.({ ...e, channel });
      } catch (err) {
        log('warn', 'fira lead: escalation not delivered', { err: errMsg(err) });
      }
    };
    const p = await prepareTurn(d, i);
    if ('done' in p) {
      let done = p.done;
      // the code's own answers follow the policy too: a price question that asks for a discount, a legal question about the offers
      if (done.kind === 'reply') {
        const e = escalationOf({ text, lang, mode: o.mode?.() ?? DEFAULT_ESCALATION_MODE, vip: i.client?.vip === true }, { channel: channelRu });
        if (e && e.tell) {
          const [head, ...rest] = done.text.split('\n\n');
          done = { ...done, text: [`${head} ${e.tell}`, ...rest].join('\n\n'), team: true };
          await tell(e);
        }
      }
      await remember(convId, mode, text, textOfDone(done, lang));
      return done;
    }
    const { st, compose } = p.go;
    if (!d.llm.enabled || !d.gate.llmAllowed()) return { kind: 'fallback', q: st.q };
    if (d.gatewayDown?.()) return { kind: 'fallback', q: st.q, down: true };

    const offeredAlready = st.q.offered.builder > 0;
    const propose = isEnough(st.q) || st.q.turns >= MAX_QUALIFY_TURNS;
    const stepMode = offeredAlready ? 'answer' : propose ? 'propose' : 'ask';
    const flags: { builder: boolean; call: boolean; brief: boolean; intent?: string | undefined; ready?: boolean | undefined; demo?: string } = { builder: false, call: false, brief: false };
    const origin = d.siteOrigin ?? SITE_ORIGIN;
    const slots = async (): Promise<number[]> => {
      try {
        return (await d.slots?.()) ?? [];
      } catch {
        return [];
      }
    };
    const briefDef = recordBriefDef({ kinds: BUILDER_KINDS, products: [...PRODUCT_IDS, ...CLASSIC_IDS], channels: BUILD_CHANNELS, goals: BUILD_GOALS, timelines: DETAIL_DEADLINES });
    const applyBrief = (input: Record<string, unknown>): void => {
      const m = briefOf(input);
      st.q = merge(st.q, m, text);
      flags.brief = true;
      flags.intent = m.intent ?? flags.intent;
      flags.ready = m.ready ?? flags.ready;
    };
    const tools: ToolRegistry = {
      price_list: priceList,
      builder_link: {
        def: { ...builderLinkStub.def, description: 'Предложить сборку проекта: ссылку с уже заполненным тем, что рассказал собеседник, собирает и вставляет система после ответа. Первое предложение, когда бизнес, задача и продукт ясны.' },
        run: () => {
          flags.builder = true;
          return Promise.resolve(okv({ url: `${origin}${builderPath(lang, buildOf(st.q))}`, note: 'ссылку добавит система после твоего ответа, в тексте её не пиши' }));
        },
      },
      call_slots: {
        def: { name: 'call_slots', description: 'Ближайшие окна для созвона (второе предложение после сборки). Окна вставит система; пусто: предложить написать удобное время.', input_schema: { type: 'object', properties: {} } },
        run: async () => {
          flags.call = true;
          const free = await slots();
          return okv({ slots: free.slice(0, 2).map((s) => formatSlot(s, d.tz(), lang)), note: 'окна добавит система после твоего ответа' });
        },
      },
      record_brief: {
        def: briefDef,
        run: (input) => {
          applyBrief(input);
          return Promise.resolve(okv({ saved: true, known: slotsKnown(st.q) }));
        },
      },
      demo_link: {
        def: demoLinkDef,
        run: () => {
          const draft = o.demoLink?.(st.q, lang) ?? null;
          const kind = st.q.kind && (DEMO_PAGE_KINDS as readonly string[]).includes(st.q.kind) ? st.q.kind : '';
          flags.demo = draft ?? (kind ? `${origin}/${lang}/solutions/${kind}` : `${origin}/${lang}#demo`);
          return Promise.resolve(okv({ url: flags.demo, draft: draft !== null, note: 'ссылку добавит система после твоего ответа' }));
        },
      },
    } satisfies Record<string, FiraTool>;

    const history: MemTurn[] = ephemeral ? [] : await memory.turns(COMPANY, convId, 200, now).catch(() => []);
    const earlier = new Set(history.filter((t) => t.role === 'assistant').map((t) => squash(t.text.split('\n\n')[0] ?? '')).filter(Boolean));
    const ownName = i.client?.name.trim().toLowerCase();
    const leakNames = (o.clientNames?.() ?? []).filter((n) => n.trim().toLowerCase() !== ownName);
    let special: ReceptionistOut | null = null;
    let result: ReplyOut | null = null;
    let rewritten = false;
    let escalated: Escalation | null = null;

    let noModel = false;
    const after = async (raw: string, outcome: RunOut['outcome'], _conv: unknown, info: { noModel: boolean; cutAll: boolean }): Promise<string> => {
      // nothing from the model: the engine's scripted intake answers (as before)
      if (info.noModel) {
        noModel = true;
        return raw;
      }
      // every sentence was cut (a made-up price, a date): the code's own words take over below
      const words = info.cutAll ? '' : raw;
      st.q.turns += 1;
      // Haiku reads what the visitor said when the dialogue model did not report it (the proposal still comes by the code's count of turns)
      if (!flags.brief && o.extract !== false && !isEnough(st.q)) {
        const t = await tryChat(d.llm, {
          tier: 'haiku', maxTokens: 300, toolChoice: { type: 'tool', name: 'record_brief' }, tools: [briefDef],
          system: [{ text: 'Запиши инструментом record_brief только то, что собеседник сам сказал о себе в этом сообщении. Пустое не заполняй.' }],
          messages: [{ role: 'user', content: text }],
        });
        const use = t ? turnToolUses(t).find((u) => u.name === 'record_brief') : undefined;
        if (use) applyBrief(use.input);
      }
      const reason = outcome.owner?.reason;
      if (reason === 'person' || reason === 'anger') {
        st.q.handoff = true;
        special = { kind: 'handoff', q: st.q, why: reason === 'anger' ? 'upset' : 'ask' };
        return HANDOFF[lang][reason === 'anger' ? 'upset' : 'ask'];
      }
      if (i.client && flags.intent === 'support') {
        special = { kind: 'client', q: st.q };
        return HANDOFF[lang].client;
      }
      if (flags.intent === 'price') st.q.askedPrice = true;
      const ready = !offeredAlready && (propose || flags.ready === true || isEnough(st.q) || flags.intent === 'builder' || flags.intent === 'call' || flags.builder || flags.call);
      // the honest line of the guards (a price or a date was cut) stays at the end whatever the question rules drop
      const note = spec.guards.note;
      let reply = stripLinks(words);
      const noted = Boolean(note) && reply.endsWith(note);
      if (noted) reply = reply.slice(0, -note.length).trim();
      // the offers are the code's: a sentence of the model that offers the builder or a call itself goes when the code adds them
      if (ready) reply = withoutOffers(reply);
      reply = ready ? withoutTrailingQuestion(reply) : oneQuestion(reply);
      if (noted) reply = `${reply} ${note}`.trim();
      // text.detect on our own words: flagged text is rewritten once (Haiku), through the same guards again
      const lint = lintReply(reply, lang);
      if (lint.flagged) {
        const fixed = await withTimeout(tryComplete(d.llm, rewriteRequest(reply, lint.find, lang)), d.timeoutMs ?? 20_000);
        if (fixed?.trim()) {
          const again = leakGuard(applyGuards(fixed.trim(), spec.guards, firtechGuardContext(lang)).text, lang, { clientNames: leakNames }).text;
          if (again.length >= 20 && again.length >= reply.length * 0.4) {
            reply = ready ? withoutTrailingQuestion(again) : oneQuestion(again);
            rewritten = true;
          }
        }
      }
      // the whole list only on «что вы делаете»; an earlier reply word for word is replaced by the code's answer to the need
      if (reply && !asksCatalogue(text) && productsNamed(reply, lang) >= 4) reply = needReply(st.q, lang, ready);
      if (reply && earlier.has(squash(reply))) reply = needReply(st.q, lang, ready);
      if (!reply) reply = ready ? needReply(st.q, lang, true) : lang === 'ru' ? 'Понял вас. Расскажите, чем занимается ваш бизнес?' : 'Got it. What does your business do?';
      // the escalation policy: money, legal, no knowledge, a VIP go to the owner in one line; the visitor hears that once
      // «не знал» counts only when the agent said so (a qualification turn often finds nothing in the company pack, and that is fine)
      const unsure = outcome.unknown && /уточн|передам|не знаю|ask the team|not sure|will check/iu.test(words);
      escalated = escalationOf({ text, lang, mode: o.mode?.() ?? DEFAULT_ESCALATION_MODE, outcome: { unknown: unsure, ...(outcome.owner ? { owner: outcome.owner } : {}) }, vip: i.client?.vip === true }, { channel: channelRu });
      // the person hears it once: when the words already say it went to the founder or the team, no second sentence
      if (escalated?.tell && !TOLD.test(reply)) reply = `${reply} ${escalated.tell}`;
      if (flags.demo) reply = `${reply}\n\n${lang === 'ru' ? 'Демо' : 'Demo'}: ${flags.demo}`;
      if (ready) {
        result = await compose(reply, { builder: true, call: st.q.offered.call === 0 || flags.call, telegram: st.wantsTg });
        return result.text;
      }
      result = { kind: 'reply', text: reply, q: st.q, cta: { builder: false, call: false, telegram: false }, ...(st.contact ? { contact: st.contact } : {}), removed: 0 };
      return reply;
    };

    d.gate.llmUsed();
    const conv = { id: convId, text, mode, lang, audience, ...(i.client ? { contactKey: i.client.email } : {}), note: turnNote(lang, st.q, stepMode, { client: i.client ? { name: i.client.name } : undefined, channel }) } as const;
    const out = await withTimeout(
      run(spec, conv, { llm: d.llm, knowledge, memory: mem, lessons, journal, now: o.now, tools, guard: firtechGuardContext(lang), leak: { clientNames: leakNames }, after }),
      (d.timeoutMs ?? 20_000) + 15_000,
    );
    if (!out) return { kind: 'fallback', q: st.q, down: true };
    // the model gave nothing (off, down, refused): the scripted intake, as before
    if (noModel) return { kind: 'fallback', q: st.q, down: true };
    if (escalated) await tell(escalated);
    if (special) return special;
    const r: ReplyOut = result ?? { kind: 'reply', text: out.reply, q: st.q, cta: { builder: false, call: false, telegram: false }, removed: 0 };
    log('info', 'fira lead turn', { rounds: out.rounds, tools: out.outcome.used.length, removed: out.removed, leaked: out.leaked, escalated: escalated ? (escalated as Escalation).reason : null, turns: st.q.turns });
    return { ...r, removed: out.removed, ...(rewritten ? { rewritten: true } : {}), ...(escalated ? { team: true } : {}), ...(out.outcome.contact && !r.contact ? { contact: out.outcome.contact.contact } : {}) };
  }

  return { turn, reload, stores: { knowledge, memory, lessons, journal } };
}
