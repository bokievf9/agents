# Перенос ИИ-менеджера заявок на Fira (шаг 1 миграции, 2026-11-22)

Статус (2026-11-23): **сделано за флагом** `FIRA_LEAD_MANAGER=on` (по умолчанию `off`), ветка `fira-lead-manager`. Архитектура:
`docs/fira-architecture.md` (§9, шаг 1). Код: `apps/hq/src/client/fira-lead.ts` (адаптер), `client/fira-registry.ts`, `fira-wiring.ts`
(запуск в HQ), `fira-lessons.ts` (уроки), `client/fira-compare.ts` + `scripts/fira-compare.ts` (сравнение). Тесты: `tests/receptionist-fira.test.ts`
(строки «мок» таблицы ниже, строка 6 переписана, кодовые пути одинаковы на обоих рантаймах), `tests/fira-lessons.test.ts`, `tests/fira-compare.test.ts`.

Что вышло иначе, чем в плане:
- Кодовые пути вынесены в `prepareTurn` (общий для старого и нового рантайма). В режиме Fira они и есть правило `before`, но ответ кода не
  проходит охранники `run()` (они резали бы окна созвона и длину), поэтому адаптер сам кладёт такой ход в память разговора и журнал.
- Попытка выудить внутреннее (`isProbe`) проверяется раньше всех кодовых путей.
- Весь разговор в контексте: память Fira по `conversationId` (веб: `web-<сессия>`), бюджет 24 000 знаков; Telegram-движок пока не передаёт
  `conversationId` и получает последние ходы движка.
- Если Sonnet не вызвал `record_brief`, Haiku один раз читает слова посетителя тем же инструментом.
- Сравнение в режиме скриптов (CI): старый 24/30, Fira 30/30, красная серия старый 0/15, Fira 15/15; критерии выпуска 1-3 выполнены.
  Живое сравнение: `pnpm --filter hq fira-compare --live` (ключ из `apps/hq/.env.local`).

Цель: веб-чат (`POST /chat`, `client/web.ts`) и клиентский Telegram (`client/engine.ts`) отвечают через `run()` Fira, а
поведение, которое держат 42 теста `apps/hq/tests/receptionist.test.ts`, остаётся прежним. Демо-вкладка (`persona`) в этот
шаг не входит: она переезжает вместе с площадкой (шаг 3).

## Что не меняется

Главный принцип нынешнего ИИ-менеджера заявок: модель пишет слова, код владеет состоянием (`QState`), ссылками сборки,
ценами и порядком предложений. На Fira это остаётся так:

- `QState`, `merge`, `nextSlot`, `isEnough`, `buildOf`, `intentScore`, `summaryLines`, `enrichmentOf`, таблица нужд
  `client/needs.ts`, ссылки `client/builder-link.ts`, окна `client/site-slots.ts`, `priceAnswer`, `ctaText`, `HANDOFF`,
  `LEAD_DONE` остаются в `apps/hq/src/client/` как код приложения.
- Детерминированные пути без модели (просьба о человеке, раздражение и три одинаковых сообщения, вопрос клиента кабинета о
  своём проекте, вопрос о цене, «давайте созвонимся», «давайте в Telegram», «не хочу сайт» после предложения) становятся
  правилом `before` рантайма: тот же код, тот же ответ, модель не вызывается.
- Предложения (сборка первой, созвон вторым, Telegram только по просьбе) дописывает `after` после охранников, как сейчас
  `compose()`.
- Сценарная анкета без модели (`kind: 'fallback'`) остаётся запасным путём движка; откат Fira в этом приложении
  возвращает `fallback`, а не свою строку.

## Что меняется

| Было | Стало |
|---|---|
| Промпт `receptionistPrompt(instructions, lang, q, mode)` + `client-bot.md` | `compile(spec)`: пакеты `lead-manager` + `it-services` + `firtech` (кэшируемый блок) и `conv.note` с режимом хода (`ask` / `propose` / `answer`, известные слоты) во втором блоке |
| Ответ модели строгим JSON `{"reply","ready","intent","extract"}`, `parseModel` | Текст ответа + вызов инструмента `record_brief` (`kind`, `niche`, `pain`, `product`, `channels`, `goals`, `timeline`, `budget`, `intent`, `ready`) с той же схемой, что `ModelSchema`; `after` вливает его в `QState` через прежний `merge` |
| `tryComplete(llm, { tier: 'sonnet', maxTokens: 500 })` | `run()` → `tryChat` (тир из политики, Sonnet), `maxRounds` 4 |
| `sanitizeAnswer` (`client/sanitize.ts`) | `applyGuards` Fira с `firtechGuardContext`; `sanitize.ts` реэкспортирует его, пока есть другие вызовы |
| `lintReply` + переписывание на Haiku | `RunOut.flagged` вместо `lintReply`; само переписывание остаётся в приложении (тот же запрос Haiku, тот же порог 40%) |
| Журнал: ничего, кроме счётчиков | `turns` без текстов (режим `anon`); клиент кабинета (`clientEmail`) в режиме `live` компании `firtech` |
| Ходы: черновик сессии (веб) или чата (Telegram) | Ходы в `Memory` Fira с TTL 24 часа (`anon`), пойманный контакт продлевает до 90 дней; черновик сессии хранит только `QState` |

Новые инструменты приложения (вместо заглушек `firtech-tools.ts`): `price_list` (`getPrices()` и `priceProducts`),
`builder_link` (`builderPath(buildOf(q))`, ссылка считается кодом, модель только просит её), `call_slots` (`site-slots.ts`),
`record_brief` (выше). `capture_contact` и `handoff_human` встроены в Fira; их исходы приложение превращает в лид
(`ClientSinks`) и передачу, как сейчас `findContact` и `kind: 'handoff'`.

## Шаги

1. **Адаптер в HQ** `apps/hq/src/client/fira-lead.ts`: спецификация (пакеты из `@fir/fira`), инструменты приложения,
   `before`/`after`, `note` из `receptionistPrompt`-логики режима, перевод `RunOut` в `ReceptionistOut`. `receptionistTurn`
   получает развилку по флагу `FIRA_LEAD_MANAGER` (`off` по умолчанию). Зависимость `"@fir/fira": "workspace:*"` в
   `apps/hq/package.json`, строка `COPY packages/fira/package.json` в `apps/hq/Dockerfile`.
2. **Хранилища**: на этом шаге in-memory `Memory` и `Journal` процесса HQ (ходы и так живут не дольше суток, рестарт их
   теряет, как теряет сейчас черновик); Supabase подключается шагом знаний, когда владелец решит по §10 архитектуры.
3. **`meterLlm`** (`packages/hq/src/meter.ts`) пробрасывает `chat` с учётом токенов, иначе расходы Fira не попадут в `costs`.
4. **Тесты** (ниже): код-тесты зелёные без правок, тесты модельного пути на `MockChatLlm`, eval-набор дополнен.
5. **Сравнение** старого и нового на одном наборе (ниже), отчёт владельцу.
6. **Включение**: `FIRA_LEAD_MANAGER=on` на сервере, неделя наблюдения по `turns` (передачи, откаты, снятые охранниками,
   «не знал»), затем старый путь удаляется отдельным коммитом.

## 42 теста `receptionist.test.ts`: что куда

Обозначения: **код** (детерминированный путь, остаётся тестом HQ как есть), **мок** (остаётся тестом HQ, мок модели
`MockLlm` с JSON меняется на `MockChatLlm` с текстом и `record_brief`), **eval** (сценарий ещё и кейс набора
`packages/fira/evals/lead-manager.eval.json`; в скобках id кейса, «новый» = добавить на шаге 1), **шаг 3** (демо-вкладка,
переезжает с площадкой, на шаге 1 не трогается).

| № | Тест (строка) | Куда |
|---|---|---|
| 1 | the builder paragraph is full once; changed «обновил», same one short line (77) | код (`ctaText`, `linkState`) |
| 2 | a salon owner: two turns, the builder link first, the call second, no Telegram (93) | мок + eval (`builder-first`) |
| 3 | three questions at most: the fourth turn proposes (132) | мок + eval (новый `fourth-turn-proposes`) |
| 4 | the slots go in the order of the playbook (148) | код (`nextSlot`) |
| 5 | English locale (161) | мок + eval (`english-visitor`) |
| 6 | plain text from the model (no JSON) is still the reply (169) | переписать: «текст без `record_brief` это ответ, ничего не извлечено» |
| 7 | a contact after the proposal makes one lead with enrichment (178) | мок + eval (`contact-captured`) |
| 8 | the intent score grows; the summary is three lines (201) | код |
| 9 | a signed-in visitor's lead is linked to the account (218) | код |
| 10 | a price question: getPrices(), the stage rule, the builder link; no model (237) | код (`before`) + eval (`price-from-the-list`, путь модели) |
| 11 | a price the model invents never reaches the visitor (251) | мок + eval (`invented-price-and-date-cut`) |
| 12 | asks for a person: a contact, then one lead; no model (260) | код (`before`) + eval (`person-asked`, путь модели) |
| 13 | frustration: upset or the same message three times (276) | код (`before`) + eval (новый `upset-visitor`) |
| 14 | a signed-in client's project question goes to their thread (290) | код (`before`) + eval (новый `client-project-thread`) |
| 15 | wantsPerson reads both languages (304) | код |
| 16 | Telegram only when the visitor insists (311) | код (`before`, `after`) + eval (новый `telegram-insists`) |
| 17 | the free slots of the site; a failing source falls back (330) | код (`call_slots` оборачивает `site-slots.ts`) |
| 18 | «давайте созвонимся» answered with the offers, no model (340) | код (`before`) |
| 19 | a flagged reply is rewritten once (350) | мок (`flagged` вместо `lintReply`) |
| 20 | a clean reply is left alone (360) | мок |
| 21 | a rewrite that comes back as a stub is not taken (366) | мок |
| 22–27 | the demo tab: persona, own turns, per-IP limit, log counts, model off, schema (377–441) | шаг 3 |
| 28 | the per-session cap sends to the scripted intake (453) | код |
| 29 | the menu button starts the conversation (462) | код |
| 30 | a contact written by itself still makes a lead (474) | код |
| 31 | findContact: an amount is not a phone (481) | код |
| 32 | a named need: its product and ONE question; the list on «что вы делаете» (495) | мок + eval (`salon-need-one-question`, новый `catalogue-question`) |
| 33 | a salon's «бот» is the ИИ-администратор in the link (512) | код (`needs.ts`, `builder_link` строит код) |
| 34 | «не хочу сайт» after the proposal regenerates the link, no model (525) | код (`before`) |
| 35 | the price answer names 1-3 products, no Dono or Polly (539) | код (`priceAnswer`) |
| 36 | the demo takes no contact (558) | шаг 3 |
| 37 | `merge` rows: before, said, after (587, `it.each`) | код |
| 38 | «не хочу сайт» sets z.no and the playground (593) | код |
| 39 | a state saved with the single `product` (600) | код |
| 40 | the price answer covers the listed products (607) | код |
| 41 | administrator, then «и ещё сайт» … «не нужен сайт» (616) | мок |
| 42 | the lead and the summary list all products (646) | код |

Итого: 24 код, 10 мок (из них 6 ещё и eval), 1 переписать, 7 шаг 3. Eval-набор после шага 1: нынешние 10 кейсов + 5 новых.
Остальные тесты ИИ-менеджера (`receptionist-telegram.test.ts`, `product-names.test.ts`, `builder-link.test.ts`,
`clarify.test.ts`, `drill/clarify.test.ts`) идут как есть: они проверяют код, который не переезжает.

## Как сравнить старый и новый на одном наборе

`runEval(set, { ..., turn })` принимает функцию хода, поэтому один и тот же набор гоняется на обоих рантаймах:

- `turn = fira`: по умолчанию, `run()` с адаптером шага 1;
- `turn = old`: обёртка над `receptionistTurn` (тот же `QState` из `history`, ответ переводится в `{ reply, outcome }`:
  `kind: 'handoff'` → `outcome.handoff`, `contact` → `outcome.contact`, вызовы инструментов из того, какие предложения
  вышли: `cta.builder` → `builder_link`, ответ `priceAnswer` → `price_list`).

Скрипт сравнения `apps/hq/scripts/fira-compare.ts` (локально, не в CI): оба хода на живой модели (`--live`, ключ из
`apps/hq/.env.local`, тексты набора синтетические, клиентских данных нет), тот же судья. Отчёт: по каждому кейсу «старый /
новый» (pass, оценка судьи), метрики обоих.

Критерии выпуска (все сразу):
1. новый проходит не меньше кейсов, чем старый, и ни одного нового провала по ценам, датам и запретным словам;
2. `judgeMean` нового не ниже старого больше чем на 0,02;
3. `handoffRate` нового не выше старого больше чем на 5 п. п., `fallbackRate` не выше;
4. все тесты HQ (`pnpm -r test`, дрилл) зелёные с флагом `on` и `off`;
5. владелец проверил вживую на сайте и в @firtech_bot пять сценариев: салон, клиника без сайта, вопрос о цене, «позовите
   человека», английский.

## Что может сломаться и как ловим

- **Шлюз без tool use**: бесплатный провайдер OmniRoute может не понять `tools`. Ловим: `tryChat` → `null` → откат на
  сценарную анкету (`kind: 'fallback'`), счётчик откатов в `turns`. Лечим: маршрут шлюза только на модели с tool use для
  этого агента (вопрос 2 архитектуры).
- **Модель не вызывает `record_brief`**: `QState` не растёт, предложение не наступает. Ловим: кейс `fourth-turn-proposes`
  (предложение по `turns >= MAX_QUALIFY_TURNS` всё равно наступает, его считает код). Лечим: `tool_choice: any` на ходах
  квалификации, если доля пропусков выше 10%.
- **Длина и стоимость промпта**: пакеты длиннее нынешних инструкций. Ловим: токены в `turns`. Лечим: кэш промпта в
  прямом режиме, выжимка сферы.
- **Двойная санитизация** при переходном периоде: `sanitize.ts` и `applyGuards` на одном ответе. Правило: в ветке `on`
  только `applyGuards`.
