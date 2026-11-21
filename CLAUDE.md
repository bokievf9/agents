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

## Плейбуки ремесла (2026-11-20)
`knowledge/playbooks/<роль>.md` учат исполнителей работе: правила, чек-лист, шаблоны, чего не делать (источник: навыки владельца в `~/.claude/skills`, конспект своими словами,
лицензии отмечены в каждом файле). `@fir/core` `playbooks.ts`: `loadPlaybook(role)` (кэш, папка `KNOWLEDGE_DIR`), `playbookExcerpt(role)` (Правила и Чеклист, не больше 2500 знаков) и
`withPlaybook(system, role)`; воркеры с LLM (Контент-мейкер, Трендвотчер, Аналитик, SEO, Разведчик) дописывают выжимку к системному промпту, воркер без LLM плейбук не грузит.
Не раздувай выжимку: тест держит потолок. Рилс до одобрения проходит `lintReelScript` в `review()` головы маркетинга (хук, один призыв, без штампов ИИ). `/playbook <роль>` присылает владельцу правила.
Правки плейбуков только коммитом, без секретов и клиентских данных.

## Скиллы владельца в плейбуках (2026-11-21)
Четыре присланных набора разнесены по агентам (подробно `docs/playbooks.md`, `docs/tools.md`). **instagram-agent-skill** (MIT): девять тем `knowledge/playbooks/ig-*.md` (рилсы, подписи, карусели и истории, человеческий текст, вирусный разбор, аудит, профиль, комментарии и директ, план; `PLAYBOOK_TOPICS`, `topicExcerpt` до 1500 знаков, Контент-мейкер кладёт темы типа материала в запрос, `playbook.excerpt('ig-engage')` для остальных), 26 формул `knowledge/hooks.json` (RU и EN, регулярка на язык), рубрика профиля `knowledge/profile-rubric.json` (100 баллов, `scoreProfile`), голос `knowledge/voice.md`; пять скриптов портированы в `text.hookScore`, `text.beats`, `text.captionLint`, `text.humanize`, `text.detect`, `text.swipeRank` (`packages/core/src/tools/text*.ts`, русский словарь штампов `text-lexicon-ru.ts`, правится как код). Голова маркетинга до карточки `content_item` гонит `lintCopy` (`text.detect` на сценарий и подпись, `text.captionLint` на подпись Instagram): штампы, отпечаток знаков или подпись с `fix` возвращают текст Контент-мейкеру один раз, на карточке остаётся «Проверка текста: человечность N, подпись ок»; хэштегов не больше пяти. **Openverse**: `media.openverse.search` (15 в минуту и 150 в день в журнале, строка авторства для подписи), `web.getBytes`; фон под слайдами и постами включает `CONTENT_BACKGROUNDS=on` (по умолчанию выключен), строку авторства при одобрении возвращают в подпись, если правка её убрала. **earshot**: двенадцать звуков в `packages/renderer/assets/sfx` (CREDITS.md), слой «свист на смене сцены, хлопок на тексте, удар на финальной карточке» под голосом -14 дБ, `RENDER_SFX=off` или `sfx: false` выключают. **Agent-Reach**: взята только идея Jina Reader, `web.readable` пробует `https://r.jina.ai/<url>` один раз, если свой разбор дал меньше 400 знаков; мост на Маке позже.

## Заявки из кабинета (2026-11-20)
Заявки с сайта шлют только вошедшие в кабинет клиенты: `POST /lead` с `clientEmail`/`cabinetId`/`clientName` создаёт или обновляет `cab_clients` и сразу привязывает лид (`li_leads.client_id`, «Кабинет: да» в карточке),
`GET /admin/clients/by-email` отдаёт `leads` (этап Пульта, `nextStep`, `timeline` из `ps_documents`/`bo_documents`/`bl_invoices`/`pm_projects`/`activity`, `replies` из `cab_messages`).
Сообщение клиента `POST /admin/clients/:id/leads/:leadId/messages` создаёт тикет Поддержки (`cs_tickets.lead_id`), одобренный ответ дописывается в тред; ответы владельца и головы продаж по лиду с кабинетом
тоже пишутся в `cab_messages` (`apps/hq/src/cabinet.ts`). Контракт: `docs/admin-crm-api.md`.

## Инструменты агентов (2026-11-20)
Спека и таблица: `docs/tools.md`. Код `packages/core/src/tools/*` (`createTools(deps)` → `Tools`), тесты-контракты `packages/core/tests/tools/*`.
Каждая голова кладёт в `WorkerCtx.tools` набор своего отдела (`apps/hq/src/tools.ts`: `appTools` из конфига и адаптеров приложения: PNG
Контент-мейкера, CRM Пульта только на чтение, квота YouTube Публикатора; `toolsFor` на запуск). Исполнитель не зовёт `fetch` сам: веб через
`ctx.tools.web.*` (https, хосты из списка, закреплённый публичный адрес из `net.ts`, очередь на хост, таймауты, повтор только `retryable`), ответ
всегда `ToolResult` без исключений, права в `tools/policy.ts`, `configured` в `tools/configured.ts`, журнал `tool:<имя>` и `settings.tools.stats.<дата>`.
`WorkerCtx.tools` необязателен только ради ручных контекстов тестов: `toolsOf(ctx, dept)` из `@fir/hq`. Новый инструмент: файл в `tools/`, строка
политики, строка в `docs/tools.md` (тест реестра это проверяет), тест-контракт. Переехали в core: `chain.ts` (Сопровождение реэкспортирует),
подпись `/media/` (`media-sign.ts`, Публикатор реэкспортирует), загрузка YouTube (`youtube.ts`), Search Console. Шрифты PDF: `packages/core/assets/fonts`
(в `files` пакета, Dockerfile проверяет их наличие в образе). Мониторинг тоже на `ctx.tools.web` (флаг `internal: true` только у `support`, внутренние `http://` адреса). Шрифты PDF: Latin, Cyrillic и Cyrillic Extended (таджикские буквы). `pnpm --filter hq reload-instructions` обновляет инструкции голов из `instructions/*.md` (`--dry-run` сначала).
`packages/mac-poster`: команды `ig:login`, `ig:run`, `ig:install-launchd`, `ig:uninstall-launchd` (голые `login`/`run` совпадали со встроенными pnpm). Agent Reach с Мака: `reach:run`, `reach:now`, `reach:status`, `reach:install-launchd`, `reach:uninstall-launchd` (тот же `~/.fir-mac-poster.env`, тот же SSH-туннель; ниже «Agent Reach с Мака»).

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

Instagram с Мака (2026-11-20): Meta не пускает приложение к публикации без проверки бизнеса (нужно юрлицо, его нет), поэтому Instagram публикует `packages/mac-poster` на Маке владельца: Playwright в постоянном профиле Chromium (владелец входит руками, паролей помощник не знает), SSH-туннель к `127.0.0.1:8787` на время запуска, `GET /admin/content` + `/admin/files/*`, отчёт `POST /admin/content/:id` (`published` с `url` или `failed` с причиной, строка `pb_posts.via = 'mac'`, в утренней шапке «Instagram с Мака: опубликовано N, ошибок M», упавший материал остаётся ручной карточкой). launchd 10:00, 14:00, 19:00, не больше 10 в сутки. Как `packages/clips`, это локальный инструмент: в Docker-образы не входит. Путь через Graph API (`InstagramPoster`) остаётся в коде на будущее и без `IG_*` ничего не делает. Подробно: `packages/mac-poster/README.md`.

Видео рилсов (2026-11-19): `packages/renderer` (Remotion + Piper `ru_RU-denis-medium`), сервис `renderer` в `compose.yaml` (1,5 ГБ, без сети, общий том с `hq`),
очередь `cm_render_jobs` в SQLite HQ, образ `agents-renderer` в CI. Одобренный рилс ставится в очередь, утром Публикатор шлёт MP4; `/render <id>`; `REELS_RENDER=off`
возвращает путь через `builder`. `packages/clips` (локальный инструмент на Mac) остаётся как есть. Подробно: `packages/renderer/README.md`. Launch-фильм (2026-11-21): композиции `LaunchFilm` (38 с) и `LaunchTeaser` (15 с), `pnpm --filter renderer render:launch`, сценарий и серия постов в `docs/launch-film.md`.

## Цены, токены, аудит (2026-11-19, по аудиту)
- Цены в одном месте: прайс-лист сайта `GET https://firtech.pro/api/prices`. `packages/core/src/prices.ts` (`getPrices()`, `loadPrices()`, снимок `prices.fallback.json`):
  HQ грузит его при старте и каждые 6 часов (`PRICES_URL`), последняя хорошая копия лежит в `settings.prices_json`. Исполнители и клиентский бот читают `getPrices()`,
  суммы в коде не пишем (тест `packages/core/tests/prices.test.ts` это проверяет). Оплата: USDT TRC20/TON или онлайн-кошелёк из сметы (`PAYMENT_DETAILS_JSON`: `usdt_trc20`,
  `usdt_ton`, `wallet`), оплата по этапам (см. «Оплата по этапам»). Прайс-лист перечитывается каждые 15 минут (`PRICES_RELOAD_MS`) и сразу по `POST /admin/prices/reload`.
- `ADMIN_TOKEN` и `WEB_CHAT_TOKEN` обязательны для своих маршрутов (`/admin/*`, `/chat`), без них 404, фолбэков на `OFFICE_TOKEN` и `LEAD_WEBHOOK_TOKEN` нет. IP посетителя: `x-visitor-ip`
  (верим только с loopback и шлюза docker при верном токене).
- Аудит: карточка `audit` уходит сразу (`urgent`), алерт через 20 часов, при старте `running` возвращается в `assigned`. Образ OmniRoute закреплён по digest: `docs/omniroute-image.md`.

## Точные цифры и условия (2026-11-19)
КП, смета, договор и счёт называют одну точную цену выбранного пакета из прайс-листа сайта (`packages/workers/presales/src/package.ts`, сумма вариантов и допов; подписки: настройка и точная месячная плата), «от» остаётся только в сообщениях,
где состав ещё неизвестен (Разведчик, клиентский бот). Во всех четырёх документах одна фиксированная строка про домен, хостинг, сервер и платные сторонние сервисы (`costsLine` в `packages/core/src/conditions.ts`);
если у лида `has_domain` и `has_hosting` (шаг 4 клиентского бота, `li_leads`), строка короче. Оплата по этапам (см. «Оплата по этапам (2026-11-21)»), гарантия первого результата возвращает оплату первого этапа.

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
- Цепочка продаж: лид с услугой и бюджетом или сметой, КП само (`isQualified`) -> одобренное КП резервирует проект `draft` (`PmStore.reserve`) и ставит договор (`bo_document`) и счёт первого этапа
  (`billing_invoice`, ссылка на лид, пакет, проект, этап в `bl_invoices`) -> `/paid` (`SupportHead.onPaid`) запускает этап (`ProductionHead.onInvoicePaid`) и выплату рекомендателю
  (`referral_payout`, 10% оплаченного этапа, `locked`); дальше см. «Оплата по этапам». Виды одобрений остались прежними (`presales_pack`, `bo_document`, `billing_invoice`).
- Команды: один список `apps/hq/src/commands.ts` (справка, меню до 20, обработчики, маршруты), `/workers` из `apps/hq/src/workers.ts`.
- Потерянные заявки: `apps/hq/src/lost-leads.ts` (`activity` вида `lost_lead`, таблица `lost_leads`, один алерт в час). Недоступный шлюз: посетитель получает «Принял, менеджер ответит в рабочее время»
  (`freeAnswer`, `gatewayGate`), заявка всё равно создаётся. Публичный `/office` прячет клиентские данные в названиях задач, `/admin/office` отдаёт настоящие.

## Пульт v3 (2026-11-20)
Рабочее место владельца на сайте (`/admin`) получило хаб, воронку лидов, календарь контента, цифры недели и раздел «Компания»: маршруты `src/pult*.ts` в `apps/hq` под тем же `x-admin-token`, контракт
`docs/admin-crm-api.md` раздел «Пульт v3» (согласован с сайтом, менять только вместе). Запись идёт тем же кодом, что Telegram (очередь одобрений, `/paid`, `/mdone`, `/level`, `Hq.runRoutine`), без одобрения только то, что владелец написал сам
(ответ лиду). Стадия лида выводится из данных, ручной ход в `li_leads.stage_override`. Публичный `POST /events` (`SITE_EVENTS_TOKEN`, иначе `WEB_CHAT_TOKEN`) пишет счётчики в `site_events` без персональных данных;
`GET /admin/files/<path>` отдаёт только `DATA_DIR/renders`. Статьи в календаре имеют id `a<число>`.

## Ревью-центр (2026-11-21)
Одна поверхность владельца вместо текстовых карточек: `GET /admin/review` (все виды одобрений `task_approvals` одной формой: медиа, текст, мета, версии, список допустимых действий; пакет недели раскрыт в свои материалы, у пакета остаётся своё «Одобрить»)
и `POST /admin/review/:id` (`approve`, `edit`, `revise`, `reject`, `publish_now`, `reschedule`, `send`, `call`) в `apps/hq/src/review.ts`, `review-versions.ts` (таблица `review_versions`: правка владельца даёт версию v+1, «Правки» дают новый материал с `parentId`).
Решения идут тем же кодом, что кнопки Telegram (`decide` админки: `queue.handle`, затем `settleCard`), второго пути нет. «Выложить сейчас»: YouTube через `PublisherWorker.publishNow` (`YouTubePoster`, квота как утром, сбой остаётся `failed` с причиной), Instagram и TikTok через очередь Мака (`macEnqueue`, `mac_queue`), статья публикуется одобрением.
Чаты клиентов (`apps/hq/src/chats.ts`): один тред на клиента из кабинета, лидов, тикетов, веб-чата и бота (склейка по клиенту кабинета, контакту, сессии); ответ владельца уходит на последний канал клиента без одобрения, пишется в `cab_messages` (`author = owner`) или `ch_messages` и в журнал лида; тексты анонимных диалогов не хранятся (правило проекта).
Ссылки владельца (`POST /admin/trends`, `/trend <ссылка> [заметка]`): Трендвотчер (`packages/workers/trend-scout/src/link.ts`, таблица `ts_links`) читает публичную страницу через `ctx.tools.web` (хосты `SOCIAL_HOSTS`, oEmbed и `og`, без входа), делает разбор и аналог, Контент-мейкер пишет материал обычным конвейером (`meta.source = owner_link`, разбор в `versions[0].note`). Контракт для сайта: `docs/admin-crm-api.md`, раздел «Ревью-центр (2026-11-21)».

Agent Reach с Мака (2026-11-21): `~/Agent-Reach` (MIT, `agent-reach` 1.6.1 в `~/.local/bin`) читает YouTube (субтитры, карточка видео, поиск), веб, GitHub, Reddit без входа, Instagram, X, LinkedIn после входа владельца. Ему нужны браузер и Python, в контейнере HQ их нет, поэтому очередь: инструмент `ctx.tools.reach.<канал>.<действие>(args)` (`packages/core/src/tools/reach.ts`, словарь и проверка аргументов `reach-spec.ts`) кладёт задание в `rc_jobs` и сразу отвечает `{ state: 'queued', jobId }` или готовым `done` за 24 часа (ключ: sha256 канала, действия и аргументов; упавшее задание час не повторяется; потолок 200 заданий в сутки на компанию). Права: marketing (и Аналитик) youtube, web, instagram, twitter, reddit; sales (Разведчик) linkedin, reddit, web, github; support ничего; журнал `tool:reach.<канал>.<действие>`. Мак (`packages/mac-poster`, `reach:run` каждые 15 минут через launchd `pro.firtech.reach`) по туннелю читает `GET /admin/reach/jobs?status=queued`, берёт задание `POST .../claim` (второй получает 409), запускает `agent-reach <канал> <действие> ...` (без shell, аргументы только через таблицу, 120 с на задание, не больше 20 за запуск, по одному, свой lock `reach.lock`) и отвечает `POST .../result` (`ok`, `items`, `meta`, `error` как данные, до 200 КБ). Исполнитель, получивший `queued`, возвращает `waiting: { jobId }`, голова паркует задачу (`blocked` с тегом `reach-wait`, без тревоги), когда пришёл ответ или задание истекло (6 часов в очереди, 30 минут на Маке), `apps/hq/src/reach.ts` возвращает задачу в inbox и будит голову. Ночная очистка (рендеры) удаляет задания старше 7 дней. Трендвотчер: для YouTube просит `subtitle` и `read` до чтения страницы; в разбор идут слова ролика, темп (слов в секунду из длительности; таймкодов в тексте субтитров CLI нет), просмотры и лайки; для Instagram остаётся путь `og`, а профиль и посты автора ставятся в очередь, только если Мак сообщил Instagram включённым (`settings.reach.channels`, Мак шлёт его в `GET jobs?channels=` и в `claim`). В `GET /admin/trends` у ссылки `chip` «ждёт Мак» или «Мак читает» и `reach`. Instagram и X требуют, чтобы владелец сам сделал на Маке `agent-reach add instagram` и `agent-reach login instagram` (отдельным аккаунтом, не основным). Контракт: `docs/admin-crm-api.md`, «Reach (2026-11-21)»; команды и установка: `packages/mac-poster/README.md`.

## Оплата по этапам (2026-11-21)
Решение владельца: вместо 50/50 оплата по этапам, каждый этап ДО его начала, последний до передачи доступов; гарантия возвращает оплату первого этапа; выплата рекомендателю 10% каждого оплаченного этапа. Подписки (контент, агенты) остаются «настройка + ежемесячно вперёд» (один этап «Настройка»).
- Шаблоны даёт сайт в `GET /api/prices`: `stages` (объект `{site, bot, automation, app, small}` из списков `{id, title:{ru,en}, share}`) и `smallProjectMaxUsd` (300); какой продукт к какому шаблону, решает HQ (`packages/core/src/stage-templates.ts`). Парсер терпимый: неизвестный шаблон игнорируется, доли не в сумме 100 дают встроенный шаблон и warn; снимок `prices.fallback.json` в той же форме.
- `stagesFor(totalUsd, productIds)` (`packages/core/src/stages.ts`, чистая): шаблон по самой дорогой части, до порога 300 USD два этапа 50/50, целые доллары, последний этап добирает остаток. `paymentLine(stages, lang)` и `guaranteeLine` в `conditions.ts` заменяют любую строку 50/50 в КП, смете, договоре и счёте; «50%» остаётся только в формулировке малого проекта.
- Цепочка: пакет Пресейла несёт `stages`; одобренное КП резервирует проект, этапы `pm_milestones` (`kind = stage`, `stage_no`, `amount_usd`, `invoice_number`, `paid_at`, `accepted_at`) это этапы оплаты, счёт делается только на этап 1 (`bl_invoices.stage_no`). Оплата этапа 1 запускает проект (ТЗ, builder-задача), оплата этапа N > 1 запускает builder-задачу этапа N (`ProductionHead.onInvoicePaid`).
  Приёмка (`ProductionHead.acceptStage`: `/mdone <проект> <номер>` или «Принять этап» клиента в кабинете, `POST /admin/clients/:id/projects/:pid/milestones/:no/accept`) один раз предлагает счёт следующего этапа (задача Сопровождения `kp_invoice` с `stageNo`, одна карточка `locked`, по одному живому счёту на этап); счёт последнего этапа предлагается при приёмке предпоследнего, задача «Передача доступов» (`action: handover`) заблокирована до его оплаты; приёмка последнего закрывает проект. Состояние этапа: `stageState` (`awaiting_payment|in_progress|awaiting_acceptance|accepted`).
- Выплата рекомендателю: одна карточка `referral_payout` на оплаченный этап (этап 1 в строке рекомендации, следующие в `rf_stage_payouts`, повтор ничего не просит). Переменная `PREPAYMENT_PERCENT` убрана. Кабинет: `projects[].milestones[]`, `nextStep` «оплатить/принять этап N»; контракт `docs/admin-crm-api.md`.

## Дрилл процессов (2026-11-21)
Владелец: «проверить, работает ли каждый процесс в офисе». `apps/hq/tests/drill/*.test.ts` (мир `world.ts`: все головы, Директор, Drill, админ-API, настоящий webhook на порту 0, настоящий обвес бота `src/glue.ts` на записывающем grammy-боте) прогоняет каждую команду,
кнопку, вид одобрения (Telegram и ревью-API), рутину, маршрут и цепочку КП-счёт-этапы, плюс случайные прогулки `chaos.test.ts` с отказами Telegram и шлюза (`SEEDS=1,2 STEPS=400 pnpm --filter hq exec vitest run tests/drill/chaos.test.ts`).
Таблица всех процессов, статусы и найденные ошибки: `docs/process-census.md`. Правила набора: JSON-логи ловит `guard.ts` (ни одной строки `error`, ни одного unhandled rejection, ни имён, контактов, текстов, токенов в логах), новый процесс получает строку в таблице и тест тут же.
Что дрилл поменял в контрактах: `KindSpec.ready(payload)` (карточка с шаблоном `[цена]` или устаревшая, например счёт аннулирован, не падает в `failed`, а остаётся `pending` с подсказкой; сайт отвечает 409 `placeholder` или `not_ready`, `docs/admin-crm-api.md`).

## Кабинет v3 (2026-11-22)
Слова владельца: «заявку отправил, сразу вышел договор; он не отправляется клиенту после одобрения; нет места подписи; клиент не видит, что КП утверждено, договор готов, счёт выставлен; нужна подпись мышью; чат неудобный, темы по проектам и заявкам или чат с ИИ; профиль не сохраняется; площадка агента сразу».
Для лида с аккаунтом кабинета (`li_leads.client_id`) цепочка теперь: заявка без договора -> одобренное КП ИДЁТ КЛИЕНТУ (`cab_documents` `quote`, `awaiting_client`, письмо `email.send` со ссылкой на кабинет, строка в треде; одобрение владельца и есть отправка) -> клиент «Принять КП» (`POST /admin/clients/:id/documents/:docId/accept`) -> задача «Договор» (`bo_document`) -> одобрение отправляет договор клиенту (`awaiting_signature`) -> клиент рисует подпись (`.../sign`: PNG до 200 КБ, имя, согласие, IP и браузер; `bo_signatures` с sha256 PDF, подписанный PDF с обоими блоками, пункт о простой электронной подписи в договоре) -> задача «Счёт этапа 1» -> одобрение отправляет счёт с `payUrl` -> оплата -> проект `in_progress`.
Проект (`preparing`) резервируется при одобрении КП. `SalesHead`, `BackofficeHead` и `SupportHead` получают `cabinet` (`CabDocs`) из `buildCabinet` в `index.ts`; лид без аккаунта (бот Telegram) и мир без кабинета идут прежней цепочкой («Заявки из кабинета», «Процессы HQ, часть B»). `/paid`, сторож оплаты и цепочка этапов не менялись.
Клиентское «что делать дальше» `nextAction` (`accept_quote`, `sign_contract`, `pay_stage`, `accept_stage`, `wait`) и `state` проекта (`preparing|in_progress|paused|done`) в `by-email`, Пульте и заявках; `lead-stage.ts` не считает черновик договора внутри пакета КП стадией «договор».
Чат: треды `lead-<id>`, `project-<id>`, `support`, `agent-<id>` (`cab-threads.ts`; тред заявки это прежние `cab_messages`, остальные `cab_tmsgs`; сообщения идут обращениями Поддержки с ответом в тот же тред и видны в `/admin/chats`); вложения: `POST .../uploads` (JSON base64, 10 МБ, список типов, сверка содержимого, `DATA_DIR/uploads/<клиент>/`, скачивание по подписанной ссылке `/media/...?e=` на 7 дней, это общее правило для PDF и файлов кабинета: подпись покрывает срок).
Площадка (`playground.ts`): `pg_agents` на клиента (до трёх), персона из ответов конструктора лида, чат через шлюз с памятью на разговор, пять инструментов (FAQ, окна-заглушка, контакт, передача человеку в тред поддержки), лимит сообщений в сутки, `draft|live`, публичный `POST /agent/:publicId/chat` с токеном агента и origin сайта, DEMO-персоны (салон, клиника, магазин, кафе, сервис, курсы) для превью конструктора, лимиты по IP, в журнале только счётчики. Telegram-токен агента хранится зашифрованным, канал не запущен.
Профиль: `POST /admin/clients/:id` (имя, Telegram, телефон, компания, язык; регистрация `POST /admin/clients` остаётся upsert). Контракт и список отличий от черновика: `docs/admin-crm-api.md`, «Кабинет v3 (2026-11-22)»; дрилл: `apps/hq/tests/drill/cabinet-flow.test.ts`, `cabinet-chat.test.ts`.

## ИИ-менеджер заявок 2.0 (2026-11-22)
Слова владельца: «форма заявки нафиг: либо собирают сборку, либо через ИИ-менеджера заявок; это реальный рабочий приёмщик, нужно больше функций; он тоже должен предлагать собрать проект; «обсудим в Telegram» теперь last resort; уточняющие вопросы перед КП».
Мозг приёмщика один для веб-чата (`POST /chat`, `client/web.ts`) и клиентского бота (`client/engine.ts`): `client/receptionist.ts`. Состояние `QState` (ниша, боль, продукт, каналы, цели, срок, бюджет, что предложено, `turns`) живёт в черновике сессии или чата. Модель пишет слова и отчитывается строгим JSON (`reply`, `ready`, `intent`, `extract`), всё остальное решает код: квалификация не больше `MAX_QUALIFY_TURNS` (5) реплик, потом предложение; **порядок предложений** сборка (ссылка `/<locale>/builder?b=...` с `k.` нишей, `p.` продуктом, `g.`, `c.`, `d.` сроком, порт кодировщика сайта `client/builder-link.ts`, тесты на выходе кода сайта), созвон вторым (окна из `GET <сайт>/api/slots`, `client/site-slots.ts`, недоступно: «предложу время»), Telegram только если посетитель сам попросил (в самом боте не предлагается); цены только из `getPrices()` со словами правила этапов (`priceAnswer`, без модели); просьба о человеке или раздражение (`wantsPerson`, три одинаковых сообщения) передаёт разговор: вошедшему клиенту в его тред поддержки (`ClientSinks.clientMessage`), анониму сначала контакт, потом лид с `handoff` (в Telegram прежний `callHuman`); клиент с `clientEmail` не получает продаж, его вопросы про проект идут в тред; своя реплика проходит `text.detect`, помеченная переписывается один раз (заглушка короче 40% не принимается); ответ на языке `locale`, тон `knowledge/voice.md`. Кнопка «Обсудить проект» начинает разговор, а не анкету; сценарная анкета из трёх шагов остаётся запасным путём без модели (`WebChatDeps.conversation: false` в старых тестах).
`persona` в `/chat` (`salon|clinic|shop|cafe|service|courses`) включает демо-сессию вкладки сайта (`client/persona.ts`, голос и факты `DEMOS` площадки агентов): ничего не хранится, лид и тикет не создаются, свой лимит на IP, 12 ответов на сессию, лог только счётчики. Поле слов теперь `text` (старое `message` читается тоже).
Лид из разговора несёт `enrichment` (`summary` три строки, `productFamily`, `niche`, `intentScore`, `builderLink`): колонка `li_leads.enrichment`, строки в карточке Приёмщика и в одобрении `lead_reply`, поле в `GET /admin/crm/leads`, клиенте 360 и `meta.lead` ревью-центра; лиду без него Приёмщик выводит его из слов (`deriveEnrichment`). Ссылку предложенной сборки в `estimate` не кладём (иначе лид стал бы «квалифицированным» и КП пошло бы само).
Уточняющие вопросы перед КП (`clarify.ts`, `SalesHead.clarifyIfNeeded/clarifyTick`): лид с аккаунтом кабинета и блокирующими пробелами (неясный состав, либо нет ни ниши, ни цели) получает один раунд из трёх вопросов в треде и письмом Resend, карточка `lead_reply` уровня 1 с `payload.clarify`; ответы клиента в треде дописываются в лид и ставят задачу `kp`, без ответа за 24 часа КП с `meta.assumptions` (перечень допущений в КП и смете, не в договоре). Таблица `li_clarify`. Подробно: `docs/public-api.md` («POST /chat»), `docs/admin-crm-api.md` («enrichment», «Уточняющие вопросы перед КП»), `apps/hq/instructions/client-bot.md`, `knowledge/playbooks/sales.md`. Тесты: `receptionist.test.ts`, `receptionist-telegram.test.ts`, `builder-link.test.ts`, `clarify.test.ts`, `drill/clarify.test.ts`, пакет `lead-intake`.

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
