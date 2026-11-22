import { errMsg, log, migrate, type Db, type LlmClient } from '@fir/core';
import {
  InMemoryKnowledge, InMemoryLessons, execAssistantSpec, firtechGuardContext, run, type AgentSpec, type Journal, type Memory, type MemTurn, type PersonProfile, type TaskKind,
} from '@fir/fira';
import { meterLlm, type Hq } from '@fir/hq';
import { assistantTools } from './assistant-tools.js';
import { createDirectorHistory } from './director-history.js';
import type { PultLinks, PultScreen } from './links.js';

/**
 * The owner's assistant in the one HQ bot (owner 2026-11-22: «умный HQ: если я задам любой вопрос, он должен ответить»). Any text of the owner in the
 * bot's chat is a question: Fira's `run()` with the executive assistant spec (`packages/fira/role-packs/executive-assistant.md`), native tool use over
 * read-only tools (`assistant-tools.ts`), Sonnet, Haiku for the trivial counts. Nothing is done through the chat: a request to act («одобри», «ответь
 * клиенту») gets the link to the Пульт screen where it is done, by code and without the model. The spend lands in `costs` (agent `director`).
 * Memory: the last 10 questions and answers in SQLite (the owner, not a client: texts may be kept). Each exchange also goes to `director_history`
 * (the Пульт «Поручения» shows the Telegram questions next to the website ones).
 */

const TURNS_KEPT = 20; // 10 questions and their answers
const COMPANY = 'firtech';
const CONVERSATION = 'owner-telegram';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS as_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS as_turns_conv ON as_turns (conversation, id);
`;

/** Fira's `Memory` over SQLite for the one conversation of the owner: the last `TURNS_KEPT` turns, nothing about people. */
export class OwnerMemory implements Memory {
  constructor(private readonly db: Db) {
    migrate(db, SCHEMA);
  }
  turns(_c: string, conversationId: string, limit: number): Promise<MemTurn[]> {
    const rows = this.db.prepare('SELECT role, text, at FROM as_turns WHERE conversation = ? ORDER BY id DESC LIMIT ?').all(conversationId, limit) as MemTurn[];
    return Promise.resolve(rows.reverse());
  }
  append(_c: string, conversationId: string, turns: MemTurn[]): Promise<void> {
    const ins = this.db.prepare('INSERT INTO as_turns (conversation, role, text, at) VALUES (?, ?, ?, ?)');
    for (const t of turns) ins.run(conversationId, t.role, t.text.slice(0, 4000), t.at);
    this.db.prepare('DELETE FROM as_turns WHERE conversation = ? AND id <= (SELECT MAX(id) FROM as_turns WHERE conversation = ?) - ?').run(conversationId, conversationId, TURNS_KEPT);
    return Promise.resolve();
  }
  promote(): Promise<void> {
    return Promise.resolve();
  }
  profile(): Promise<PersonProfile | null> {
    return Promise.resolve(null);
  }
  saveProfile(): Promise<void> {
    return Promise.resolve();
  }
  sweep(): Promise<number> {
    return Promise.resolve(0);
  }
  /** The last answer of the conversation is replaced (the runtime stored its fallback, the owner got the numbers said by code). */
  replaceLastAnswer(conversationId: string, text: string): void {
    this.db.prepare("UPDATE as_turns SET text = ? WHERE id = (SELECT MAX(id) FROM as_turns WHERE conversation = ? AND role = 'assistant')").run(text.slice(0, 4000), conversationId);
  }
  /** Everything kept, oldest first (tests). */
  all(): MemTurn[] {
    return this.db.prepare('SELECT role, text, at FROM as_turns WHERE conversation = ? ORDER BY id').all(CONVERSATION) as MemTurn[];
  }
}

/** The journal of the assistant is the `fira turn` log line of the runtime (counters only); nothing else is stored. */
const quietJournal: Journal = { record: () => Promise.resolve() };

/** The end of a word (JS `\b` knows only Latin letters). */
const W = '(?![\\p{L}\\p{N}])';
const re = (src: string) => new RegExp(`^(?:${src})${W}`, 'u');
/** Requests to act, with the screen where the owner does it; imperative or, after «можешь», «надо», infinitive. The first match wins. */
const ACTIONS: [RegExp, PultScreen, string][] = [
  [re('(?:постав(?:ь|ьте|ить)|измен(?:и|ите|ить)|поменя(?:й|йте|ть)|включ(?:и|ите|ить)|выключ(?:и|ите|ить)|отключ(?:и|ите|ить)|установ(?:и|ите|ить)|сдела(?:й|йте|ть))\\s+(?:мне\\s+)?(?:\\S+\\s+){0,3}?(?:сводк|дайджест|тих\\S+\\s+час|лимит|бюджет|напоминани|настройк|порог|слот)\\S*'), 'settings', 'Настройки компании меняются в Пульте, на вкладке «Настройки»'],
  [re('(?:прим(?:и|ите)|принять|закро(?:й|йте)|закрыть|запуст(?:и|ите|ить)|отмет(?:ь|ьте|ить))\\s+(?:этап|проект)\\S*'), 'projects', 'Этапы и проекты ведутся в Пульте, в производстве'],
  [re('(?:одобр(?:и|ите|ить)|утверд(?:и|ите|ить)|согласу(?:й|йте)|согласовать|отклон(?:и|ите|ить)|откаж(?:и|ите)|отказать|опублику(?:й|йте)|опубликовать|вылож(?:и|ите|ить)|перепиш(?:и|ите)|переписать|поправ(?:ь|ьте|ить)|исправ(?:ь|ьте|ить)|отредактиру(?:й|йте)|отредактировать)'), 'review', 'Одобрения, правки и публикации делаются в ревью-центре'],
  [re('(?:ответ(?:ь|ьте|ить)|(?:напиш(?:и|ите)|написать|отправ(?:ь|ьте|ить)|передай|передать)\\s+(?:клиент|лид|ему|ей|им|сообщени)\\S*)'), 'chats', 'Ответ клиенту пишется в чатах Пульта'],
  [re('(?:отмет(?:ь|ьте|ить)\\s+(?:оплат|сч[её]т)\\S*|провед(?:и|ите)|провести|выстав(?:и|ь|ьте|ить)|верн(?:и|ите)|вернуть|закро(?:й|йте)\\s+сч[её]т\\S*)'), 'money', 'Оплаты и счета отмечаются в Пульте, в счетах'],
  [re('(?:созда(?:й|йте|ть)|постав(?:ь|ьте|ить)|поруч(?:и|ите|ить)|сдела(?:й|йте|ть)|запуст(?:и|ите|ить)|напиш(?:и|ите)|написать|подготов(?:ь|ьте|ить)|добав(?:ь|ьте|ить)|удал(?:и|ите|ить)|измен(?:и|ите|ить)|поменя(?:й|йте|ть)|включ(?:и|ите|ить)|выключ(?:и|ите|ить)|останов(?:и|ите|ить))'), 'tasks', 'Поручения отделам и настройки даются в Пульте, «Поручения»'],
];
const POLITE = new RegExp(`^(?:пожалуйста|плиз|слушай|hq|эй|можешь|можете|сможешь|надо|нужно|давай)${W}[\\s,!.:]*`, 'u');

/** The screen and the sentence for a request to act; null when the text is a question. */
export function actionRequest(text: string): { screen: PultScreen; say: string } | null {
  let t = text.trim().toLowerCase();
  for (let i = 0; i < 3 && POLITE.test(t); i++) t = t.replace(POLITE, '');
  if (re('(?:что|как|когда|где|сколько|кто|почему|зачем|какой|какая|какие|каких|есть ли)').test(t)) return null;
  for (const [rx, screen, say] of ACTIONS) if (rx.test(t)) return { screen, say };
  return null;
}

/** A trivial count («сколько заявок сегодня»): the cheap tier. */
export const isTrivial = (text: string): boolean => text.length <= 80 && re('(?:сколько|how many)').test(text.trim().toLowerCase());

export interface AssistantDeps {
  hq: Hq;
  /** The company's model client; metered here as agent `director` (owner's work, not a client: the department limit applies). */
  llm: LlmClient;
  links: PultLinks;
  pendingApprovals?: () => number;
  /** The company settings (read only) for the question «какие настройки?». */
  settingsView?: () => unknown;
}

export class OwnerAssistant {
  readonly spec: AgentSpec = execAssistantSpec();
  readonly memory: OwnerMemory;
  private readonly llm: LlmClient;
  readonly history: ReturnType<typeof createDirectorHistory>;
  private readonly tools: ReturnType<typeof assistantTools>;
  private readonly knowledge = new InMemoryKnowledge();
  private readonly lessons = new InMemoryLessons();

  constructor(private readonly d: AssistantDeps) {
    this.memory = new OwnerMemory(d.hq.db);
    this.llm = meterLlm(d.llm, d.hq, { agentId: 'director' });
    this.history = createDirectorHistory(d.hq.db, d.hq.now);
    this.tools = assistantTools({ hq: d.hq, links: d.links, ...(d.pendingApprovals ? { pendingApprovals: d.pendingApprovals } : {}), ...(d.settingsView ? { settingsView: d.settingsView } : {}) });
  }

  /** The answer to one message of the owner (plain text with a link). Never throws. */
  async answer(text: string): Promise<string> {
    const q = text.trim().slice(0, 2000);
    if (!q) return this.help();
    this.history.add('owner', q, undefined, 'telegram');
    let reply: string;
    try {
      reply = await this.ask(q);
    } catch (e) {
      log('warn', 'assistant failed', { err: errMsg(e) });
      reply = await this.offline();
    }
    this.history.add('hq', reply, undefined, 'telegram');
    return reply;
  }

  private async ask(q: string): Promise<string> {
    const act = actionRequest(q);
    const task: TaskKind | undefined = isTrivial(q) ? 'faq' : undefined;
    const out = await run(this.spec, { id: CONVERSATION, text: q, mode: 'live', lang: 'ru', ...(task ? { task } : {}) }, {
      llm: this.llm, knowledge: this.knowledge, memory: this.memory, lessons: this.lessons, journal: quietJournal, now: this.d.hq.now,
      tools: this.tools, guard: firtechGuardContext('ru'), historyTurns: TURNS_KEPT,
      // nothing is done through the chat: a request to act gets its screen, without a model call
      before: (conv) => Promise.resolve(act && conv.text === q ? { reply: `${act.say}: ${this.d.links.to(act.screen)}` } : null),
      after: (reply) => Promise.resolve(reply.includes(this.d.links.base) ? reply : `${reply}\n${this.d.links.to('home')}`),
    });
    if (!out.fallback) return out.reply;
    const said = await this.offline();
    this.memory.replaceLastAnswer(CONVERSATION, said);
    return said;
  }

  /** No model (off, down, over the limit, an empty answer): the main numbers from the data, said by code. */
  private async offline(): Promise<string> {
    const r = await this.tools.hq_overview!.run({}, { companyId: COMPANY, agentId: this.spec.id, conversationId: CONVERSATION, mode: 'live', lang: 'ru', now: this.d.hq.now, knowledge: this.knowledge, outcome: { used: [], unknown: false } });
    if (!r.ok) return `Модель сейчас недоступна, ответить подробно не могу. Пульт: ${this.d.links.to('home')}`;
    const v = r.value as { today: { leads: number; newClients: number }; approvalsWaiting: number; blockedTasks: number; llmTodayUsd: number };
    return `Модель сейчас недоступна, коротко по данным: заявок сегодня ${v.today.leads}, новых клиентов ${v.today.newClients}, ждёт одобрения ${v.approvalsWaiting}, застряло задач ${v.blockedTasks}. Пульт: ${this.d.links.to('home')}`;
  }

  /** `/start`: what the bot is. */
  help(): string {
    return `Я Shell Fir Tech: напоминаю о главном (новый клиент, заявка, документ на одобрение, оплата) и отвечаю на вопросы о компании обычным текстом, например «что висит?» или «сколько заявок сегодня?». Управление в Пульте: ${this.d.links.to('home')}`;
  }
}
