import { log, type Button, type LlmClient, type Messenger } from '@fir/core';
import { draftFirst, draftFollowup, draftReply, PLACEHOLDER, type Prompts } from './draft.js';
import { offerFor, priceLabel } from './offers.js';
import { FOLLOWUP_DAYS, STATUSES, STATUS_RU, type DraftKind, type Prospect, type ProspectStore } from './store.js';

export const CB = 'pr';

export interface AgentDeps {
  store: ProspectStore;
  messenger: Messenger;
  llm: LlmClient;
  prompts: Prompts;
  ownerId: number;
  batchSize: number;
  now?: () => number;
}

export interface Card {
  text: string;
  buttons: Button[][];
}

const contactLines = (p: Prospect): string[] =>
  [
    p.telegram && `Telegram: ${p.telegram}`,
    p.instagram && `Instagram: ${p.instagram}`,
    p.phone && `Телефон: ${p.phone}`,
    p.website && `Сайт: ${p.website}`,
  ].filter((x): x is string => Boolean(x));

const KIND_TITLE = (p: Prospect, kind: DraftKind): string =>
  kind === 'first'
    ? `#${p.id} ${p.name}`
    : kind === 'followup'
      ? `Дожим ${p.followups} (через ${FOLLOWUP_DAYS[p.followups - 1] ?? '?'} дн.) #${p.id} ${p.name}`
      : `Ответ на реплику #${p.id} ${p.name}`;

/** The owner's card: business, city, niche, contacts, the draft; buttons Copy / Edit / Skip / Sent. */
export function renderCard(p: Prospect, kind: DraftKind, draft: string): Card {
  const offer = offerFor(p.offer);
  const head = [
    KIND_TITLE(p, kind),
    `${p.niche} · ${p.city}`,
    ...contactLines(p),
    kind === 'first' ? `Предложение: ${offer.title}, ${priceLabel(offer)}` : '',
  ].filter(Boolean);
  const warn = PLACEHOLDER.test(draft) ? '\n\nВ тексте метка [цена] или [срок]: правьте, пока не вставите цифры, отметить «Отправлено» нельзя.' : '';
  const row = (act: string, text: string): Button => ({ text, data: `${CB}:${p.id}:${act}` });
  return {
    text: `${head.join('\n')}\n\nЧерновик:\n${draft}${warn}`,
    buttons: [[row('c', 'Скопировать'), row('e', 'Править')], [row('s', 'Пропустить'), row('d', 'Отправлено')]],
  };
}

/** The Scout: prepares first messages, follow-ups and reply drafts for the owner, who sends them himself. */
export class Prospector {
  private editing: number | null = null;
  private awaitingReply: number | null = null;
  private readonly now: () => number;

  constructor(private readonly d: AgentDeps) {
    this.now = d.now ?? Date.now;
  }

  private send(text: string, buttons?: Button[][]): Promise<void> {
    return this.d.messenger.send(this.d.ownerId, text, buttons);
  }

  private async sendCard(p: Prospect, kind: DraftKind, draft: string): Promise<void> {
    const c = renderCard(p, kind, draft);
    await this.send(c.text, c.buttons);
  }

  /** One new prospect: draft, status proposed, card. */
  async proposeFirst(p: Prospect): Promise<void> {
    const draft = await draftFirst(this.d.llm, this.d.prompts, p);
    this.d.store.transition(p.id, 'proposed');
    this.d.store.setDraft(p.id, 'first', draft);
    await this.sendCard(this.d.store.get(p.id)!, 'first', draft);
  }

  async proposeFollowup(p: Prospect): Promise<void> {
    const stage = (p.followups + 1) as 1 | 2;
    const draft = await draftFollowup(this.d.llm, this.d.prompts, p, stage, p.sentText ?? '');
    this.d.store.bumpFollowups(p.id);
    this.d.store.setDraft(p.id, 'followup', draft);
    await this.sendCard(this.d.store.get(p.id)!, 'followup', draft);
  }

  /** Daily job and /batch: close silent ones, propose due follow-ups, then up to `limit` new prospects. */
  async batch(limit = this.d.batchSize): Promise<{ followups: number; proposed: number; closed: number }> {
    const now = this.now();
    const closed = this.d.store.expireNoReply(now);
    const due = this.d.store.dueFollowups(now);
    for (const p of due) await this.proposeFollowup(p);
    const fresh = this.d.store.pickNew(limit);
    for (const p of fresh) await this.proposeFirst(p);
    const left = this.d.store.stats().byStatus.new;
    log('info', 'batch done', { followups: due.length, proposed: fresh.length, closed, left });
    await this.send(
      `Пакет готов: новых карточек ${fresh.length}, дожимов ${due.length}` +
        (closed ? `, закрыто без ответа ${closed}` : '') +
        `. Осталось новых в базе: ${left}.`,
    );
    return { followups: due.length, proposed: fresh.length, closed };
  }

  /** `/command arg` from a chat. Anyone but the owner is ignored without a word. */
  async onCommand(fromId: number, name: string, arg: string): Promise<void> {
    if (fromId !== this.d.ownerId) return;
    const { store } = this.d;
    switch (name) {
      case 'start':
      case 'help':
        await this.send('Команды: /batch (пакет сейчас), /next (ещё одна карточка), /stats (воронка), /find <текст>, /reply <id> (бизнес ответил).');
        return;
      case 'batch':
        await this.batch();
        return;
      case 'next': {
        const [p] = store.pickNew(1);
        if (!p) await this.send('Новых бизнесов в базе нет. Загрузите CSV: pnpm --filter prospector run import <файл>.');
        else await this.proposeFirst(p);
        return;
      }
      case 'stats':
        await this.send(this.statsText());
        return;
      case 'find': {
        if (!arg.trim()) {
          await this.send('Формат: /find <название, город, ниша или номер>');
          return;
        }
        const rows = store.find(arg, 10);
        await this.send(
          rows.length
            ? rows.map((p) => `#${p.id} ${p.name} · ${p.city} · ${p.niche} · ${STATUS_RU[p.status]}${contactLines(p)[0] ? `\n   ${contactLines(p)[0]}` : ''}`).join('\n')
            : 'Ничего не нашёл.',
        );
        return;
      }
      case 'reply':
        await this.markReply(arg);
        return;
    }
  }

  private async markReply(arg: string): Promise<void> {
    const id = Number(arg.trim().replace(/^#/, ''));
    const p = Number.isInteger(id) ? this.d.store.get(id) : undefined;
    if (!p) {
      await this.send('Формат: /reply <id>, номер из карточки (#12).');
      return;
    }
    if (p.status === 'sent' || p.status === 'no_reply') {
      this.d.store.transition(p.id, 'replied');
      this.d.store.clearDraft(p.id);
    } else if (p.status !== 'replied') {
      await this.send(`#${p.id} ${p.name}: статус «${STATUS_RU[p.status]}», ответить можно только после «Отправлено».`);
      return;
    }
    this.editing = null;
    this.awaitingReply = p.id;
    await this.send(`#${p.id} ${p.name}: ответ отмечен. Перешлите текст ответа одним сообщением, подготовлю черновик. Цены утверждаете вы.`);
  }

  statsText(): string {
    const s = this.d.store.stats();
    const line = (b: Record<string, number>) => STATUSES.filter((k) => b[k]).map((k) => `${STATUS_RU[k]} ${b[k]}`).join(', ') || 'пусто';
    return [`Воронка, всего ${s.total}: ${line(s.byStatus)}`, '', 'По нишам:', ...s.byNiche.map((n) => `${n.niche} (${n.total}): ${line(n.byStatus)}`)].join('\n');
  }

  /** The owner's free text: a correction after «Править» or the forwarded reply after /reply. True when consumed. */
  async onText(fromId: number, text: string): Promise<boolean> {
    if (fromId !== this.d.ownerId) return false;
    if (this.editing !== null) {
      const p = this.d.store.get(this.editing);
      this.editing = null;
      if (!p?.draftKind) return true;
      this.d.store.editDraft(p.id, text);
      await this.sendCard(p, p.draftKind, text);
      return true;
    }
    if (this.awaitingReply !== null) {
      const p = this.d.store.get(this.awaitingReply);
      this.awaitingReply = null;
      if (!p) return true;
      const draft = await draftReply(this.d.llm, this.d.prompts, p, p.sentText ?? '', text);
      this.d.store.setDraft(p.id, 'reply', draft);
      await this.sendCard(p, 'reply', draft);
      return true;
    }
    return false;
  }

  /** Button press `pr:<id>:<c|e|s|d>`. Returns the toast text; null when the data is not ours. */
  async onCallback(fromId: number, data: string): Promise<string | null> {
    const m = new RegExp(`^${CB}:(\\d+):([cesd])$`).exec(data);
    if (!m) return null;
    if (fromId !== this.d.ownerId) return 'Нет доступа';
    const { store } = this.d;
    const p = store.get(Number(m[1]));
    if (!p || !p.draftKind || p.draft === null) return 'Уже обработано';
    if (p.draftKind === 'first' && p.status !== 'proposed') return 'Уже обработано';
    switch (m[2]) {
      case 'c':
        await this.send(p.draft);
        return 'Текст ниже';
      case 'e':
        this.editing = p.id;
        this.awaitingReply = null;
        await this.send(`Пришлите новый текст для #${p.id} одним сообщением.`);
        return 'Жду правку';
      case 's':
        if (p.draftKind === 'first') store.transition(p.id, 'skipped');
        store.clearDraft(p.id);
        if (this.editing === p.id) this.editing = null;
        return 'Пропущено';
      default: // d: sent
        if (PLACEHOLDER.test(p.draft)) return 'Сначала замените [цена] / [срок]';
        if (p.draftKind === 'first') {
          store.transition(p.id, 'sent');
          store.setSentText(p.id, p.draft);
        }
        store.clearDraft(p.id);
        if (this.editing === p.id) this.editing = null;
        return 'Отмечено как отправленное';
    }
  }
}
