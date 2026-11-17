import { formatSlot, log, tryComplete, zonedParts, type Button, type LlmClient, type Messenger } from '@fir/core';
import type { Config } from './config.js';
import { isHHMM } from './config.js';
import type { Content, Lesson } from './content.js';
import { DAY_MS, dueAt, review, type Grade } from './fsrs.js';
import { addDays, dateKey, type Card, type PollyStore, type Profile } from './store.js';

type TeacherConfig = Pick<Config, 'ownerId' | 'tz' | 'lessonTime' | 'weeklyAt' | 'reviewLimit'>;

export interface TeacherDeps {
  store: PollyStore;
  messenger: Messenger;
  llm: LlmClient;
  content: Content;
  cfg: TeacherConfig;
  now?: () => number;
  rng?: () => number;
}

interface Q {
  q: string;
  o: string[];
  a: number;
  why?: string | undefined;
}

type Session =
  | { mode: 'idle' }
  | { mode: 'lesson'; day: number; step: number; score: number; answered: boolean }
  | { mode: 'placement'; i: number; score: number; qs: Q[] }
  | { mode: 'review'; queue: string[]; shown: boolean; done: number; total: number }
  | { mode: 'tones'; i: number; score: number; qs: Q[] }
  | { mode: 'talk' };

const SITUATION_RU: Record<Lesson['situation'], string> = {
  acquaintance: 'знакомство', cafe: 'кафе', taxi: 'такси', shop: 'магазин', hotel: 'отель', road: 'дорога', polite: 'вежливость',
};
const GOAL = 'говорить в путешествиях и в быту';
const TONES_PER_SESSION = 5;
const WORDS_PER_LESSON = 3;
const QUIZ_PER_LESSON = 3;
// Steps of a lesson: 0 greeting, 1..3 words, 4 dialogue, 5..7 quiz, 8 finish.
const STEP_DIALOG = 1 + WORDS_PER_LESSON;
const STEP_QUIZ = STEP_DIALOG + 1;
const STEP_FINISH = STEP_QUIZ + QUIZ_PER_LESSON;

const b = (text: string, data: string): Button => ({ text, data });

const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const days = (n: number): string => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

/**
 * Polly: a personal language teacher for the owner only. Text lessons, a spaced-repetition vocabulary (FSRS),
 * placement test, tone drill, reminders and a weekly report. Everything goes to the owner's own chat, so there is no
 * approval queue here. Logs hold counts only. The LLM is used for free conversation (/talk) and nothing else.
 */
export class Teacher {
  private readonly now: () => number;
  private readonly rng: () => number;
  constructor(private readonly d: TeacherDeps) {
    this.now = d.now ?? Date.now;
    this.rng = d.rng ?? Math.random;
  }

  // ---- entry points (Telegram handlers call these) ----

  async onCommand(name: string, arg = ''): Promise<void> {
    this.d.store.touch();
    switch (name) {
      case 'start': return this.cmdStart();
      case 'help': return this.send(HELP);
      case 'lesson': return this.startLesson();
      case 'review': return this.startReview();
      case 'tones': return this.startTones();
      case 'test': return this.startPlacement();
      case 'talk': return this.startTalk();
      case 'stop': return this.stopTalk();
      case 'profile': return this.cmdProfile();
      case 'stats': return this.send(this.report(false));
      case 'time': return this.cmdTime(arg);
      default: return this.send(`Не знаю такую команду.\n\n${HELP}`);
    }
  }

  async onAction(data: string): Promise<void> {
    this.d.store.touch();
    const [kind, action, extra] = data.split(':') as [string, string | undefined, string | undefined];
    const s = this.session();
    switch (kind) {
      case 'go':
        if (action === 'lesson') return this.startLesson();
        if (action === 'review') return this.startReview();
        if (action === 'tones') return this.startTones();
        if (action === 'test') return this.startPlacement();
        if (action === 'skip') return this.skipTest();
        return;
      case 'l':
        if (s.mode === 'lesson' && Number(extra) === s.step) return this.lessonAction(s, action ?? '');
        return;
      case 'q': // answer to a quiz-like question (placement, tones, lesson quiz): q:<i>:<index>
        return this.answer(s, Number(action), Number(extra));
      case 'r':
        if (s.mode === 'review') return this.reviewAction(s, action ?? '', Number(extra));
        return;
      default:
    }
  }

  async onText(text: string): Promise<void> {
    this.d.store.touch();
    const s = this.session();
    if (s.mode === 'talk') return this.talk(text);
    if (s.mode === 'idle') return this.send('Нажми /lesson для урока, /review для карточек или /help.');
    return this.send('Сейчас нужны кнопки под сообщением. Выйти из занятия: /lesson, /review, /tones.');
  }

  async onVoice(fileId: string, duration: number | null): Promise<void> {
    this.d.store.touch();
    const n = this.d.store.queueVoice(fileId, duration);
    log('info', 'voice queued', { queued: n });
    await this.send('Голосовое получила и положила в очередь. Голос подключу на этапе 2, пока отвечай текстом.');
  }

  // ---- session state ----

  private session(): Session {
    const raw = this.d.store.getKv('session');
    if (!raw) return { mode: 'idle' };
    try {
      return JSON.parse(raw) as Session;
    } catch {
      return { mode: 'idle' };
    }
  }

  private setSession(s: Session): void {
    this.d.store.setKv('session', JSON.stringify(s));
  }

  private send(text: string, buttons?: Button[][]): Promise<void> {
    return this.d.messenger.send(this.d.cfg.ownerId, text, buttons);
  }

  private shuffle<T>(xs: T[]): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  private tz(): string {
    return this.d.store.profile()?.tz ?? this.d.cfg.tz;
  }

  private ensureProfile(level: Profile['level'] = 'zero', score: number | null = null): Profile {
    const p = this.d.store.profile();
    if (p) return p;
    return this.d.store.saveProfile({
      language: 'zh', level, goal: GOAL, minutesPerDay: 30, lessonTime: this.d.cfg.lessonTime, tz: this.d.cfg.tz,
      streak: 0, bestStreak: 0, lastLessonDate: null, lessonDay: 1, placementScore: score,
    });
  }

  /** The streak as it stands now: broken if the last lesson was before yesterday. */
  currentStreak(p: Profile): number {
    if (!p.lastLessonDate) return 0;
    const today = dateKey(this.now(), p.tz);
    return p.lastLessonDate === today || p.lastLessonDate === addDays(today, -1) ? p.streak : 0;
  }

  // ---- start, profile ----

  private async cmdStart(): Promise<void> {
    const p = this.d.store.profile();
    if (!p) {
      await this.send(
        'Привет! Я Polly, твой учитель китайского. Цель: говорить в поездках и в быту. Каждый день 30 минут: урок, карточки и пять минут тонов.\n\nНачнём с короткого теста уровня (5 минут: тоны, 10 слов, 3 фразы). Если ты с нуля, можно пропустить.',
        [[b('Пройти тест', 'go:test')], [b('Я с нуля, пропустить', 'go:skip')]],
      );
      return;
    }
    await this.send(
      `С возвращением! День ${p.lessonDay} в программе, серия ${days(this.currentStreak(p))}. Карточек на повторение: ${this.d.store.dueCount(this.now())}.`,
      [[b('Урок дня', 'go:lesson'), b('Карточки', 'go:review')], [b('Тоны 5 минут', 'go:tones')]],
    );
  }

  private async skipTest(): Promise<void> {
    this.ensureProfile('zero');
    await this.send('Хорошо, начинаем с нуля. Урок дня 1 готов.', [[b('Начать урок', 'go:lesson')]]);
  }

  private async cmdProfile(): Promise<void> {
    const p = this.ensureProfile();
    const lessons = this.d.content.lessons.length;
    const level = { zero: 'с нуля', beginner: 'начальный', confident: 'уверенный старт' }[p.level];
    await this.send(
      [
        'Профиль ученика',
        'Язык: китайский (упрощённые иероглифы, пиньинь)',
        `Цель: ${p.goal}`,
        `Уровень: ${level}${p.placementScore !== null ? ` (тест ${Math.round(p.placementScore * 100)} %)` : ''}`,
        `Время в день: ${p.minutesPerDay} минут`,
        `Урок в ${p.lessonTime} (${p.tz}), поменять: /time 20:30`,
        `Программа: день ${Math.min(p.lessonDay, lessons)} из ${lessons}`,
        `Серия: ${days(this.currentStreak(p))}, рекорд ${days(p.bestStreak)}`,
        `Карточек: ${this.d.store.cardCount()}, на сегодня ${this.d.store.dueCount(this.now())}`,
      ].join('\n'),
    );
  }

  private async cmdTime(arg: string): Promise<void> {
    const t = arg.trim();
    if (!isHHMM(t)) return this.send('Формат: /time 19:30 (местное время).');
    const p = this.ensureProfile();
    const [h, m] = t.split(':') as [string, string];
    const norm = `${h.padStart(2, '0')}:${m}`;
    this.d.store.saveProfile({ ...p, lessonTime: norm });
    await this.send(`Готово, напоминание об уроке в ${norm}.`);
  }

  // ---- placement test ----

  private async startPlacement(): Promise<void> {
    const { content } = this.d;
    const vocab = [...content.words.values()];
    const qs: Q[] = [];
    for (const q of content.placement.pinyin) qs.push({ q: q.q, o: q.o, a: q.a });
    for (const h of content.placement.words) {
      const w = content.words.get(h)!;
      const wrong = this.shuffle(vocab.filter((x) => x.r !== w.r)).slice(0, 3).map((x) => x.r);
      const o = this.shuffle([w.r, ...wrong]);
      qs.push({ q: `Что значит ${w.h} (${w.p})?`, o, a: o.indexOf(w.r) });
    }
    for (const p of content.placement.phrases) qs.push({ q: `Переведи: ${p.h} (${p.p})`, o: p.o, a: p.a });
    this.setSession({ mode: 'placement', i: 0, score: 0, qs });
    await this.send(`Тест уровня: ${qs.length} коротких вопросов, около 5 минут. Отвечай кнопками, ничего страшного, если не знаешь: это нормально для нуля.`);
    await this.askQuestion(0, qs);
  }

  private async askQuestion(i: number, qs: Q[]): Promise<void> {
    const q = qs[i]!;
    await this.send(`Вопрос ${i + 1} из ${qs.length}\n\n${q.q}`, q.o.map((o, k) => [b(o, `q:${i}:${k}`)]));
  }

  private async answer(s: Session, i: number, k: number): Promise<void> {
    if (s.mode === 'placement') return this.placementAnswer(s, i, k);
    if (s.mode === 'tones') return this.tonesAnswer(s, i, k);
    if (s.mode === 'lesson') return this.lessonAnswer(s, i, k);
  }

  private async placementAnswer(s: Extract<Session, { mode: 'placement' }>, i: number, k: number): Promise<void> {
    if (i !== s.i) return; // stale button
    const ok = s.qs[i]!.a === k;
    const score = s.score + (ok ? 1 : 0);
    const next = i + 1;
    if (next < s.qs.length) {
      this.setSession({ ...s, i: next, score });
      await this.askQuestion(next, s.qs);
      return;
    }
    const ratio = score / s.qs.length;
    const level: Profile['level'] = ratio < 0.4 ? 'zero' : ratio < 0.75 ? 'beginner' : 'confident';
    const old = this.d.store.profile();
    if (old) this.d.store.saveProfile({ ...old, level, placementScore: ratio });
    else this.ensureProfile(level, ratio);
    this.setSession({ mode: 'idle' });
    const text = {
      zero: 'Уровень: с нуля. Это нормальная точка старта: идём по программе с дня 1, начнём с тонов и самых нужных слов.',
      beginner: 'Уровень: начальный. Кое-что ты уже знаешь. Идём с дня 1, первые дни будут быстрыми, а карточки закрепят слова.',
      confident: 'Уровень: уверенный старт. Первые дни могут показаться лёгкими: проходи их быстро и опирайся на карточки и тоны.',
    }[level];
    await this.send(`Тест окончен: ${score} из ${s.qs.length}.\n\n${text}`, [[b('Начать урок дня 1', 'go:lesson')]]);
  }

  // ---- lesson ----

  private lessonFor(day: number): Lesson | undefined {
    return this.d.content.lessons[day - 1];
  }

  private async startLesson(): Promise<void> {
    const p = this.ensureProfile();
    const lesson = this.lessonFor(p.lessonDay);
    if (!lesson) {
      this.setSession({ mode: 'idle' });
      await this.send(
        `Первые ${this.d.content.lessons.length} дней пройдены! Новые уроки появятся позже. Пока держим слова в форме: карточки и тоны.`,
        [[b('Карточки', 'go:review'), b('Тоны', 'go:tones')]],
      );
      return;
    }
    this.setSession({ mode: 'lesson', day: lesson.day, step: 0, score: 0, answered: false });
    await this.renderStep(lesson, 0, 0);
  }

  private nav(step: number, explain = true): Button[][] {
    return [[b('Дальше', `l:next:${step}`), b('Повтори', `l:again:${step}`)], ...(explain ? [[b('Объясни по-русски', `l:explain:${step}`)]] : [])];
  }

  private wordText(lesson: Lesson, i: number): string {
    const w = this.d.content.words.get(lesson.words[i]!)!;
    return [`Слово ${i + 1} из ${WORDS_PER_LESSON}`, '', w.h, w.p, w.r, '', 'Пример:', w.e!.h, w.e!.p, w.e!.r].join('\n');
  }

  private dialogText(lesson: Lesson, withRu: boolean): string {
    const lines = lesson.dialog.lines.map((l) => `${l.who}: ${l.h}\n${l.p}${withRu ? `\n${l.r}` : ''}`);
    return [`Мини-диалог: ${lesson.dialog.title}`, `Ситуация: ${SITUATION_RU[lesson.situation]}`, '', ...lines.flatMap((l) => [l, ''])].join('\n').trim();
  }

  private async renderStep(lesson: Lesson, step: number, score: number): Promise<void> {
    const p = this.d.store.profile()!;
    if (step === 0) {
      await this.send(
        `День ${lesson.day} из ${this.d.content.lessons.length}: ${lesson.title}\nСитуация: ${SITUATION_RU[lesson.situation]}. Серия: ${days(this.currentStreak(p))}.\n\n${lesson.intro}`,
        this.nav(0),
      );
    } else if (step < STEP_DIALOG) {
      await this.send(this.wordText(lesson, step - 1), this.nav(step));
    } else if (step === STEP_DIALOG) {
      await this.send(`${this.dialogText(lesson, false)}\n\nПопробуй прочитать вслух, потом нажми «Объясни по-русски» за переводом.`, this.nav(step));
    } else if (step < STEP_FINISH) {
      const i = step - STEP_QUIZ;
      const q = lesson.quiz[i]!;
      await this.send(`Проверка, вопрос ${i + 1} из ${QUIZ_PER_LESSON}\n\n${q.q}`, q.o.map((o, k) => [b(o, `q:${i}:${k}`)]));
    } else {
      await this.finishLesson(lesson, score);
    }
  }

  private async lessonAction(s: Extract<Session, { mode: 'lesson' }>, action: string): Promise<void> {
    const lesson = this.lessonFor(s.day);
    if (!lesson) return;
    const step = s.step;
    if (action === 'again') return this.renderStep(lesson, step, s.score);
    if (action === 'explain') {
      if (step === 0) return this.send(`Про тоны:\n${lesson.tone_tip}`, this.nav(step, false));
      if (step < STEP_DIALOG) {
        const w = this.d.content.words.get(lesson.words[step - 1]!)!;
        return this.send(`${w.h} ${w.p}: ${w.r}.\n${w.n}`, this.nav(step, false));
      }
      if (step === STEP_DIALOG) return this.send(`${this.dialogText(lesson, true)}\n\n${lesson.dialog.note}`, this.nav(step, false));
      return;
    }
    if (action === 'next') {
      // The quiz step advances only through an answer, and "next" after an answer moves on.
      if (step >= STEP_QUIZ && step < STEP_FINISH && !s.answered) return;
      const next = step + 1;
      this.setSession({ ...s, step: next, answered: false });
      await this.renderStep(lesson, next, s.score);
    }
  }

  private async lessonAnswer(s: Extract<Session, { mode: 'lesson' }>, i: number, k: number): Promise<void> {
    const lesson = this.lessonFor(s.day);
    if (!lesson || s.step < STEP_QUIZ || s.step >= STEP_FINISH || i !== s.step - STEP_QUIZ || s.answered) return;
    const q = lesson.quiz[i]!;
    const ok = q.a === k;
    this.setSession({ ...s, answered: true, score: s.score + (ok ? 1 : 0) });
    const verdict = ok ? 'Верно!' : `Не совсем. Правильно: ${q.o[q.a]}.`;
    await this.send(`${verdict}${q.why ? `\n${q.why}` : ''}`, [[b('Дальше', `l:next:${s.step}`)]]);
  }

  private async finishLesson(lesson: Lesson, score: number): Promise<void> {
    const { store, content } = this.d;
    const p = store.profile()!;
    const t = this.now();
    const today = dateKey(t, p.tz);
    let added = 0;
    for (const h of lesson.words) {
      const w = content.words.get(h)!;
      if (store.addCard({ key: `w:${h}`, kind: 'word', h, p: w.p, r: w.r })) added++;
    }
    for (const l of lesson.dialog.lines) {
      if (l.card && store.addCard({ key: `p:${l.h}`, kind: 'phrase', h: l.h, p: l.p, r: l.r })) added++;
    }
    let streak = p.streak;
    if (p.lastLessonDate !== today) streak = p.lastLessonDate === addDays(today, -1) ? p.streak + 1 : 1;
    const advance = p.lessonDay === lesson.day;
    store.saveProfile({
      ...p, streak, bestStreak: Math.max(p.bestStreak, streak), lastLessonDate: today,
      lessonDay: advance ? p.lessonDay + 1 : p.lessonDay,
    });
    store.recordLesson(lesson.day, today, score);
    this.setSession({ mode: 'idle' });
    log('info', 'lesson finished', { day: lesson.day, score, newCards: added });
    const due = store.dueCount(t);
    const nextLesson = this.lessonFor(p.lessonDay + 1);
    await this.send(
      [
        `Урок дня ${lesson.day} пройден!`,
        `Правильных ответов: ${score} из ${QUIZ_PER_LESSON}.`,
        `Новых карточек: ${added}. На повторение ждут: ${due}.`,
        `Серия: ${days(streak)}.`,
        nextLesson && advance ? `Завтра: «${nextLesson.title}».` : '',
      ].filter(Boolean).join('\n'),
      [[b(`Карточки (${due})`, 'go:review'), b('Тоны 5 минут', 'go:tones')]],
    );
  }

  // ---- vocabulary review (FSRS) ----

  private async startReview(): Promise<void> {
    const { store, cfg } = this.d;
    const t = this.now();
    const cards = store.dueCards(t, cfg.reviewLimit);
    if (!cards.length) {
      this.setSession({ mode: 'idle' });
      const next = store.nextDue();
      const when = next ? `Следующая карточка: ${formatSlot(next, this.tz(), 'ru')}.` : 'Карточки появятся после первого урока.';
      await this.send(`На сейчас карточек нет. ${when}`, [[b('Урок дня', 'go:lesson'), b('Тоны', 'go:tones')]]);
      return;
    }
    this.setSession({ mode: 'review', queue: cards.map((c) => c.key), shown: false, done: 0, total: cards.length });
    await this.send(`Повторение: ${cards.length} ${plural(cards.length, 'карточка', 'карточки', 'карточек')}, около 10 минут. Вспомни значение, потом нажми «Показать».`);
    await this.showCard(cards[0]!, 1, cards.length);
  }

  private async showCard(c: Card, n: number, total: number): Promise<void> {
    await this.send(`Карточка ${n} из ${total}\n\n${c.h}`, [[b('Показать', `r:show:${n}`)]]);
  }

  private async reviewAction(s: Extract<Session, { mode: 'review' }>, action: string, n: number): Promise<void> {
    const { store } = this.d;
    const key = s.queue[0];
    if (!key) return;
    const card = store.card(key);
    if (!card) return;
    if (action === 'show') {
      if (s.shown) return;
      this.setSession({ ...s, shown: true });
      await this.send(
        `${card.h}\n${card.p}\n${card.r}`,
        [[b('Снова', `r:g1:${s.done}`), b('Трудно', `r:g2:${s.done}`)], [b('Хорошо', `r:g3:${s.done}`), b('Легко', `r:g4:${s.done}`)]],
      );
      return;
    }
    const m = /^g([1-4])$/.exec(action);
    if (!m || !s.shown || n !== s.done) return;
    const grade = Number(m[1]) as Grade;
    const t = this.now();
    const prev = card.reps > 0 ? card : null;
    const elapsed = card.lastReview ? (t - card.lastReview) / DAY_MS : 0;
    const mem = review(prev, grade, elapsed);
    store.saveReview(key, grade, mem, dueAt(mem, grade, t, this.tz()));
    const queue = s.queue.slice(1);
    if (grade === 1 && s.queue.length < this.d.cfg.reviewLimit * 2) queue.push(key); // "again" comes back in this session
    const done = s.done + 1;
    if (!queue.length) {
      this.setSession({ mode: 'idle' });
      const next = store.nextDue();
      await this.send(
        `Повторение окончено: ${done} ответов. Слов в активе: ${store.activeWords()}.\nСледующая карточка: ${next ? formatSlot(next, this.tz(), 'ru') : 'после следующего урока'}.`,
        [[b('Тоны 5 минут', 'go:tones'), b('Урок дня', 'go:lesson')]],
      );
      return;
    }
    this.setSession({ ...s, queue, shown: false, done });
    const nextCard = store.card(queue[0]!)!;
    await this.showCard(nextCard, done + 1, Math.max(s.total, done + queue.length));
  }

  // ---- tone drill ----

  private async startTones(): Promise<void> {
    const sets = this.d.content.tones;
    const picks = this.shuffle(sets.flatMap((set) => set.items.map((item) => ({ set, item })))).slice(0, TONES_PER_SESSION);
    const qs: Q[] = picks.map(({ set, item }) => ({
      q: `${item.h}: ${item.r}.\nКакое у него чтение?`,
      o: set.forms,
      a: item.tone - 1,
      why: `${set.forms[item.tone - 1]}: тон ${item.tone}.`,
    }));
    this.setSession({ mode: 'tones', i: 0, score: 0, qs });
    await this.send('Тоны, 5 минут. Выбери верное чтение иероглифа.');
    await this.askQuestion(0, qs);
  }

  private async tonesAnswer(s: Extract<Session, { mode: 'tones' }>, i: number, k: number): Promise<void> {
    if (i !== s.i) return;
    const q = s.qs[i]!;
    const ok = q.a === k;
    const score = s.score + (ok ? 1 : 0);
    const prefix = ok ? 'Верно!' : `Не совсем. ${q.why}`;
    const next = i + 1;
    if (next < s.qs.length) {
      this.setSession({ ...s, i: next, score });
      await this.send(prefix);
      await this.askQuestion(next, s.qs);
      return;
    }
    this.setSession({ mode: 'idle' });
    await this.send(`${prefix}\n\nТоны: ${score} из ${s.qs.length}. Завтра ещё пять, так ухо привыкает быстрее всего.`, [[b('Урок дня', 'go:lesson'), b('Карточки', 'go:review')]]);
  }

  // ---- free conversation (LLM) ----

  private async startTalk(): Promise<void> {
    if (!this.d.llm.enabled) {
      await this.send('Свободный разговор включается, когда подключена языковая модель (сейчас режим «LLM off»). Пока: /lesson и /review работают полностью.');
      return;
    }
    this.setSession({ mode: 'talk' });
    await this.send('Режим разговора. Пиши по-китайски или по-русски, я отвечу короткой фразой с пиньинем и переводом и мягко поправлю ошибки. Выйти: /stop.');
  }

  private async stopTalk(): Promise<void> {
    if (this.session().mode === 'talk') this.setSession({ mode: 'idle' });
    this.d.store.clearTalk();
    await this.send('Разговор закончили. /lesson или /review.');
  }

  private async talk(text: string): Promise<void> {
    const { store, llm, content } = this.d;
    const p = store.profile();
    const lesson = p ? this.lessonFor(Math.min(p.lessonDay, content.lessons.length)) : undefined;
    const known = lesson ? lesson.words.join(', ') : '';
    const system = [
      'You are Polly, a friendly Chinese teacher for a Russian-speaking absolute beginner whose goal is travel and everyday talk.',
      lesson ? `Today's situation: ${SITUATION_RU[lesson.situation]}. Words of the day: ${known}.` : '',
      'Reply with at most three short lines: one very simple Chinese sentence (HSK 1 vocabulary), its pinyin with tone marks, and a Russian translation. If the learner made a mistake, add one short Russian line with the fix.',
      'Plain text only, no markdown, no emoji. Never discuss prices or money.',
    ].filter(Boolean).join('\n');
    const clean = text.trim().slice(0, 500);
    store.addTalk('user', clean);
    const reply = await tryComplete(llm, { tier: 'sonnet', maxTokens: 400, system, messages: store.recentTalk(8) });
    if (!reply) {
      await this.send('Не получилось ответить, попробуй ещё раз через минуту.');
      return;
    }
    const out = reply.slice(0, 1200);
    store.addTalk('assistant', out);
    await this.send(out);
  }

  // ---- reminders and the weekly report ----

  /** Called every minute: sends the lesson reminder and the Sunday report once each, in the learner's own time zone. */
  async tick(at: number = this.now()): Promise<void> {
    const { store, cfg } = this.d;
    const p = store.profile();
    if (!p) return;
    const lp = zonedParts(at, p.tz);
    const today = dateKey(at, p.tz);
    const mins = lp.h * 60 + lp.mi;
    const toMin = (hhmm: string): number => {
      const [h, m] = hhmm.split(':').map(Number) as [number, number];
      return h * 60 + m;
    };
    // A restart within an hour after the set time still sends it, once.
    const within = (hhmm: string): boolean => mins >= toMin(hhmm) && mins < toMin(hhmm) + 60;

    if (within(p.lessonTime) && !store.getKv(`reminder:${today}`) && !store.lessonDoneOn(today)) {
      store.setKv(`reminder:${today}`, '1');
      const lesson = this.lessonFor(p.lessonDay);
      const due = store.dueCount(at);
      await this.send(
        lesson
          ? `Время урока! День ${lesson.day}: ${lesson.title}. Серия: ${days(this.currentStreak(p))}.${due ? ` Карточек на повторение: ${due}.` : ''}`
          : `Время заниматься! Карточек на повторение: ${due}.`,
        [[b(lesson ? 'Начать урок' : 'Карточки', lesson ? 'go:lesson' : 'go:review')]],
      );
    }
    if (lp.dow === 0 && within(cfg.weeklyAt) && !store.getKv(`weekly:${today}`)) {
      store.setKv(`weekly:${today}`, '1');
      await this.send(this.report(true));
    }
  }

  /** Week summary: study minutes, lessons, reviews, words in the active vocabulary, streak. */
  report(weekly: boolean): string {
    const { store } = this.d;
    const p = this.ensureProfile();
    const t = this.now();
    const since = t - 7 * DAY_MS;
    const minutes = store.activeMinutes(since, t);
    const target = p.minutesPerDay * 7;
    return [
      weekly ? 'Итоги недели' : 'Статистика за 7 дней',
      `Время занятий: ${minutes} мин из ${target}`,
      `Уроков пройдено: ${store.lessonsSince(since)}`,
      `Ответов на карточки: ${store.reviewsSince(since)}`,
      `Слов в активе: ${store.activeWords()} (всего карточек ${store.cardCount()})`,
      `Серия: ${days(this.currentStreak(p))}, рекорд ${days(p.bestStreak)}`,
      weekly ? 'Хорошей недели! Если какой-то день пропущен, ничего страшного: вернись с карточек.' : '',
    ].filter(Boolean).join('\n');
  }
}

const HELP = [
  '/lesson: урок дня',
  '/review: карточки (повторение по FSRS)',
  '/tones: тоны, 5 минут',
  '/talk: свободный разговор (нужна языковая модель), /stop выйти',
  '/test: тест уровня',
  '/profile: профиль и прогресс',
  '/stats: итоги за 7 дней',
  '/time 19:30: время напоминания об уроке',
].join('\n');
