# fir-agents

Монорепо исполнителей Fir Tech: общее тело `packages/core`, ядро компании `packages/hq`, исполнители `packages/workers/*`
и процессы в `apps/<агент>` (`apps/hq`: Директор и головы отделов). Компания и роли:
`../COMPANY.md`, бриф фазы 0: `../docs/brief-agents-core.md`. Правила workspace (git как `bokievf9`, без
`Co-Authored-By`, секреты не печатать, ветки, merge после проверок) в `../CLAUDE.md`.
Образец ядра: `../dono/` (Dono переедет на ядро позже; пока его код не трогаем).

## Стек
Node 22, TypeScript ESM (NodeNext), pnpm 12 workspaces. `grammy` (long polling), `better-sqlite3`, `croner`,
`@anthropic-ai/sdk`, `zod`, `vitest`, `eslint`. TypeScript закреплён на 6.x (как в Dono).

## Проверки
`pnpm -r typecheck && pnpm lint && pnpm -r test && pnpm -r build`. Запуск головы локально:
`pnpm --filter hq dev` (берёт `apps/hq/.env.local`, пример `.env.example` рядом).
Внутри монорепо `@fir/core` подключается из исходников через условие экспорта `source` (tsx, vitest, typecheck);
сборка и образ используют `dist`, поэтому `pnpm -r build` собирает ядро первым.

## packages/core (`@fir/core`)
- `env.ts`: общий конфиг (`loadBaseConfig`: токен бота, `OWNER_TELEGRAM_ID`, `TZ` и `OWNER_TZ`, `DATA_DIR`, порог доверия, LLM).
- `db.ts`: SQLite (WAL), `migrate()` для схемы головы. `time.ts`: часовые пояса через Intl.
- `bot.ts`: `createBot`, `grammyMessenger`, `installApprovals` (кнопки и правка владельца), `setupBotMenu` (команды,
  описания, кнопка меню), `startPolling`. `messenger.ts`: интерфейс `Messenger` (HTML, reply-клавиатура, `edit` с кнопками,
  `editButtons`; в тестах `MemoryMessenger`, сеть не нужна), `escapeHtml`/`stripHtml`. Вид карточек одобрений задаёт
  приложение (`queue.setCardFormat`), после решения ядро правит карточку на месте (`settleCard`). UX Директора: `apps/hq/docs/telegram-ux.md`.
- `scheduler.ts`: `schedule(name, cron, tz, job)` на croner, ошибка задачи логируется и не роняет процесс.
- `approvals.ts`: **очередь одобрений**. Голова регистрирует тип действия (`register(kind, {initialLevel, locked, execute})`)
  и вызывает `propose(kind, payload, summary)`. Уровень 0: владельцу уходит сообщение с кнопками
  «Одобрить / Править / Отклонить», действие (`execute`) выполняется только после «Одобрить». «Править»: следующее сообщение
  владельца заменяет `payload.text`, счётчик сбрасывается, одобрение правленого не засчитывается. Счётчик
  одобрений подряд без правок на тип; после `TRUST_THRESHOLD` (20) тип переходит на уровень 1 (делает сам, отчитывается).
  `locked: true` (цены, деньги, договоры): счётчик не повышает уровень, только решение владельца (`setLevel`).
  Журнал решений в таблице `decisions`: тип, решение, время, без текстов.
- `llm.ts`: клиент Claude за интерфейсом `LlmClient` (агенты не импортируют SDK). См. раздел LLM.
- `log.ts`: JSON-логи. **В логи только id и счётчики, никогда тексты, имена и контакты клиентов.**

## LLM: через шлюз OmniRoute, режим «LLM off»
LLM в компании ходит не напрямую в Anthropic, а через OmniRoute: локальный шлюз с Anthropic-совместимым
`POST /v1/messages` (dev: `http://127.0.0.1:20128`; на сервере отдельный контейнер во внутренней сети
`agents-net`, наружу не торчит). Клиент на Anthropic SDK с настраиваемым `baseURL`:
- `LLM_BASE_URL` + `LLM_API_KEY`: режим шлюза. Модели `LLM_MODEL_FAST` (разметка, извлечение) и
  `LLM_MODEL_SMART` (тексты, диалоги), по умолчанию `auto`. В запросе только обычные параметры Messages:
  бесплатные провайдеры за шлюзом не знают Claude-опций.
- Без `LLM_BASE_URL`, но с `ANTHROPIC_API_KEY`: прямой Anthropic, модели `claude-haiku-5-5` и `claude-sonnet-5-5`
  (переопределяются теми же `LLM_MODEL_*`), низкий effort, для Sonnet серверный fallback при отказе.
- Нет ключа: **«LLM off»**. В лог один раз `LLM off`, агент отвечает шаблонами и эвристиками, ничего не вызывается.
- Бесплатные провайдеры нестабильны, поэтому: таймаут `LLM_TIMEOUT_MS` (30 с) и `LLM_MAX_RETRIES` (2) на уровне SDK;
  структурные ответы только через `tryJson(llm, req, zodSchema)`: строгий разбор JSON (снимает code fence и
  болтовню вокруг), проверка схемой, при мусоре повторный запрос с текстом ошибки (до 3 вызовов), иначе `null`.
  Любая ошибка модели превращается в `null`/`tryComplete` и откат на шаблон, агент не падает.
- Правило для голов: никогда не использовать ответ модели как команду без проверки; цены, сроки и деньги
  модель сама не называет (ставит `[цена]`, владелец правит).
- Тесты: `MockLlm`, настоящий API в тестах не зовём.

## Как добавить нового агента («новая голова»)
1. `apps/<имя>/`: `package.json` (зависимость `"@fir/core": "workspace:*"`, скрипты как у `lead-intake`),
   `tsconfig.json` (`customConditions: ["source"]`), `tsconfig.build.json`, `vitest.config.ts` (как у `lead-intake`),
   `.env.example`, `Dockerfile` (копия `apps/lead-intake/Dockerfile` с новым именем).
2. `src/config.ts`: `loadBaseConfig()` плюс свои переменные. `src/index.ts`: `openDb`, `createBot`, `grammyMessenger`,
   `createLlm(cfg.llm)`, `ApprovalQueue`, `installApprovals` (первым), свои команды и обработчики, `schedule(...)`.
3. Свои таблицы через `migrate(db, SQL)`. Каждое действие «наружу» (сообщение клиенту, пост, платёж) оформить
   типом одобрения (`register` + `propose`); деньги, договоры, цены: `locked: true`.
4. Тесты на `MemoryMessenger`, `MockLlm` и `openDb(':memory:')`: сценарий целиком без сети.
5. CI: скопировать job образа и деплоя из `.github/workflows/ci.yml`, добавить сервис в `compose.yaml`.
6. Дописать агента в этот файл.

## Продажи: Приёмщик лидов и Разведчик (исполнители под головой Продаж, этап 2 HQ)
Бывшие `apps/lead-intake` и `apps/prospector` теперь `packages/workers/lead-intake` и `packages/workers/prospector` (`run(task, ctx)`,
без бота и крона, таблицы `li_*` и `pr_*` в SQLite HQ). Голова: `apps/hq/src/heads/sales.ts` (бот `SALES_BOT_TOKEN`, он же
@firtech_leads_bot), webhook `POST /lead` (`x-lead-token` = `LEAD_WEBHOOK_TOKEN`, порт `WEBHOOK_PORT`) в `apps/hq/src/webhook.ts`
создаёт задачу отдела на лид. Рутины: карточки Разведчика 07:30 и дожимы 07:40 по времени владельца. Первый ответ лиду уровень 1, всё с ценой уровень 0
(`locked`); бизнесам в холодную пишет владелец вручную. Подробно: `apps/hq/README.md`, README пакетов.
Публичный бот клиентов `apps/hq/src/client/` (`CLIENT_BOT_TOKEN`, @firtech_bot, только с токеном): приветствие, анкета из 4 шагов (последний вопрос: есть ли у клиента домен и хостинг)
в лид продаж (`source: telegram`, `chatId`), «я уже клиент» в тикет, «позвать человека» (`/reply`, `/resume`), LLM-ответы через
санитайзер (без цен и дат), тихие часы, лимиты. Одобренные ответы лидам и тикетам из бота бот отправляет сам (`ClientChannel`).

## apps/polly: Polly, учитель языков (этап 1)
Личный агент владельца (бриф `../docs/brief-polly.md`). Отдельный бот (`POLLY_BOT_TOKEN`, не `TELEGRAM_BOT_TOKEN` лидов),
только `OWNER_TELEGRAM_ID`. Поэтому очереди одобрений нет: всё уходит только в чат владельца. Подробно: `apps/polly/README.md`.
- `teacher.ts`: движок (команды, кнопки, урок, повторение, тоны, тест уровня, `/talk`, `tick()` раз в минуту для
  напоминаний и воскресного отчёта по часовому поясу профиля). Состояние занятия в SQLite (`kv.session`), переживает рестарт.
  Кнопки урока несут номер шага, старые нажатия игнорируются.
- `fsrs.ts`: своя реализация FSRS-4.5 (без внешней библиотеки). `content.ts` + `content/zh/*.yaml`: словарь (318 слов по 9
  темам) и 14 уроков, данные в файлах, проверка при старте. `store.ts`: профиль, карточки, повторения, активность.
- LLM только в `/talk` (Sonnet/smart через `tryComplete`); без ключа «LLM off» и всё остальное работает.
- Голос (Whisper, edge-tts), испанский, турецкий, связь с Dono: этапы 2 и 3. Голосовые пока лежат в `voice_queue`.
- Запуск: `pnpm --filter polly dev` (`apps/polly/.env.local`). Docker: `apps/polly/Dockerfile`, сервис `polly` в
  `compose.yaml` (без портов, `read_only`, данные `/opt/fir-agents/data/polly`), образ `agents-polly` в CI.

## packages/hq, packages/workers, apps/hq: HQ (этап 1, 2026-11-19)
Спека `../docs/architecture-hq.md`. `packages/hq` (`@fir/hq`): SQLite-ядро (агенты, задачи с атомарным `claim`, журнал, одобрения через
очередь ядра, рутины, heartbeat раз в 30 с, расходы с лимитом отдела, activity, settings, `hq export/import` YAML). Исполнители
без бота и крона в `packages/workers/*` (`run(task, ctx)`): `content-maker` (бывший `apps/content-maker`). `apps/hq`: один процесс,
бот Директора (`HQ_BOT_TOKEN`), голова Маркетинга (`src/heads/marketing.ts`), инструкции агентов `apps/hq/instructions/*.md`.
Образ `agents-hq`, сервис `hq` (данные `/opt/fir-agents/data/hq`). Подробно: `packages/hq/README.md`, `apps/hq/README.md`.
Маркетинг на автопилоте, этап 1 (2026-11-19): пакет недели покрывает всю страницу Instagram (7 рилсов, 3 поста, 2 карусели, 5 историй;
`POSTS_PER_WEEK`, `STORIES_PER_WEEK`), после одобрения PNG рисуются `satori` + `@resvg/resvg-js` в `DATA_DIR/renders`, Публикатор шлёт альбом
и текст, публикует владелец вручную; `/profile` (разовый пакет настройки профиля); `/article [ниша|ии]` и рутина `marketing-article-daily` (ежедневно 07:30 по времени владельца)
пишут статью дня RU+EN (пн, ср, пт, вс «ИИ для бизнеса», вт, чт, сб ниша); одобренная публикуется самим HQ (публичный `GET /blog`, `docs/public-api.md`), в пакет недели из неё идут карусель и рилс. Telegram-канала нет (владелец отказался).

YouTube Shorts автоматом (2026-11-20, этап 2): при `YT_OAUTH_CLIENT_JSON` + `YT_REFRESH_TOKEN` Публикатор утром сам грузит одобренные Shorts с MP4 (`YouTubePoster`, resumable upload, квота 1600 из 10 000 в `pb_quota`, потолок 9000, одна попытка на строку в сутки, сбой остаётся ручным с причиной в `pb_posts.error`); `YT_PRIVACY=unlisted` для проб; токен один раз через `pnpm --filter hq yt-auth` (в буфер, не на экран); `safePost` в `packages/core/src/net.ts` (https, список хостов, без редиректов); Аналитик добавляет строку «YouTube за неделю». См. `packages/workers/publisher/README.md`.

Instagram автоматом (2026-11-20, этап 2): при `IG_USER_ID` + `IG_ACCESS_TOKEN` Публикатор утром сам публикует рилсы, посты, карусели и истории через Meta Graph API (`InstagramPoster` в `packages/workers/publisher/src/instagram.ts`, `IgApi` поверх `safeGetJson`/`safePost`, хосты `META_HOSTS` в core, токен только в заголовке). Файлы Graph API берёт по публичному URL: `GET /media/<hmac32>/<путь>` на вебхуке HQ (`resolveMedia`, только `DATA_DIR/renders`, секрет `MEDIA_SECRET` или `WEB_CHAT_TOKEN`, база `IG_PUBLIC_BASE`, nginx проксирует `/media/` на 127.0.0.1:8787, блок в README публикатора). Рилс, не успевший обработаться, держит `pb_posts.container_id` и завершается следующим запуском (`PostPending`); потолок 45 из 50 публикаций в сутки; `InstagramDaily` проверяет токен (раз в сутки алерт при истечении, предупреждение за 7 дней по `IG_TOKEN_ISSUED_AT`) и собирает комментарии в `pb_comments` (ответов пока нет, колонка `replied`); Аналитик добавляет строку «Instagram за неделю».

Видео рилсов (2026-11-19): `packages/renderer` (Remotion + Piper `ru_RU-denis-medium`), сервис `renderer` в `compose.yaml` (1,5 ГБ, без сети, общий том с `hq`),
очередь `cm_render_jobs` в SQLite HQ, образ `agents-renderer` в CI. Одобренный рилс ставится в очередь, утром Публикатор шлёт MP4; `/render <id>`; `REELS_RENDER=off`
возвращает путь через `builder`. `packages/clips` (локальный инструмент на Mac) остаётся как есть. Подробно: `packages/renderer/README.md`.

## Цены, токены, аудит (2026-11-19, по аудиту)
- Цены в одном месте: прайс-лист сайта `GET https://firtech.pro/api/prices`. `packages/core/src/prices.ts` (`getPrices()`, `loadPrices()`, снимок `prices.fallback.json`):
  HQ грузит его при старте и каждые 6 часов (`PRICES_URL`), последняя хорошая копия лежит в `settings.prices_json`. Исполнители и клиентский бот читают `getPrices()`,
  суммы в коде не пишем (тест `packages/core/tests/prices.test.ts` это проверяет). Оплата: USDT TRC20/TON или онлайн-кошелёк из сметы (`PAYMENT_DETAILS_JSON`: `usdt_trc20`,
  `usdt_ton`, `wallet`), 50% до старта и 50% после приёмки.
- `ADMIN_TOKEN` и `WEB_CHAT_TOKEN` обязательны для своих маршрутов (`/admin/*`, `/chat`), без них 404, фолбэков на `OFFICE_TOKEN` и `LEAD_WEBHOOK_TOKEN` нет. IP посетителя: `x-visitor-ip`
  (верим только с loopback и шлюза docker при верном токене).
- Аудит: карточка `audit` уходит сразу (`urgent`), алерт через 20 часов, при старте `running` возвращается в `assigned`. Образ OmniRoute закреплён по digest: `docs/omniroute-image.md`.

## Точные цифры и условия (2026-11-19)
КП, смета, договор и счёт называют одну точную цену выбранного пакета из прайс-листа сайта (`packages/workers/presales/src/package.ts`, сумма вариантов и допов; подписки: настройка и точная месячная плата), «от» остаётся только в сообщениях,
где состав ещё неизвестен (Разведчик, клиентский бот). Во всех четырёх документах одна фиксированная строка про домен, хостинг, сервер и платные сторонние сервисы (`costsLine` в `packages/core/src/conditions.ts`);
если у лида `has_domain` и `has_hosting` (шаг 4 клиентского бота, `li_leads`), строка короче. Оплата 50/50 и гарантия первого результата не менялись.

## Оплата USDT по ссылке (2026-11-19)
Каждый счёт получает `pay_key` и ссылку `${SITE_URL}/<ru|en>/pay/<номер>?k=<ключ>` (в тексте счёта и карточке, адреса кошельков в чат не пишем), уникальную сумму к переводу (`pay_amount_usd`, центы
при совпадении с другим открытым счётом). Публичный `GET /pay/:number?k=` (`apps/hq/src/pay.ts`, формат в `docs/public-api.md`). Голова Сопровождения раз в 2 минуты (`billing-payment-watch`,
свой cron) читает TronGrid и toncenter через `safeGetJson` ядра (`packages/core/src/net.ts`, туда же переехали SSRF-помощники аудита), сверяет переводы (`packages/workers/billing/src/{chain,watch}.ts`,
таблица `bl_payments`) и проводит оплату теми же шагами, что `/paid`. Env: `TRONGRID_API_KEY`, `TONCENTER_API_KEY`, `PAY_TOLERANCE` (все необязательны).

## Надёжность ядра (2026-11-19, часть A аудита)
Подробности и команды: `apps/hq/README.md`, раздел «Надёжность ядра». Коротко: головы работают независимо (до 3 одновременно); все отправки в Telegram идут через `OutboxMessenger`
(пауза 1,1 с, повтор на 429/5xx); одобрение забирается атомарно, карточка считается отправленной только после ответа Telegram; рутины из кода синхронизируются в БД (`Hq.syncRoutines`),
`blocked` прошлой задачи рутину не останавливает; `/level` пишет уровень доверия; ночной бэкап в Telegram (`BACKUP_AGE_RECIPIENT`) и очистка рендеров старше 14 дней;
расходы считаются по реальной модели, лимит отдела 80%/100%; шлюз моделей и контейнеры под наблюдением (healthcheck, `hq.heartbeat`, `renderer.heartbeat`);
чистый старт только скриптом `dist/fresh-start.js` (никогда `sqlite_sequence` и VACUUM под живым HQ; `hq-fresh-start.js` из scratchpad устарел и запрещён).

## Процессы HQ, часть B (2026-11-19, по аудиту)
Подробно: `apps/hq/README.md`, раздел «Процессы компании, часть B»; спека `../docs/architecture-hq.md`.
- Два часа: `OWNER_TZ` (Куала-Лумпур, UTC+8: сводка 08:00, пачка 09:00, недельный дайджест пн 08:30, тихие часы 23:00-08:00, рутины, что падает в утро владельца, поле `routines.tz`)
  и `TZ` (Душанбе, рынок: клиентский бот, слоты, публикации, сроки). Настройки `tz` и `owner_tz` в БД, `Hq.ownerTz`, `Hq.routineTz`, `seedTiming`.
- Пакет недели: одна карточка `content_pack` (`task_approvals.held`, `Hq.holdApprovals/openHeld/rejectHeld`, `ApprovalQueue.open/isBulk`). `content_item` не `locked`, но `keepManual`
  (счётчик не повышает до уровня 1). `locked` только деньги, выплаты, документы и ответы клиентам, цены, КП, ТЗ, SEO-правки.
- Цепочка продаж: лид с услугой и бюджетом или сметой, КП само (`isQualified`) -> одобренное КП резервирует проект `draft` (`PmStore.reserve`) и ставит договор (`bo_document`) и счёт 50%
  (`billing_invoice`, ссылка на лид, пакет, проект в `bl_invoices`) -> `/paid` (`SupportHead.onPaid`) запускает проект (`ProductionHead.onInvoicePaid`) и выплату рекомендателю
  (`referral_payout`, 10% сметы, `locked`). Виды одобрений остались прежними (`presales_pack`, `bo_document`, `billing_invoice`).
- Команды: один список `apps/hq/src/commands.ts` (справка, меню до 20, обработчики, маршруты), `/workers` из `apps/hq/src/workers.ts`.
- Потерянные заявки: `apps/hq/src/lost-leads.ts` (`activity` вида `lost_lead`, таблица `lost_leads`, один алерт в час). Недоступный шлюз: посетитель получает «Принял, менеджер ответит в рабочее время»
  (`freeAnswer`, `gatewayGate`), заявка всё равно создаётся. Публичный `/office` прячет клиентские данные в названиях задач, `/admin/office` отдаёт настоящие.

## Данные и секреты
`.env*` и `data/` не коммитятся (в `data/` контакты клиентов). Секреты: `.env.local` (dev), `/opt/fir-agents/.env`
(сервер, 600). Секреты с `$` в `.env` брать в одинарные кавычки (compose раскрывает `$`).

## Docker и деплой
- Сервер: 201.79.122.133 (firtech-sg-1), `/opt/fir-agents`, пользователь `agents` uid 1002. Внешняя docker-сеть `fir-llm`
  (создаёт bootstrap, deploy.sh создаст при отсутствии) общая с Dono: omniroute в `agents-net` и `fir-llm`, Dono ходит на
  `LLM_BASE_URL=http://omniroute:20128`. Данные OmniRoute: `/opt/fir-agents/data/omniroute`. Секреты: `/opt/fir-agents/omniroute.env`
  (JWT_SECRET, API_KEY_SECRET, STORAGE_ENCRYPTION_KEY, STORAGE_ENCRYPTION_KEY_VERSION, MACHINE_ID_SALT, INITIAL_PASSWORD,
  REQUIRE_API_KEY=true), скопированы из локального OmniRoute владельца, чтобы перенести его storage.sqlite.
- `apps/hq/Dockerfile` собирается из корня репо (`-f apps/hq/Dockerfile .`): не root, `tini`,
  `pnpm deploy --prod`, в рантайм-слое `age` и `tar` (бэкап). На Mac Docker нет, образ собирает CI.
- `compose.yaml` (ставится в `/opt/fir-agents` скриптом bootstrap, root-owned, из CI не принимается):
  - `hq`: `read_only`, `cap_drop ALL`, `no-new-privileges`, 512 МБ, 0.5 CPU, `pids_limit`, логи json-file
    10 МБ x 5, единственный порт `127.0.0.1:8787` (webhook лидов, за nginx позже), `LLM_BASE_URL=http://omniroute:20128`.
  - `omniroute`: образ `diegosouzapw/omniroute`, только `agents-net`, портов наружу нет, `REQUIRE_API_KEY=true`,
    данные `/opt/fir-agents/data/omniroute`, лимит 1.5 ГБ. Секреты шлюза в `/opt/fir-agents/omniroute.env`
    (`.env` агента шлюзу не отдаём); `LLM_API_KEY` в `.env` агента = ключ, выпущенный в OmniRoute. Образ и имена
    его переменных (`PORT`, `DATA_DIR`, секреты) сверить с документацией OmniRoute при первом запуске; `:latest`
    закрепить на версию. Без `read_only`, пока не проверено, что образ так работает.
  - Плейсхолдеры `__AGENTS_UID__/__AGENTS_GID__` подставляет bootstrap.
  - `TZ` задаётся в compose по сервисам (polly `Asia/Kuala_Lumpur`, hq `Asia/Dushanbe`) и перекрывает `TZ` из общего `/opt/fir-agents/.env`; hq ещё получает `OWNER_TZ=Asia/Kuala_Lumpur`.
    Обе зоны только засевают настройки `tz` и `owner_tz` при первом старте: уже работающий сервер хранит `tz=Asia/Tashkent` (то же смещение, UTC+5), менять через Директора.
- `deploy/bootstrap-vps.sh` (один раз, root на VPS: `sudo bash bootstrap-vps.sh "<ssh-ed25519 публичный ключ>"`):
  пользователь `agents`, дом `/opt/fir-agents`, данные `agents`-owned, всё решающее (compose, `bin/deploy.sh`,
  `authorized_keys`) root-owned. Ключ деплоя с `command="/opt/fir-agents/bin/deploy.sh",restrict`.
  `deploy/deploy.sh`: forced command, stdin = GHCR user и токен, `docker compose pull && up -d --remove-orphans`.
  Образцы: `../dono/deploy/`. Компоуз на VPS обновляется только повторным запуском bootstrap (изменение compose.yaml
  само не доезжает, образы обновляет deploy.sh).
- CI (`.github/workflows/ci.yml`): проверки на каждый push и PR, образы в GHCR (`agents-hq`, `agents-polly`) только с `main`,
  деплой-job только при переменной репо `DEPLOY_ENABLED=true`; секреты `AGENTS_SSH_KEY`, `VPS_HOST`,
  `VPS_KNOWN_HOSTS` в Environment `production` (ограничен веткой main). Пока `DEPLOY_ENABLED` не выставлен, деплоя нет.
- Репо `bokievf9/agents` на GitHub, образы собирает CI и деплоит на VPS. Пуш и GitHub-записи делает главное окно владельца после проверок (typecheck, lint, test, build), сессии проектов не пушат.
- Compose на VPS root-owned: после правки `compose.yaml` (например healthcheck) его должен заново скопировать root (повторный bootstrap или `cp`), с пушем он сам не доезжает.
- `deploy.sh` чистит висячие образы всех наших меток (`hq`, `renderer`, `polly`).
