# Admin CRM API («Пульт», этап 2)

Read-mostly представления над таблицами исполнителей для панелей firtech.pro/admin. Код: `apps/hq/src/admin-crm.ts`,
маршруты внутри `/admin/*` (`apps/hq/src/admin.ts`). Тесты: `apps/hq/tests/admin-crm.test.ts`.

## Общее
- Транспорт, токен и формат как у остальных `/admin/*`: `x-admin-token`, порт webhook HQ (`127.0.0.1:8787`), без токена 401, без `ADMIN_TOKEN` 404.
  Общий лимит 6000 запросов за 10 минут (поднят с 600 2026-11-20: Пульт опрашивает офис и хаб с каждой вкладки).
- Успех: `{ "ok": true, ... }`. Ошибка: `{ "ok": false, "error": "<код>", ... }`. Коды: `not_found` (404, неизвестный id или путь),
  `invalid` / `invalid_status` (400, в ответе `allowed` со списком допустимых статусов), `illegal_transition` (409, `from`, `allowed`),
  `reply_not_supported` (400), `rate_limited` (429), `internal` (500).
- Списки: `?limit=` (по умолчанию 50, максимум 200), `?cursor=` (значение `nextCursor` прошлого ответа), `?q=` (поиск по подстроке без учёта регистра по имени и контактам).
  Ответ списка всегда `{ ok, available, items, nextCursor }`; `nextCursor: null` значит страниц больше нет. Курсор непрозрачный, передавать как есть.
  `prospects`, `leads`, `tickets`, `projects`, `referrals` идут по `id` по убыванию (новые первыми); `clients` по последнему касанию; `documents` по дате создания.
- `available: false` и `items: []`: таблицы панели нет (воркер ещё не запускался или данных такого рода нет). Выдуманных данных нет.
- Времена: ISO 8601 UTC или `null`. Деньги: `amountUsd` в долларах (число).
- Тексты посетителей и клиентов (`noticed`, `offer`, `hook`, `task`, `text`, `draft`, `excerpt`...) обрезаны до 500 символов. Токенов, ключей и промптов моделей в ответах нет.
- Заметки владельца (`note`) хранятся в таблице `crm_notes` (создаётся сама), поддерживаются у `prospects` и `tickets`.

## GET /admin/crm/summary
Счётчики для бейджей одним вызовом.
```json
{ "ok": true, "generatedAt": "2026-11-19T10:00:00.000Z",
  "prospects": { "available": true, "total": 2, "byStatus": { "new": 2, "proposed": 0, "sent": 0, "replied": 0, "no_reply": 0, "skipped": 0 } },
  "leads": { "available": true, "total": 1, "byStatus": { "inbox": 1 } },
  "tickets": { "available": true, "open": 2, "byStatus": { "open": 2, "answered": 0 } },
  "documents": { "available": true, "pending": 4, "byKind": { "contract": { "pending": 1 }, "kp": { "draft": 1 }, "invoice": { "draft": 1 } } },
  "projects": { "available": true, "active": 1, "byStatus": { "draft": 0, "active": 1, "done": 0 } },
  "referrals": { "available": true, "total": 1, "byStatus": { "proposed": 1, "paid": 0, "rewarded": 0 } },
  "reviews": { "available": false, "pending": 0 },
  "chats": { "available": true, "web": 12, "telegram": 3 } }
```
`leads.byStatus` считается по статусу задачи отдела продаж (`tasks.status`: inbox, assigned, running, review, approval, done, blocked, rejected).
`documents.pending` = документы, ждущие владельца (`pending` + `draft` + `issued`). У отсутствующей таблицы `byStatus` равен `{}`.

## GET /admin/crm/prospects
Разведка (`pr_prospects`). Параметры: `limit`, `cursor`, `q` (название, город, ниша, контакты), `status`, `niche`.
Статусы и переходы как у Разведчика: `new → proposed → sent → replied | no_reply | skipped`; `new → skipped`, `proposed → skipped`,
`sent → skipped`, `no_reply → replied`; из `replied` и `skipped` выхода нет. Допустимые статусы всегда в `statuses`;
`nextStatuses` в строке: куда можно перейти.
```json
{ "ok": true, "available": true, "statuses": ["new","proposed","sent","replied","no_reply","skipped"], "nextCursor": null,
  "items": [{ "id": 7, "name": "Bro Barber", "niche": "barber", "city": "Dushanbe", "website": "", "instagram": "", "telegram": "@bro", "phone": "",
    "noticed": "...", "offer": "...", "hook": "...", "source": "", "status": "new", "nextStatuses": ["proposed","skipped"], "followups": 0,
    "draft": null, "draftKind": null, "sentText": null, "note": "", "createdAt": "...", "proposedAt": null, "sentAt": null, "repliedAt": null }] }
```
## POST /admin/crm/prospects/:id
Тело `{ "status"?: string, "note"?: string }` (note до 2000 символов, лишние поля 400). Статус меняется той же машиной состояний, что у Разведчика
(проставляет `sent_at`, `replied_at`). Ответ `{ ok, available, statuses, item }` (строка как в списке).
Ошибки: неизвестный id 404; статус не из списка 400 `invalid_status` + `allowed`; запрещённый переход 409 `illegal_transition` + `from`, `allowed`.
Холодные письма отсюда не отправляются: `sent` только отмечает, что владелец отправил сам.

## GET /admin/crm/leads
Заявки Приёмщика (`li_leads`; таблицы `leads` в этой базе нет). Параметры: `limit`, `cursor`, `q` (имя, контакт, услуга, ниша, источник).
```json
{ "ok": true, "available": true, "nextCursor": null, "items": [{ "id": 1, "kind": "lead", "taskId": 41, "status": "inbox", "name": "Алиса", "contact": "@alice",
  "service": "site", "niche": "", "task": "...", "deadline": "", "budget": "", "source": "site", "temperature": "cold", "lang": "ru",
  "priceAsked": false, "priceApproved": false, "createdAt": "..." }] }
```
`status`: статус задачи отдела продаж этого лида (или `null`); `source` = `origin` формы (`site`, `telegram`, `ref:<клиент>`...).

## GET /admin/crm/clients
Один ряд на клиента (ключ: имя без учёта регистра) по `li_leads`, `cs_clients`, `cs_tickets`, `pm_projects`, `bl_invoices`, `bo_documents`. Параметры `limit`, `cursor`, `q` (имя, контакт).
Чаты сайта и Telegram-бота анонимны (имени и контакта нет), поэтому к клиентам не привязываются: только общие числа в `chats`.
```json
{ "ok": true, "available": true, "chats": { "web": 12, "telegram": 3 }, "nextCursor": null,
  "items": [{ "name": "Алиса", "contact": "@alice", "sources": ["billing","documents","project","site","support"],
    "firstTouchAt": "...", "lastTouchAt": "...", "counts": { "leads": 1, "tickets": 1, "projects": 1, "invoices": 1, "documents": 1 } }] }
```
`contact`: первый непустой контакт среди источников. `sources`: откуда клиент известен (`origin` лидов, `support`, `project`, `billing`, `documents`).
Курсор здесь смещение; порядок: последнее касание, новые первыми.

## GET /admin/crm/tickets
Обращения клиентов (`cs_tickets`). У каждого `clientId`: тот же идентификатор, что у ряда `/admin/crm/clients` (`"<id кабинета>"`, если контакт обращения совпал с email или Telegram-ником клиента кабинета или имя принадлежит такому клиенту, иначе `"c:<имя в нижнем регистре>"`); он же в `tickets` у `GET /admin/crm/clients/:id` и `GET /admin/clients/by-email`. Параметры: `limit`, `cursor`, `q` (клиент, контакт, текст), `status` (`open`, `answered`).
```json
{ "ok": true, "available": true, "statuses": ["open","answered"], "nextCursor": null,
  "items": [{ "id": 3, "clientName": "Алиса", "contact": "@alice", "text": "не работает бот", "status": "open", "money": false, "slaAlerted": false,
    "answer": null, "note": "", "createdAt": "...", "answeredAt": null }] }
```
## POST /admin/crm/tickets/:id
Тело `{ "status"?: "open"|"answered", "note"?: string }`. Ответ `{ ok, available, statuses, item }`.
**Ответ клиенту отсюда не отправляется**: поле `reply` даёт 400 `reply_not_supported`. Ответ клиенту уходит от агента Поддержки через очередь одобрений
(`POST /admin/command {name:"ticket", arg:"<клиент>: <вопрос>"}`, черновик появится в `GET /admin/approvals`). `answered` вручную ставит только отметку (`answeredAt`), клиенту ничего не уходит.

## GET /admin/crm/documents
Документы: бэк-офис (`bo_documents`: contract, offer, privacy, act), пресейл (`ps_documents`: kp, estimate, contract) и счета (`bl_invoices`: kind `invoice`).
Параметры: `limit`, `cursor` (смещение), `q` (клиент, название, номер), `kind`, `status`. `kinds` в ответе: виды, которые есть в базе.
Статусы по источникам: `back_office` pending/approved/rejected; `presales` draft/approved/rejected/superseded; `billing` draft/issued/paid/void.
```json
{ "ok": true, "available": true, "kinds": ["contract","estimate","invoice","kp"], "nextCursor": null,
  "items": [{ "id": "bl:5", "source": "billing", "kind": "invoice", "status": "issued", "client": "Алиса", "title": "Сайт", "excerpt": "Сайт",
    "amountUsd": 300, "number": "FT-2026-001", "createdAt": "...", "link": null }] }
```
`id` составной (`bo:`, `ps:`, `bl:` + число). `amountUsd` и `number` только у счетов, иначе `null`. `link`: файлов и ссылок в базе нет, всегда `null`.
`client` у пресейл-документов берётся из лида (пусто, если лида нет). Тело документа целиком не отдаётся, только `excerpt` (500 символов).

## GET /admin/crm/projects
Проекты Проджект-менеджера (`pm_projects` + `pm_milestones`). Параметры: `limit`, `cursor`, `q` (клиент, суть, продукт), `status` (draft, active, done).
```json
{ "ok": true, "available": true, "nextCursor": null, "items": [{ "id": 2, "client": "Алиса", "what": "Сайт", "product": "site", "status": "active",
  "source": "owner", "taskId": null, "stage": "brief", "deadline": "...", "nextMilestone": { "kind": "brief", "title": "Бриф", "dueAt": "..." },
  "tasksTotal": 4, "tasksDone": 1, "createdAt": "..." }] }
```
`stage`: `spec` (черновик, ждёт владельца), иначе вид ближайшей открытой вехи (`brief`, `prototype`, `delivery`, `payment`), `done` когда всё закрыто.
`deadline` = срок ближайшей открытой вехи (или последней). `tasksTotal`/`tasksDone` считаются по вехам.

## GET /admin/crm/referrals
Рефералы (`rf_referrals`). Параметры: `limit`, `cursor`, `q` (кто привёл, кого), `status` (proposed, paid, rewarded; список в `statuses`).
```json
{ "ok": true, "available": true, "statuses": ["proposed","paid","rewarded"], "nextCursor": null,
  "items": [{ "id": 1, "referrer": "Алиса", "referred": "Боб", "leadId": null, "source": "owner", "status": "proposed", "reward": "10%",
    "rewardRequested": false, "createdAt": "...", "paidAt": null, "rewardedAt": null }] }
```
## GET /admin/crm/reviews
Таблицы отзывов в базе нет (как и `cards`, `touches`): всегда `{ "ok": true, "available": false, "items": [], "nextCursor": null }`.
В `summary` `reviews: { available: false, pending: 0 }`. Панель показывает заглушку, пока агент отзывов не появится.

## Кабинет клиента (`/admin/clients/*`)
Заявки с сайта отправляют только вошедшие в кабинет клиенты (решение владельца 2026-11-20): `POST /lead` принимает необязательные `clientEmail` (нижний регистр; битое значение игнорируется),
`cabinetId` (id Supabase, до 64) и `clientName` (до 120). С `clientEmail`: аккаунт создаётся или обновляется по email (`cab_clients`, `supabase_id` из `cabinetId`), лид привязывается сразу
(`li_leads.client_id`, строка лида создаётся в момент запроса, Приёмщик дополняет её позже), email становится контактом, если в форме его не было (поле `contact` тогда необязательно).
Ответ `{ ok: true, id, leadId }`. В карточке лида владельцу «Кабинет: да», в `GET /admin/crm/leads` поле `cabinet`.
Клиенты регистрируются на сайте через Supabase (email и пароль, Google, Apple), сайт зовёт HQ по loopback с тем же `x-admin-token`.
Те же 401/404 и общий лимит 6000 запросов за 10 минут. Код: `apps/hq/src/admin-crm.ts`, тесты: `apps/hq/tests/admin-cabinet.test.ts`.

### POST /admin/clients
Тело `{ email, name, telegram, locale, supabaseId, marketingConsent }`: `email` обязателен (обрезается, нижний регистр, до 254), `name` и `telegram` до 120 (можно пустые),
`locale` `ru|en` (по умолчанию `ru`), `supabaseId` до 64 символов `[A-Za-z0-9_-]`, `marketingConsent` boolean (по умолчанию `false`). Неверное тело 400 `invalid`.
Upsert по email в `cab_clients` (повторный вызов обновляет поля, `id` тот же). Лиды (`li_leads.client_id`), чей контакт равен email или Telegram-нику
(без учёта регистра, с `@` и без), привязываются к клиенту; чужие привязки не перехватываются. Клиент виден в «Клиентах» с источником `cabinet`.
О новом аккаунте владельцу уходит одна строка во входящие («Новый аккаунт в кабинете: <имя или email>, лидов привязано N»), без одобрения, один раз на клиента.
```json
{ "ok": true, "client": { "id": 1, "email": "alice@example.com", "name": "Алиса", "telegram": "@alice", "locale": "ru", "createdAt": "..." }, "linkedLeads": 2 }
```

### GET /admin/clients/by-email?email=<urlencoded>
Всё одного клиента, неизвестный email 404 `{ ok: false, error: "not_found" }`, плохой email 400 `invalid`. Обновляет `last_seen_at`, довязывает новые лиды.
Свой набор строк клиента: лиды с его `client_id`, имена этих лидов и записей `cs_clients` с его email или ником. Имя из регистрации для выбора строк НЕ используется
(его можно ввести любое), чужих данных, заметок владельца и промптов в ответе нет. Каждый список до 50 новых.
```json
{ "ok": true, "client": { "id": 1, "name": "Алиса", "email": "alice@example.com", "telegram": "@alice", "createdAt": "..." },
  "projects": [], "invoices": [], "documents": [], "tickets": [], "referrals": [], "referralSlug": "c1a1b2c3" }
```
- `projects`: строки как у `GET /admin/crm/projects`.
- `invoices`: строки как у `GET /admin/crm/documents` с `source: "billing"`, только выставленные и оплаченные (`issued`, `paid`), без черновиков и аннулированных.
- `documents`: остальные строки документов, только виды `contract`, `kp`, `estimate`, `act`, `offer` со статусом `approved` (privacy, черновики и отклонённые не отдаются).
- `tickets`: как у `GET /admin/crm/tickets`, но без `note`; поле `answer` (текст утверждённого ответа или `null`).
- `referrals`: как у `GET /admin/crm/referrals`, где клиент рекомендатель (по имени из его лидов или по слагу).
- `referralSlug`: слаг клиента (`c` + id + 6 hex), выдаётся при первом запросе и больше не меняется; ссылка `?start=ref_<slug>` в боте и `source=ref:<slug>` в форме
  дают рекомендацию с `referrer` равным слагу (воркер рефералов имён кабинета не знает).

### POST /admin/clients/:id/tickets
Тело `{ text }` (1..1000 символов после обрезки). Неизвестный клиент 404 `not_found`, плохой текст 400 `invalid`, больше 10 обращений за час от одного клиента 429 `rate_limited`.
Создаёт `cs_tickets` (`client_name` = имя или email, `contact` = email, `source = "cabinet"`) и задачу Поддержки: черновик ответа идёт через очередь одобрений как у обычных
тикетов (SLA 4 ч). Утверждённый ответ записывается в `cs_tickets.answer` и виден в кабинете; если Telegram-ник клиента совпал с известным чатом бота, ответ уходит ещё и туда.
Иначе единственный канал это сохранённый ответ (письма не отправляются), владельцу «отправьте клиенту» для таких тикетов не приходит.
```json
{ "ok": true, "item": { "id": 7, "text": "Как оплатить?", "status": "open", "createdAt": "...", "answeredAt": null, "answer": null } }
```

### Лиды клиента в `by-email` (`leads`)
Лиды, привязанные к клиенту (`li_leads.client_id`), новые сверху, не больше 20. Внутренних текстов, промптов и заметок владельца нет.
```json
"leads": [{ "id": 12, "createdAt": "...", "service": "site", "summary": "Нужен сайт для салона", "estimateUsd": 1200, "hasDomain": true, "hasHosting": false,
  "stage": "proposal", "nextStep": "КП отправлено, ждём вашего решения",
  "timeline": [{ "at": "...", "kind": "lead", "title": "Заявка получена" }],
  "replies": [{ "at": "...", "text": "Здравствуйте, Алиса!", "from": "manager" }] }]
```
- `stage`: этап Пульта (`new|qualified|proposal|contract|paid|project|lost`, с учётом ручного переноса владельца). `nextStep`: одно предложение на этап, на языке лида (`ru` по умолчанию):
  new «Менеджер уточнит детали в течение рабочего дня», qualified «Готовим коммерческое предложение», proposal «КП отправлено, ждём вашего решения», contract «Договор и счёт на 50% готовы»,
  paid «Оплата получена, запускаем проект», project «Проект в работе, этапы ниже», lost «Заявка закрыта».
- `estimateUsd`: сумма выставленного счёта, иначе «Итого» из сметы сайта, иначе `null`. `summary`: до 200 знаков из слов самого клиента.
- `timeline` по возрастанию времени, из того, что уже есть: заявка (`lead`), первый ответ менеджера (`reply`), утверждённое КП (`kp`, `ps_documents`), договор (`contract`, `ps_documents` или `bo_documents`),
  счёт (`invoice`) и оплата (`paid`, `bl_invoices`), старт проекта (`project`, `pm_projects`), переносы владельца по этапам (`stage`, журнал `lead_stage`).
- `replies`: переписка по лиду из `cab_messages` (`id, client_id, lead_id, from, text <= 2000, at`, плюс `ticket_id` для связи с тикетом): ответы владельца через `POST /admin/crm/leads/:id/reply`
  (пишутся для лида с кабинетом даже если чат не принял), одобренные ответы головы продаж, сообщения клиента и одобренные ответы Поддержки на них. Для лида без кабинета строк нет.

### POST /admin/clients/:id/leads/:leadId/messages
Тело `{ text }` (1..2000 после обрезки). Клиент неизвестен или лид чужой/не найден: 404 `not_found` (чужой лид неотличим от несуществующего), плохой текст 400 `invalid`,
больше 10 сообщений за час от одного клиента (и 10 обращений Поддержки, общий счётчик с тикетами) 429 `rate_limited`.
Пишет `cab_messages` (`from: client`) и создаёт тикет Поддержки как `POST /admin/clients/:id/tickets` (`cs_tickets.lead_id`, в задаче Поддержки пометка «по заявке #N»): черновик ответа идёт через одобрения,
одобренный ответ дописывается в тот же тред как `from: manager` (один раз на тикет). В журнал задачи лида (голова Продаж) идёт строка, владельцу во входящие без одобрения
«Сообщение по заявке #N от <имя или email>».
```json
{ "ok": true, "item": { "at": "...", "text": "Когда будет КП?", "from": "client", "leadId": 12, "ticketId": 7 } }
```

## Таблицы
| Панель | Таблицы |
|---|---|
| prospects | `pr_prospects` (+ `crm_notes`) |
| leads | `li_leads` + `tasks` (статус) |
| clients | `li_leads`, `cab_clients`, `cs_clients`, `cs_tickets`, `pm_projects`, `bl_invoices`, `bo_documents`; `web_chat_sessions`, `cb_chats` только счётчики |
| tickets | `cs_tickets` (+ `crm_notes`; колонки `source`, `answer`) |
| documents | `bo_documents`, `ps_documents`, `bl_invoices` |
| projects | `pm_projects`, `pm_milestones` |
| referrals | `rf_referrals` |
| reviews | нет таблицы, `available: false` |
| cabinet | `cab_clients`, `cab_messages`, `li_leads.client_id`, `cs_tickets` (+ `lead_id`) |

# Пульт v3 (2026-11-20)

Новые маршруты для хаба, воронки, клиентов 360, проектов, счетов, контента, цифр и «Компании». Код: `apps/hq/src/pult*.ts`, `apps/hq/src/lead-stage.ts`.
Тесты: `apps/hq/tests/pult-*.test.ts`. Общее как выше: `x-admin-token`, 401/404, лимит 6000/10 минут, `{ ok: true, ... }` / `{ ok: false, error, ... }`, времена ISO UTC, деньги `amountUsd`.
Каждая запись зовёт тот же код, что Telegram (очередь одобрений, `/paid`, `/mdone`, `/level`, методы рутин), а не копию. Сайт обязан переживать отсутствие любого поля.

## GET /admin/hub
Одна дешёвая сводка для офиса: по запросу на таблицу, 50 строк входящих, ответ кэшируется на 5 секунд.
```json
{ "ok": true, "generatedAt": "...",
  "departments": { "marketing": { "pending": 2, "approvals": 1, "alerts": 0, "running": 1, "lastActivityAt": "..." }, "sales": {}, "support": {}, "production": {}, "backoffice": {}, "director": {} },
  "inbox": [ { "id": "approval:91", "at": "...", "dept": "marketing", "kind": "approval|alert|lead|payment|ticket|content|info", "title": "...", "link": "approvals:91" } ] }
```
- Всегда все шесть отделов (нули и `lastActivityAt: null`, если пусто). `pending` = задачи отдела в `inbox`, `assigned`, `review`; `running` = в работе; `alerts` = `blocked` (нужен человек); `approvals` = ждущие одобрения отдела (в очереди и отправленные).
- `inbox` новые первыми, не больше 50. Источники: открытые одобрения (`approval`, карточки контента `content`), последние лиды (`lead`), оплаты (`payment`), открытые обращения (`ticket`), алерты и сводки владельцу (`alert`, `info`).
- `link` = `<панель>:<id>`: `leads:12`, `invoices:5`, `tickets:4`, `approvals:<id ядра>`, `content:item:77` (для карточки контента), `inbox:<id>` (алерт или сводка без своей панели). `id` строка вида `lead:12`.

## Лиды (воронка)
`GET /admin/crm/leads` получил в items: `stage`, `nextAction` (строка или `null`), `note`, `lostReason`, `callAt`.
`stage` ∈ `new|qualified|proposal|contract|paid|project|lost` выводится из данных, колонка `li_leads.stage_override` (nullable) хранит ручной ход:
- `qualified`: `isQualified` (услуга и бюджет или смета); `proposal`: одобренное КП (`ps_documents`, kind `kp`); `contract`: договор (`bo_documents` типа contract не отклонён по имени клиента, или одобренный договор пресейла); `paid`: оплачен счёт этого лида; `project`: есть запущенный проект лида (`draft`-резерв не считается); `lost`: контакт лида в `lost_leads` (только пока лид на `new`) или вручную.
- Выведенная стадия побеждает ручную, только когда она дальше по линии; ручная `lost` не прячет оплатившего лида.

`POST /admin/crm/leads/:id` тело `{ "stage"?, "note"?, "lost_reason"? }` (`note` до 2000, `lost_reason` до 500, лишние поля 400) → `{ ok, item }` (строка как в списке). Неизвестный `stage`: 400 `invalid` + `allowed` (список стадий).
409 `illegal_transition` (`from`, `allowed`) только когда лид уже `paid` или `project`, а просят `new`.

`POST /admin/crm/leads/:id/reply` тело `{ "text" }` (1..2000) → `{ ok, sent: true|false, via: "telegram"|"web"|"none" }`. Владелец пишет сам, одобрение не нужно.
`telegram`: лид из клиентского бота (чат в `meta.lead.chatId`), отправка через `ClientChannel`; сбой бота даёт `sent: false`, `via: "telegram"`.
`web`: лид из веб-чата (в задаче лида `meta.lead.sessionId`), текст ждёт в `web_chat_owner_replies` и приходит посетителю **в следующем ответе `/chat`** полем `ownerReplies: string[]` (у веб-чата нет канала наружу). Сессия уже удалена (24 ч): `none`.
`none`: канала нет, сайт показывает «скопируйте и отправьте вручную». В журнал лида (комментарий задачи и `activity` `lead_reply`) запись попадает всегда, с каналом и признаком доставки.

`POST /admin/crm/leads/:id/call` тело `{ "at": "<ISO>" }` → `{ ok, item }` со слотом созвона в `callAt` (колонка `li_leads.chosen_slot`).

## GET /admin/crm/clients/:id (клиент 360)
`id` из `GET /admin/crm/clients` (поле `id` добавлено в items): число из `cab_clients` (строкой, `"3"`) или `c:<имя в нижнем регистре>` для клиента без аккаунта (в пути URL-кодировать). Неизвестный 404.
```json
{ "ok": true, "client": { "id": "3", "name": "...", "email": "...", "telegram": "...", "cabinet": true, "createdAt": "..." },
  "leads": [], "projects": [], "invoices": [], "documents": [], "tickets": [], "referrals": [], "touches": [ { "at": "...", "kind": "lead|message|document|invoice|payment|ticket", "title": "...", "link": "leads:12" } ] }
```
Строки как в панелях (`leads`, `projects`, `invoices` как в `GET /admin/crm/invoices`, `documents` без счетов, `tickets`, `referrals`), до 50 штук. Клиента определяют лиды с его `client_id`, имя, email и Telegram-ник; `touches` не больше 30, новые первыми.

## Проекты
`GET /admin/crm/projects/:id` → `{ ok, item, milestones: [ { id, kind, title, dueAt, doneAt } ], tasks: [ { id, title, status, assignee } ], issues: [ { number, title, state, url } ] }`.
`item` как в списке плюс `note`; `tasks` = задача проекта, задачи этапов и их подзадачи; `issues` = задачи строителям с GitHub-ссылкой (`state` `open|closed`).
`POST /admin/crm/projects/:id` тело одно из:
- `{ "action": "complete_milestone", "milestoneId" }`: команда `/mdone` Производства (этап «Сдача» заводит деплой, последний этап закрывает проект), повтор безопасен;
- `{ "action": "set_deadline", "milestoneId", "dueAt": "<ISO>" }`;
- `{ "action": "set_status", "status": "draft|active|done|paused" }`. `paused` записывается в `pm_projects.status` как есть (раньше такого статуса не было). Другое значение: 400 `invalid` + `allowed`;
- `{ "action": "note", "text" }` (1..2000, заметка владельца, ещё комментарий в задаче проекта).
Ответ `{ ok, item }`. Чужой этап 404, плохое тело 400 `invalid`.

## Счета
`GET /admin/crm/invoices` (`?status=draft|issued|paid|void`, `?limit=`) → `{ ok, available, statuses, items, nextCursor: null }`, строка
`{ id, number, client, title, amountUsd, payAmountUsd, status, dueDate, issuedAt, paidAt, paidVia, txId, payUrl, remindedAt, leadId, projectId }` (`title` = «за что», `payUrl` = ссылка страницы оплаты или `null`). Неизвестный статус: 400 `invalid_status` + `allowed`.
`POST /admin/crm/invoices/:id` тело `{ "action": "remind" | "mark_paid" | "void" }` → `{ ok, item }`:
- `mark_paid` = `/paid <номер>` (голова Сопровождения отмечает оплату, запускает проект и выплату рекомендателю), повтор безопасен; аннулированный счёт 409 `illegal_transition`;
- `remind` = текст напоминания Billing (`reminderText`) клиенту через канал его лида (Telegram-бот), иначе текст кладётся владельцу во входящие. В `item` поле `remindedVia: "telegram"|"owner"`, `remindedAt` обновлён (колонка `bl_invoices.reminded_at`). Только для `issued`, иначе 409;
- `void`: аннулирует, повтор безопасен, оплаченный 409.
Плохое действие 400 `invalid` + `allowed`.

## Контент
`GET /admin/content?week=YYYY-Www` (ISO-неделя, по умолчанию текущая на часах компании; плохая неделя 400 `invalid`):
```json
{ "ok": true, "week": "2026-W48",
  "days": [ { "date": "2026-11-23", "items": [ { "id": 41, "kind": "clip|post|carousel|story|article", "platform": "instagram|blog", "status": "draft|pending|approved|rendering|ready|published|rejected",
    "title": "...", "hook": "...", "caption": { "instagram": "", "tiktok": "", "shorts": "", "dzen": "" },
    "files": [ { "path": "41/1.png", "type": "png", "w": 1080, "h": 1350 } ], "sourceSlug": null, "approvalId": 91, "publishedUrl": null, "error": null,
    "publishedOn": ["instagram"], "igCaption": "подпись\n\n#теги", "macQueued": [] } ] } ],
  "summary": { "pending": 3, "approved": 2, "published": 1, "rendering": 1 } }
```
- Всегда 7 дней (пн..вс), пустой день `items: []`. Строки: `cm_items` (рилс `clip`, пост, карусель, история; профильный пакет идёт как `post`) и статьи блога `cm_articles` (`kind: "article"`, `platform: "blog"`).
- **Отклонение от контракта: id статьи это строка `a<число>` (например `"a12"`), id материала число.** Так номера материалов и статей не пересекаются, `POST /admin/content/a12` работает так же.
- `status`: `draft` (пишется или модель ничего не дала, причина в `error`), `pending` (ждёт владельца), `approved` (одобрен, файлов ещё нет), `rendering` (рилс в очереди или в работе у рендерера), `ready` (есть PNG или `reel.mp4`), `published` (все платформы отмечены), `rejected`. Статья: `pending`, `published` (одобренная публикуется сразу), `rejected`.
- `caption`: подписи платформ из строк `cm_ready` одобренного материала, пока не одобрен из текста материала; `dzen` всегда пустая строка (такой платформы нет). `hook` только у рилса.
- `files[].path` относительно `DATA_DIR/renders`, отдаётся через `GET /admin/files/<path>`; `w` и `h` читаются из заголовка PNG, у видео 1080x1920. `approvalId`: номер одобрения ядра, когда карточка владельцу уже отправлена (иначе `null`; решать можно и без неё).
- `publishedUrl`: адрес YouTube или Instagram из `pb_posts.url`, у статьи `/blog/<slug>`.
- `publishedOn`: платформы, строки которых уже отмечены опубликованными (у статьи `[]`). `igCaption`: подпись Instagram для вставки (текст, пустая строка, хештеги), пока не одобрен `""`. Оба поля для помощника на Маке (`packages/mac-poster`).
- `macQueued` (2026-11-20): площадки, на которые агент поставил материал в очередь Мака (`tools.mac.poster.enqueue`, таблица `mac_queue`), пока не закрыты; у статьи поля нет.
- `?queued=1`: в `days` только материалы с открытой очередью Мака (статей нет), плюс `queuedItems`: все такие материалы любой недели. Отчёт помощника `published` с `url` или `failed` закрывает строку очереди этой площадки.

`POST /admin/content/:itemId` тело `{ "action": "approve|reject|revise|published|rerender|failed", "note"?: string (1..4000), "platform"?: "instagram|tiktok|shorts", "url"?: "https://..." }` → `{ ok, item }` (строка как в списке). Лишние поля и неизвестное действие 400 `invalid` + `allowed`, неизвестный id 404.
- `approve` и `reject` решают то же одобрение, что кнопки Telegram-карточки (`queue.handle`, затем задача и карточка в Telegram закрываются; элемент пакета недели, который ещё не рассылался карточкой, открывается как в «Посмотреть по одному»). Повтор того же решения безопасен: очередь забирает одобрение один раз, второй записи в журнале решений нет. Обратное решение 409 `already_decided`, материал не ждёт владельца (черновик) 409 `not_pending`. У `reject` `note` сохраняется комментарием материала.
- `revise` требует `note`: для материала это новый текст одной части («Править» в Telegram): подписи платформы `platform` или, без `platform`, сценария/слайдов; карточка остаётся `pending`, счётчик чистых одобрений сбрасывается. Для статьи `note` это замечание: карточка закрывается, статья пишется заново. Не ждёт решения: 409 `not_pending`.
- `published`: помечает опубликованными готовые строки платформ (кнопка «Опубликовано»), все или одну `platform`; повтор безопасен; до одобрения 409 `not_ready`; нет такой платформы у материала 400 + `allowed`. Для статьи 409 `not_applicable`.
- `published` с `url` (только `https://`, до 500 символов, нужен `platform`): так отчитывается помощник на Маке. Строка помечается `pb_posts.via = 'mac'`, адрес сохраняется один раз (повтор не меняет), в журнале `mac-poster published` и `published_url`. `url` с другим действием 400.
- `failed` (нужны `platform` и `note`, причина до 300 символов): помощник на Маке не смог опубликовать. Строка остаётся `ready` (ручная карточка в Telegram остаётся, в ней причина), причина видна в `error`, в журнале `mac-poster publish_failed` (повтор той же причины без новой записи). До одобрения 409 `not_ready`. Утренняя сводка Публикатора пишет «Instagram с Мака: опубликовано N, ошибок M» за последние 24 часа.
- `rerender`: рилс ставится в очередь рендера (как `/render`), у поста, карусели и истории PNG рисуются заново. Нельзя (не одобрен, рендер выключен, не нарисовалось): 409 `cannot_rerender` + `reason`.
- Без головы Маркетинга `revise`, `published`, `rerender` дают 503 `unavailable`.

## GET /admin/files/<path>
Отдаёт только файлы из `DATA_DIR/renders` (картинки и видео календаря). Нужен `x-admin-token`, остальные ответы не JSON-контракт, а байты.
- Путь очищается: `..`, `.`, пустые сегменты, `\`, NUL, абсолютные пути и повторное кодирование дают 400; затем `realpath` файла и папки, префикс проверяется (симлинк наружу 404).
- Расширения: `png`, `mp4`, `jpg`/`jpeg`, `webp`, `json` (иначе 400); `content-type` по расширению, `cache-control: private, max-age=300`, `accept-ranges: bytes`.
- `Range: bytes=a-b|a-|-n` даёт 206 с `content-range` (видео для плеера); за пределами файла 416; нечитаемый `Range` игнорируется.
- Только GET. У файлов своё окно лимита (3000 за 10 минут), общие 6000 запросов `/admin/*` они не тратят: страница календаря грузит десятки картинок.

## POST /events (публичный, токен сайта)
Счётчики действий посетителей для цифр маркетинга. Не `/admin/*`: заголовок `x-site-token` = `SITE_EVENTS_TOKEN` (если не задан, то `WEB_CHAT_TOKEN`; нет ни того, ни другого: маршрут 404, один раз предупреждение при старте).
Сайт зовёт с сервера и передаёт IP посетителя в `x-visitor-ip` (верим только с loopback или шлюза docker при верном токене, как у `/chat`).
- Тело `{ "name": "chat_open|builder_done|estimate_pdf|lead_sent|audit_sent|ref_click|cabinet_signup|pay_view|blog_view", "path"?, "ref"?, "locale"? }`. Ответ `{ "ok": true }`.
- Не из списка, плохое тело или не JSON: 400 `invalid` + `allowed` (имена). Без токена 401. Больше 120 событий в минуту с одного IP: 429 `rate_limited` (событие не считается). Тело до 16 КБ.
- Таблица `site_events(day, name, path, ref, locale, count)`: счётчик на день (часы компании), имя, страницу, слаг реферала и язык. Персональных данных нет: IP в таблицу не попадает, `path` очищается до пути страницы (без query, хеша и хоста, `/pay/<номер>` и `/cabinet/<что угодно>` становятся `:id`, длинные и нестандартные сегменты тоже), `ref` только `[a-z0-9_-]{1,32}`, `locale` только `ru` или `en`, остальное пустая строка. Строки старше 400 дней удаляются.

## GET /admin/metrics/week
`?week=YYYY-Www` (по умолчанию текущая неделя компании, плохая 400 `invalid`).
```json
{ "ok": true, "week": "2026-W47",
  "site": { "chat_open": 0, "builder_done": 0, "estimate_pdf": 0, "lead_sent": 0, "audit_sent": 0, "ref_click": 0, "cabinet_signup": 0, "pay_view": 0, "blog_view": 0 },
  "blog": { "hits": 0, "published": 0 },
  "youtube": { "shorts": 0, "views": 0, "subscribers": 0, "delta": 0 },
  "funnel": { "leads": 0, "qualified": 0, "proposals": 0, "contracts": 0, "paid": 0, "projects": 0 },
  "money": { "invoicedUsd": 0, "paidUsd": 0 },
  "prevWeek": { "week": "2026-W46", "site": {}, "blog": {}, "youtube": {}, "funnel": {}, "money": {} } }
```
`days`: ровно семь суток недели (понедельник первым): `[ { "date": "2026-11-16", "site": { ...те же девять имён... }, "blog": { "hits": 0 }, "leads": 0 } ]`. `site` по дням из `site_events`, `blog.hits` из `cm_kv` `blog_hits:<дата>`, `leads` = лиды `li_leads`, пришедшие в эти сутки (по часам компании); пустой день: нули. Суммы `site` и `blog.hits` по дням равны недельным. `days` есть и в `prevWeek`.
`prevWeek` повторяет те же ключи за предыдущую неделю (плюс `week`). Нет данных: нули, не `null`. Неделя считается по часам компании (понедельник 00:00 .. воскресенье 24:00).
- `site`: сумма `site_events` за дни недели, все девять имён всегда есть.
- `blog`: `hits` = обращения к публичному `/blog` (`cm_kv` `blog_hits:<дата>`) и `published` = статьи, одобренные и опубликованные за неделю: функция `aggregate` Аналитика, как в его недельном отчёте.
- `youtube`: `shorts` = Shorts, выложенные Публикатором за неделю (`weekVideoIds` Аналитика по `pb_posts.url`); `subscribers` = подписчики по снимку Аналитика (`an_snapshots`) недели, `delta` = разница с прошлым снимком, `views` = прирост просмотров канала между этими снимками (за неделю по каждому видео Аналитик считает только в тексте отчёта). Нет снимка: нули.
- `funnel`: `leads` = лиды, пришедшие за неделю; `qualified` = из них квалифицированные (по данным, `isQualified` и дальше); `proposals` = одобренные за неделю КП; `contracts` = договоры бэк-офиса, созданные за неделю (не отклонённые); `paid` = счета, оплаченные за неделю; `projects` = запущенные проекты (не черновики-резервы), созданные за неделю.
- `money`: `invoicedUsd` = счета выставленные (`issued`, `paid`) за неделю, `paidUsd` = оплаченные за неделю (сумма `amountUsd`, не `payAmountUsd`).

## Компания
`GET /admin/company`:
```json
{ "ok": true,
  "routines": [ { "name": "marketing-weekly-pack", "dept": "marketing", "title": "...", "cron": "0 6 * * 1", "tz": "Asia/Kuala_Lumpur", "enabled": true, "lastRunAt": null, "lastStatus": null, "nextRunAt": "..." } ],
  "costs": { "byDept": { "marketing": { "todayUsd": 0, "monthUsd": 0, "limitUsd": 0 } }, "byDay": [ { "date": "2026-11-18", "usd": 0 } ] },
  "trust": [ { "kind": "content_item", "level": 0, "locked": false, "approvals": 0 } ],
  "playbooks": [ { "role": "seo", "updatedAt": "2026-11-20T09:00:00.000Z", "lines": 48, "sourceSkills": ["seo-audit", "ai-seo"] } ],
  "workers": [ { "id": "content-maker", "dept": "marketing", "title": "Контент-мейкер", "state": "idle" } ],
  "tools": [ { "name": "web.search", "departments": ["marketing", "sales", "director"], "configured": true, "callsToday": 4, "errorsToday": 0, "limits": { "timeoutMs": 8000, "minGapMs": 1000, "cacheTtlMs": 3600000, "maxResults": 10 }, "env": ["BRAVE_SEARCH_KEY"] } ] }
```
- `routines`: все рутины. `tz` = зона, в которой идёт cron (часы владельца или компании), `lastStatus` = статус задачи последнего запуска (`null`, пока не запускалась), `nextRunAt` = следующий запуск по cron в этой зоне (`null` у выключенной).
- `costs.byDept`: по каждому отделу траты сегодня и в месяце (USD) и месячный лимит (`0` = без лимита); `byDay` = последние 30 суток по часам компании, все дни есть, старые первыми.
- `trust`: уровни доверия по типам одобрений; `locked` = деньги, цены, документы (не растёт сам), `approvals` = сколько раз владелец одобрил (или тип отработал сам на уровне 1).
- `playbooks`: плейбуки ремесла (`knowledge/playbooks/*.md`, по порядку ролей, только существующие файлы): `role` (`content-maker`, `publisher`, `trend-scout`, `seo`, `analyst`, `sales`, `renderer-builder`), `updatedAt` = время изменения файла (ISO), `lines` = число строк, `sourceSkills` = навыки из строки «Источники» файла. Целиком текст отдаёт `GET /admin/company/playbooks/:role`.
- `tools` (2026-11-20, сайт покажет позже): инструменты агентов (`docs/tools.md`): отделы с правом вызова, `configured` (есть ключи и адаптеры; значений ключей нет), вызовы и ошибки за сегодня по часам компании, лимиты, имена env-ключей.
- `workers`: исполнители со статусом офиса (`working|waiting|blocked|idle|sleeping|paused|offline`, как на странице офиса).

`GET /admin/company/playbooks/:role` → `{ "ok": true, "role": "seo", "text": "# Плейбук: ...\n..." }`: весь markdown плейбука, чтобы панель «Компания» показала его. Неизвестная роль или нет файла: 404 `not_found`.

`POST /admin/company/routines/:name` тело `{ "enabled": true|false }` → `{ ok, item }` (рутина как в списке). Выключение запоминается как правка владельца: следующий старт не включает рутину обратно. После переключения HQ перезапускает cron-задачи.
`POST /admin/company/routines/:name/run` → `{ ok, taskId }`: `Hq.runRoutine`, задача и пробуждение головы как у обычного срабатывания. Выключенная: 409 `not_started` + `reason: "disabled"`; прошлая задача рутины ещё идёт (политика `skip`): 409 `not_started` + `reason: "busy"`.
`POST /admin/company/trust/:kind` тело `{ "level": 0 | 1 }` → `{ ok, item }` (запись списка `trust`): тот же код, что `/level <тип> <0|1>`, в том числе для типа с замком (так его и снимают). Неизвестный тип 404, другой уровень 400 `invalid` + `allowed: [0, 1]`.
Плохое тело 400 `invalid`, неизвестная рутина 404.
