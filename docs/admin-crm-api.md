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
  "items": [{ "id": 3, "clientId": "7", "clientName": "Алиса", "contact": "@alice", "text": "не работает бот", "status": "open", "money": false, "slaAlerted": false,
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
- `projects`: строки как у `GET /admin/crm/projects`; `milestones[]` этапов оплаты: `{ id, stageNo, title, amountUsd, invoiceNumber, payUrl, paidAt, acceptedAt, state, dueAt }` (`title` на языке клиента, `payUrl` только пока счёт этапа выставлен и не оплачен, `state` `awaiting_payment|in_progress|awaiting_acceptance|accepted`).
- `invoices`: строки как у `GET /admin/crm/documents` с `source: "billing"` (плюс `stageNo`), только выставленные и оплаченные (`issued`, `paid`), без черновиков и аннулированных.
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

### POST /admin/clients/:id/projects/:pid/milestones/:no/accept
Клиент принимает готовый этап своего проекта в кабинете («Принять этап»). Проект ищется через лид клиента: чужой проект, неизвестный проект или этап, неизвестный клиент 404 `not_found`.
Этап ещё в работе: 409 `not_ready`; не оплачен: 409 `not_paid`. Успех: `{ ok, already, milestone }` (`milestone` как в `projects[].milestones`, `state: "accepted"`), повтор безопасен (`already: true`, второй счёт не создаётся).
Приёмка один раз: пишется `pm_milestones.accepted_at` (в ленте лида «Этап N принят»), HQ предлагает счёт следующего этапа (карточка на одобрение, ссылка оплаты появится в `milestones[].payUrl` после одобрения),
счёт последнего этапа выставляется при приёмке предпоследнего (передача доступов ждёт его оплаты), владельцу приходит строка во входящие.

### Лиды клиента в `by-email` (`leads`)
Лиды, привязанные к клиенту (`li_leads.client_id`), новые сверху, не больше 20. Внутренних текстов, промптов и заметок владельца нет.
```json
"leads": [{ "id": 12, "createdAt": "...", "service": "site", "summary": "Нужен сайт для салона", "estimateUsd": 1200, "hasDomain": true, "hasHosting": false,
  "stage": "proposal", "nextStep": "КП отправлено, ждём вашего решения",
  "timeline": [{ "at": "...", "kind": "lead", "title": "Заявка получена" }],
  "replies": [{ "at": "...", "text": "Здравствуйте, Алиса!", "from": "manager" }] }]
```
- `stage`: этап Пульта (`new|qualified|proposal|contract|paid|project|lost`, с учётом ручного переноса владельца). `nextStep`: одно предложение на этап, на языке лида (`ru` по умолчанию):
  new «Менеджер уточнит детали в течение рабочего дня», qualified «Готовим коммерческое предложение», proposal «КП отправлено, ждём вашего решения», contract «Договор и счёт первого этапа готовы»,
  paid «Оплата получена, запускаем проект», project «Проект в работе, этапы ниже», lost «Заявка закрыта». Если у проекта лида есть этапы оплаты, `nextStep` важнее: «Оплатите этап N «название»: $сумма» (счёт этапа выставлен) или «Примите этап N «название»» (этап готов).
- `estimateUsd`: сумма выставленного счёта, иначе «Итого» из сметы сайта, иначе `null`. `summary`: до 200 знаков из слов самого клиента.
- `timeline` по возрастанию времени, из того, что уже есть: заявка (`lead`), первый ответ менеджера (`reply`), утверждённое КП (`kp`, `ps_documents`), договор (`contract`, `ps_documents` или `bo_documents`),
  счёт (`invoice`) и оплата (`paid`, `bl_invoices`; у счёта этапа название кончается «: этап N»), приёмка этапа клиентом (`stage_accepted`, «Этап N принят»), старт проекта (`project`, `pm_projects`), переносы владельца по этапам (`stage`, журнал `lead_stage`).
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
`GET /admin/crm/projects/:id` → `{ ok, item, milestones: [ { id, kind, title, dueAt, doneAt, stageNo, amountUsd, invoiceNumber, payUrl, paidAt, acceptedAt, state } ], tasks: [ { id, title, status, assignee } ], issues: [ { number, title, state, url } ] }`.
Оплата по этапам (2026-11-21): у проекта по КП этапы оплаты и есть этапы (`kind: "stage"`), поля этапа `stageNo`, `amountUsd`, `invoiceNumber`, `payUrl` (только пока счёт `issued`), `paidAt`, `acceptedAt` и `state` (`awaiting_payment|in_progress|awaiting_acceptance|accepted`) у этапов старого плана `null`. Строка проекта (в списке и в `item`) несёт `milestones` только из этапов оплаты (`{ id, stageNo, title, amountUsd, invoiceNumber, payUrl, paidAt, acceptedAt, state, dueAt }`).
`item` как в списке плюс `note`; `tasks` = задача проекта, задачи этапов и их подзадачи; `issues` = задачи строителям с GitHub-ссылкой (`state` `open|closed`).
`POST /admin/crm/projects/:id` тело одно из:
- `{ "action": "complete_milestone", "milestoneId" }`: команда `/mdone` Производства (этап «Сдача» заводит деплой, последний этап закрывает проект), повтор безопасен; для этапа оплаты это ПРИЁМКА этапа (`/mdone <проект> <номер>`): приходит счёт следующего этапа, оплаченный этап обязателен;
- `{ "action": "set_deadline", "milestoneId", "dueAt": "<ISO>" }`;
- `{ "action": "set_status", "status": "draft|active|done|paused" }`. `paused` записывается в `pm_projects.status` как есть (раньше такого статуса не было). Другое значение: 400 `invalid` + `allowed`;
- `{ "action": "note", "text" }` (1..2000, заметка владельца, ещё комментарий в задаче проекта).
Ответ `{ ok, item }`. Чужой этап 404, плохое тело 400 `invalid`.

## Счета
`GET /admin/crm/invoices` (`?status=draft|issued|paid|void`, `?limit=`) → `{ ok, available, statuses, items, nextCursor: null }`, строка
`{ id, number, client, title, amountUsd, payAmountUsd, status, dueDate, issuedAt, paidAt, paidVia, txId, payUrl, remindedAt, leadId, projectId, stageNo, stage }` (`stageNo` и `stage: { no, of, title }` у счёта этапа, иначе `null`; колонка `bl_invoices.stage_no`) (`title` = «за что», `payUrl` = ссылка страницы оплаты или `null`). Неизвестный статус: 400 `invalid_status` + `allowed`.
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
- `?queued=1`: в `days` только материалы с открытой очередью Мака (статей нет), плюс `queuedItems`: все такие материалы любой недели. Отчёт помощника `published` с `url` или `failed` закрывает строку очереди этой площадки. Помощник `packages/mac-poster` каждый запуск читает `GET /admin/content?queued=1`, берёт из `queuedItems` материалы с `instagram` в `macQueued` (любой недели, срок «сегодня») и публикует их вместе с одобренными материалами двух недель; один материал не берётся дважды.

`POST /admin/content/:itemId` тело `{ "action": "approve|reject|revise|published|rerender|failed", "note"?: string (1..4000), "platform"?: "instagram|tiktok|shorts", "url"?: "https://..." }` → `{ ok, item }` (строка как в списке). Лишние поля и неизвестное действие 400 `invalid` + `allowed`, неизвестный id 404.
- `approve` и `reject` решают то же одобрение, что кнопки Telegram-карточки (`queue.handle`, затем задача и карточка в Telegram закрываются; элемент пакета недели, который ещё не рассылался карточкой, открывается как в «Посмотреть по одному»). Повтор того же решения безопасен: очередь забирает одобрение один раз, второй записи в журнале решений нет. Обратное решение 409 `already_decided`, материал не ждёт владельца (черновик) 409 `not_pending`. У `reject` `note` сохраняется комментарием материала. `approve` карточки с шаблоном в тексте (`[цена]`, `[решение владельца]`, незаполненные места документа) или устаревшей (счёт уже аннулирован или оплачен): 409 `placeholder` (+ `placeholders`) или `not_ready` (+ `reason`), одобрение остаётся `pending`: владелец правит текст или отклоняет карточку (раньше такое одобрение падало в `failed` навсегда).
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
- Тело `{ "name": "chat_open|builder_done|estimate_pdf|lead_sent|audit_sent|ref_click|cabinet_signup|cabinet_offer_click|pay_view|blog_view", "path"?, "ref"?, "locale"? }`. Ответ `{ "ok": true }`.
- Не из списка, плохое тело или не JSON: 400 `invalid` + `allowed` (имена). Без токена 401. Больше 120 событий в минуту с одного IP: 429 `rate_limited` (событие не считается). Тело до 16 КБ.
- Таблица `site_events(day, name, path, ref, locale, count)`: счётчик на день (часы компании), имя, страницу, слаг реферала и язык. Персональных данных нет: IP в таблицу не попадает, `path` очищается до пути страницы (без query, хеша и хоста, `/pay/<номер>` и `/cabinet/<что угодно>` становятся `:id`, длинные и нестандартные сегменты тоже), `ref` только `[a-z0-9_-]{1,32}`, `locale` только `ru` или `en`, остальное пустая строка. Строки старше 400 дней удаляются.

## GET /admin/metrics/week
`?week=YYYY-Www` (по умолчанию текущая неделя компании, плохая 400 `invalid`).
```json
{ "ok": true, "week": "2026-W47",
  "site": { "chat_open": 0, "builder_done": 0, "estimate_pdf": 0, "lead_sent": 0, "audit_sent": 0, "ref_click": 0, "cabinet_signup": 0, "cabinet_offer_click": 0, "pay_view": 0, "blog_view": 0 },
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

# Ревью-центр (2026-11-21)
Одна поверхность, где владелец читает, правит, одобряет и жмёт «выкладывай»: полноэкранный режим сайта `/admin/review`, чаты с клиентами `/admin/chats` и ссылки для Трендвотчера. Всё под `x-admin-token`, лимит и ошибки как у остальных `/admin/*` (6000 запросов за 10 минут, 401 без токена, 429 `rate_limited`, 500 `internal`). Код: `apps/hq/src/review.ts`, `chats.ts`, `pult-trends.ts`. В логи попадают только номера и счётчики, тексты материалов и клиентов не логируются.
Все решения идут через тот же код, что кнопки Telegram (`ApprovalQueue.handle`, затем задачи и карточка в Telegram закрываются, `settleCard`), второго пути нет: после решения на сайте Telegram-карточка показывает «Одобрено» или «Отклонено» без кнопок, а нажатие на ней потом отвечает «Уже обработано».
Пути медиа вида `/admin/files/<путь>` относительны корня HQ: сайт проксирует их как `/api/admin/files/<путь>` (`GET /admin/files/*`, видео с `Range`).

## GET /admin/review
`?dept=marketing|sales|support|production|backoffice|director|all` (по умолчанию `all`), `?status=pending|decided|all` (по умолчанию `pending`), `?limit=1..200` (по умолчанию 50), `?cursor=<номер>`. Неизвестное значение любого параметра: 400 `invalid` + `hint` (+ `allowed`).
```json
{ "ok": true,
  "items": [ {
    "id": "ap_123", "kind": "content_item", "dept": "marketing", "createdAt": "2026-11-21T03:00:00.000Z", "status": "pending",
    "title": "Запись ночью", "summary": "Клиент пишет в 2 ночи, а бот отвечает",
    "media": [ { "type": "video", "url": "/admin/files/41/reel.mp4", "poster": null, "w": 1080, "h": 1920, "durationS": 28 } ],
    "text": { "body": "...", "draft": "...", "caption": "...", "hashtags": ["#fir"], "captions": { "instagram": "...", "tiktok": "...", "shorts": "..." } },
    "meta": { "slot": "2026-11-23", "platform": "instagram", "format": "reel", "source": "routine" },
    "versions": [ { "v": 1, "createdAt": "...", "text": {}, "media": [], "note": "", "author": "worker" } ],
    "currentVersion": 1, "parentId": null, "taskId": 77, "error": null,
    "actions": ["approve", "edit", "revise", "reject", "reschedule"] } ],
  "counts": { "marketing": 12, "sales": 3, "support": 1, "production": 0, "backoffice": 0, "director": 0 },
  "nextCursor": null }
```
- Список строится из ВСЕХ одобрений компании (`task_approvals`), любого вида. Порядок: новые первыми (по номеру). `nextCursor`: строка для `?cursor=` следующей страницы или `null`. Решённые и лежащие в пачке (ещё не отправленные карточкой) тоже в списке: решать можно и без Telegram-карточки.
- `counts`: сколько ждут владельца по отделам (всегда все шесть ключей, не зависят от `status`, `limit` и `dept`). Карточка пакета недели (`content_pack`) в счёт не входит: считаются её материалы. `director`: зарезервировано, одобрений этого отдела нет, всегда 0 и пустой список.
- `id`: `ap_<номер строки task_approvals>`. Один и тот же, пока одобрение живёт.
- `kind` (все виды одобрений): `content_item`, `content_pack`, `article`, `seo_proposal`, `audit` (Маркетинг); `lead_reply`, `lead_price`, `presales_pack`, `referral_reward`, `referral_payout`, `prospect_first`, `prospect_followup`, `prospect_reply` (Продажи); `support_answer`, `support_money`, `billing_invoice`, `billing_reminder`, `onboarding_guide` (Сопровождение); `pm_spec`, `pm_client_status` (Производство); `bo_document` (Бэк-офис). Профильный старт-кит это `content_item` с `meta.format: "profile"`. Неизвестный новый вид показывается общей карточкой (заголовок из первой строки карточки, `text.body` = её текст, действия `approve`, `reject`).
- `dept`: отдел одобрения (`marketing|sales|support|production|backoffice`).
- `createdAt`: ISO, когда голова поставила одобрение.
- `status`: `pending` (ждёт владельца, в том числе в пачке и пока выполняется), `approved` (одобрено и выполнено; для вида, который решает сам на уровне 1, так и появляется), `rejected`, `published` (материал вышел на всех площадках или статья опубликована на `/blog`), `failed` (одобрение не выполнилось, или одобренный материал не опубликовался: причина в `error`).
- `title`, `summary`: короткие строки для списка (`summary` до 160 знаков, у рилса хук). `error`: причина сбоя публикации или выполнения, иначе `null`.
- `media[]`: `{ type: "video"|"image"|"pdf"|"html", url, poster: string|null, w, h, durationS }` (`w`, `h`, `durationS` могут быть `null`). Сейчас бывают `video` (`reel.mp4` рилса, 1080x1920, `durationS` из сценария) и `image` (PNG поста, слайдов, кадров; размеры из заголовка PNG). `pdf` и `html` зарезервированы под документы, HQ их пока не отдаёт. **Картинки и видео рисуются после одобрения** (посты, карусели, кадры сразу при решении, видео рилса рендерером позже), поэтому у ждущего решения материала `media: []`, а `meta.render.state` говорит, что с ними.
- `text`: объект, ключи зависят от вида (все строки, кроме отмеченных):
  - `content_item`: `body` (сценарий или слайды: текст над подписями), `draft` (весь текст целиком, с метками площадок), `caption` (подпись Instagram без хештегов), `hashtags` (массив из хвоста подписи Instagram), `captions` (`{instagram?, tiktok?, shorts?}`: подписи площадок целиком, ключ есть, только если у материала такая площадка), у старт-кита ещё `kit` (`{instagram, youtube, tiktok}`).
  - `article`: `subject` (заголовок), `body` и `draft` (превью статьи, как в карточке).
  - `presales_pack`: `body` (КП) и `documents` (`[{ key: "kp"|"estimate"|"contract", title, body }]`).
  - `seo_proposal`: `body` (что менять), `page`.
  - `content_pack`, `referral_*` и неизвестные виды: `body` (текст карточки).
  - остальные виды с текстом для клиента (`lead_reply`, `lead_price`, `support_*`, `bo_document`, `billing_*`, `onboarding_guide`, `pm_*`, `prospect_*`, `audit`): `draft` и `body` (одинаковые: текст, который правит владелец и который уйдёт или будет утверждён).
- `versions[]`: `{ v, createdAt, text, media, note, author: "owner"|"worker" }`, по возрастанию `v`; `text` и `media` того же вида, что у элемента. Нетронутый материал: одна версия `v: 1`, `author: "worker"`. Первая правка владельца записывает снимок до правки как `v: 1`, правка идёт как `v: 2`, `author: "owner"`, `note: "владелец"` или `"владелец: <note>"`. У материала, сделанного по «Правкам» (`revise`), версии родителя идут первыми, а его собственная первая версия получает `note: "владелец: <замечание>"`. У материала по ссылке владельца для Трендвотчера `versions[0].note` это разбор ссылки (формат, хук, структура, почему работает, аналог). Тексты версий читаются и в списке, и в ответе действия.
- `currentVersion`: номер последней версии. `parentId`: `id` материала, который эти «Правки» переделывают (у статьи: прошлая карточка той же статьи), иначе `null`.
- `taskId`: задача отдела, из которой пришло одобрение.
- `actions[]`: какие действия сейчас можно (всегда в этом порядке): `approve`, `edit`, `revise`, `reject`, `publish_now`, `reschedule`, `send`, `call`. Правила:
  - `approve`, `reject`: пока `pending`. `edit`: пока `pending` и у вида есть текст для замены (`content_item`; `lead_reply`, `lead_price`, `support_answer`, `support_money`, `bo_document`, `billing_invoice`, `billing_reminder`, `onboarding_guide`, `pm_spec`, `pm_client_status`, `prospect_*`, `audit`). Нет у `article`, `content_pack`, `presales_pack`, `referral_*`, `seo_proposal`.
  - `revise`: пока `pending`, для `content_item` (кроме старт-кита профиля) и `article`, и только если в процессе есть голова Маркетинга.
  - `publish_now`: `article` пока `pending`; `content_item` (кроме старт-кита), если он не вышел везде: `pending` пост, карусель или история (одобрится и уйдёт), `pending` рилс не предлагается (видео ещё нет), одобренный или `failed` материал, если у него есть видео рилса или картинки.
  - `reschedule`: `content_item`, которому ещё есть что публиковать (`pending`, `approved`, `failed`).
  - `send`: пока `pending`, для `lead_reply`, `lead_price`, `support_answer`, `support_money`, `audit`.
  - `call`: в любом статусе, у вида есть лид (`lead_reply`, `lead_price`, `presales_pack`, `billing_*` по счёту лида, `support_*` по тикету лида).
  - Решённый (`rejected`, `published`) материал не даёт ничего, кроме `call`.
- `meta` (общее для видов; чего нет, того ключа нет):
  - `content_item`: `slot` и `plannedDate` (день публикации `YYYY-MM-DD`, времени у материала нет: публикует утренний проход), `platform` (`instagram`, у старт-кита `all`), `platforms` (площадки материала: `instagram|tiktok|shorts`), `format` (`reel|post|carousel|story|profile`), `itemId`, `source` (`owner_link`: по ссылке владельца; `owner`: заказ владельца, в том числе «Правки»; `routine`: рутина и пакет недели; метки `trend` HQ не ставит, тренды дня идут в подсказки промпта незаметно), `render` (`{ state: "none"|"rendering"|"ready"|"failed" }`: `none` до одобрения), `publishedOn` (площадки, где уже вышло), `macQueued` (площадки, которые ждут помощника на Маке), `publishedUrl` (адрес YouTube или Instagram, `null`), `sourceSlug` (из какой статьи сделан), `link` (`{ id, url, note }`: ссылка владельца, из которой он вырос), `heldByPack: true` (материал лежит под карточкой пакета недели), `pack` (`id` карточки пакета, пока она открыта), `revision` (пока есть «Правки»: `{ taskId, state: "working"|"delivered", reviewId }`, `reviewId` это `id` нового материала, когда отдел его сдал).
  - `content_pack`: `pack: { count, itemIds: ["ap_..."] }`, `source: "routine"`.
  - `article`: `platform: "blog"`, `article: { id, niche, line: "ai"|"niche", slug }`, `url` (`/blog/<slug>`, пока не опубликована `null`), `source`, `revision` как выше.
  - Лиды и клиенты: `lead` (`{ id, name, contact, service, budget, stage, source, temperature, taskId, callAt, cabinet }` или `null`; `stage`: `new|qualified|proposal|contract|paid|project|lost`) и `client` (`{ id, email, cabinet }`, `id` и `email` `null` без кабинета) у `lead_reply`, `lead_price`, `presales_pack`, `support_*`, `billing_*`; `delivery` (`telegram`: бот @firtech_bot отправит сам; `owner`: текст уйдёт владельцу, пересылает он; у `audit` `contact`) у `lead_reply`, `lead_price`, `support_*`, `audit`.
  - `billing_invoice`: `meta.stage` `{ no, of, title, amountUsd }` у счёта этапа оплаты (у остальных поля нет).
  - `presales_pack`: `pack` (`{ id, direction, totalUsd, prepayUsd, prepayPercent, stages, timeline }`). `support_*`: `ticket` (`{ id, clientName, contact, status, money, question, createdAt, answeredAt }` или `null`). `billing_*`: `invoice` (`{ id, number, client, amountUsd, dueDate, status, what, leadId, projectId }`). `bo_document`: `document` (`{ id, type, client, version, projectId }`). `referral_*`: `referral` (`{ id, referrer, referred, status, reward }`). `pm_*`: `project` (`{ id, client, status }`). `onboarding_guide`: `client` (`{ id: null, email: null, cabinet: false, name }`), `onboarding: { id }`. `prospect_*`: `prospect` (`{ id, name, niche, city, telegram, instagram }`), `draftKind` (`first|followup|reply`). `seo_proposal`: `seo: { key, page, needsBuilder }`. `audit`: `audit: { id, host, locale }`. Если строки в базе уже нет, в объекте остаётся только `{ id }`.
- Пакет недели: карточка `content_pack` это отдельный элемент (действия `approve`, `reject`), а каждый её материал отдельный элемент `content_item` с `meta.heldByPack`. `approve` материала решает только его (у него появляется своя строка одобрения без Telegram-карточки), карточка пакета остаётся и дальше одобряет остальные. `approve` или `reject` пакета решает оставшиеся.

## POST /admin/review/:id
`:id` вида `ap_<номер>`. Тело `{ "action": "approve|edit|revise|reject|publish_now|reschedule|send|call", "text"?: {...}, "note"?: string (1..4000), "slot"?: string (до 40), "platform"?: "instagram|tiktok|shorts|youtube" }`, лишние поля запрещены. `youtube` это `shorts`. Ответ `{ ok: true, item }` (элемент как в списке, уже после действия) плюс поля действия. Порядок проверок: 404 `not_found` (id не такого вида или нет), 400 `invalid` + `allowed` (плохое тело), затем повторы и состояния, затем действие.
- Повтор того же решения безопасен (`approve` уже одобренного или опубликованного, `reject` уже отклонённого дают `{ ok: true, item }`, в журнале решений второй записи нет). Обратное решение: 409 `already_decided` + `status`. `edit`, `revise`, `send` не у `pending`: 409 `not_pending` + `status`; так же `approve`/`reject` у `failed`. Действие, которого нет в `actions` элемента: 409 `not_applicable` + `status` + `actions` (список допустимых сейчас). `approve` карточки с шаблоном в тексте или устаревшей карточки счёта: 409 `placeholder` (+ `placeholders`) или `not_ready` (+ `reason`), одобрение остаётся `pending`.
- `approve`, `reject`: решение ядра, как нажатие кнопки. Предложение, которое ещё не уходило карточкой (лежит в пачке, под пакетом), получает строку одобрения без карточки. `reject` с `note` у `content_item` сохраняет замечание комментарием материала. Если выполнение одобренного упало: `200 { ok: false, error: "failed", status: "failed", item }`.
- `edit`: владелец заменил текст сам (в Telegram это «Править»), тело `text` обязательно (иначе 400 `invalid`). Одобрение остаётся `pending`, счётчик чистых одобрений сбрасывается, в журнале решений запись `edit`, Telegram-карточка показывает новый текст с кнопками, нового сообщения владельцу не приходит. Создаётся версия `v+1` (`note: "владелец"`, с `note` в теле: `"владелец: <note>"`). Что можно передать в `text` (ключи строгие, лишний: 400 `invalid`):
  - `content_item`: `draft` (весь текст сразу), `body` (сценарий или слайды: только эта часть), `captions` (`{ instagram?, tiktok?, shorts? }`: подпись площадки целиком), `caption` и `hashtags` (подпись и хештеги Instagram: собираются обратно в `captions.instagram`). Можно несколько ключей сразу. Метки площадок HQ расставляет сам. Такой части у материала нет, текст пустой или не изменился: 409 `not_applied` + `reason`.
  - остальные виды: `draft` (или `body`), непустая строка до 8000; не изменился: 409 `not_applied`.
- `revise`: замечание владельца для исполнителя, `note` обязателен (400 `invalid`). Материал: задача Маркетингу (`meta.action: "revise_item"`, замечание, исходный текст, `reviseOf` = id элемента), Контент-мейкер пишет НОВЫЙ материал того же типа, темы и дня; исходный остаётся `pending`, пока владелец не решит любой из двух. Когда отдел сдаёт, новая карточка приходит как новый элемент с `parentId` и общими версиями, а у исходного `meta.revision` = `{ taskId, state: "delivered", reviewId }`. Ответ `{ ok, state: "revising", taskId, item }`. Статья: карточка закрывается (`rejected`), статья пишется заново с замечанием, новая карточка той же статьи будет иметь `parentId`, ответ `{ ok, state: "revising", item }`. Правок вне Маркетинга нет, `revise` там не предлагается (`actions`); без головы Маркетинга `revise`, `publish_now` и `reschedule` не предлагаются тоже.
- `publish_now` («Выложить сейчас»): сначала `approve`, если `pending` (тот же путь; упало выполнение: `200 { ok: false, error: "failed", ... }`), затем публикация. Без `platform` идёт по всем площадкам материала (рилс: `instagram`, `tiktok`, `shorts`), с `platform` по одной.
  - `shorts` (YouTube): тот же `YouTubePoster`, что в утреннем проходе: квота 1600 из 10 000, потолок 9000, одна попытка. Успех: строка помечается опубликованной так же, как делает утренний проход, адрес в `url`.
  - `instagram`, `tiktok`: очередь помощника на Маке (`mac_queue`, флаг `queued=1` читает `GET /admin/content?queued=1`), состояние `queued`, адрес придёт отчётом помощника.
  - Статья: публикует само одобрение (`/blog/<slug>`), состояние `published`.
  - Ответ `{ ok: true, state: "published"|"queued", url?, results?, item }`: `state` `published`, если всё вышло сразу, иначе `queued`; `url` первого опубликованного; `results` (материал): `[{ platform, state: "published"|"queued"|"skipped"|"manual"|"failed"|"not_ready", url?, reason?, error?, quota? }]`. `skipped`: уже опубликовано, `manual`: у площадки нет автоматической публикации в этом HQ (для `shorts` нет `YT_OAUTH_CLIENT_JSON` и `YT_REFRESH_TOKEN`), утренняя карточка остаётся ручной, `not_ready`: нет видео или картинок, `reason` по-русски.
  - Сбой: `200 { ok: false, error: "publish_failed", state: "failed", message, results, item }`: материал остаётся `failed` (`error` с причиной, причина лежит в `pb_posts.error`), утренний проход повторит попытку как обычно, владелец может нажать ещё раз. Исчерпана квота YouTube: то же, в `results[].quota: true` и без запроса к YouTube.
  - С явным `platform`, который сейчас нельзя: 409 `not_ready` (+ `reason`, `results`, `item`) или 409 `not_configured` (нет автопубликации YouTube). Ни одной площадки не сделано: 409 `not_ready`. Материал после одобрения не получил текстов площадок: 409 `not_ready`; такой площадки у материала нет: 400 `invalid` + `allowed`.
- `reschedule`: `slot` обязателен, `YYYY-MM-DD` или ISO-дата с временем (берётся день, время у материала не хранится): 400 `invalid` + `hint`. Меняет `cm_items.planned_date` и дату ещё не опубликованных строк. Ответ `{ ok, item }`.
- `send`: отправить клиенту то, что в карточке. `text.draft` необязателен: если он есть и отличается, сначала запись `edit` (версия `v+1`), затем `approve` тем же путём. Ответ `{ ok: true, state: "sent"|"handed_off", via: "telegram"|"cabinet"|"owner", item }`: `sent` с `via: "telegram"` когда бот @firtech_bot отправил клиенту сам (у лида есть чат), `sent` с `via: "cabinet"` когда ответ лёг в тред кабинета, `handed_off` с `via: "owner"` когда текст отдан владельцу переслать вручную (так же ведёт себя кнопка в Telegram). Доставка не удалась (бот заблокирован и т. п.): `200 { ok: false, error: "not_delivered", status, via, item }`, одобрение остаётся `failed`. Остался шаблонный маркер в квадратных скобках (`[цена]`, `[решение владельца]`) у `lead_price`, `support_money`, `support_answer`: 409 `placeholder` + `placeholders`, ничего не отправлено. Ответ клиенту СВОИМИ словами без черновика: `POST /admin/chats/:id/reply`.
- `call`: `slot` обязателен, ISO-дата со временем (`2026-11-24T10:00:00Z`; без времени или не дата: 400 `invalid`), записывает слот созвона лида существующим путём `POST /admin/crm/leads/:id/call`. Ответ `{ ok, callAt, item }`; вида без лида 409 `not_applicable`.

## GET /admin/chats и ответы клиентам
Один тред на клиента, собранный из кабинета (`cab_clients`, `cab_messages`), лидов и ответов на них, тикетов Поддержки, сессий веб-чата сайта и диалогов @firtech_bot. Как склеиваются: по номеру клиента кабинета (у лида `client_id`, сообщения кабинета), иначе по одному контакту (email, Telegram-ник в любой записи `@ник`, `ник`, `t.me/ник`, телефон от 7 цифр), иначе по одной сессии или чату (лид хранит `chatId` или `sessionId` своей задачи). Анонимный диалог без лида, тикета и кабинета остаётся отдельным тредом.
**Тексты анонимных диалогов веб-чата и бота не хранятся (правило проекта: у чата только маскированная сводка), поэтому у такого треда нет сообщений, пока человек не стал лидом, тикетом или клиентом кабинета.** Сообщения треда: первое обращение лида, сообщения кабинета, вопросы и ответы по тикетам, одобренные ответы на лид, ответы владельца из этого раздела и со страницы лида.

`GET /admin/chats?status=open|all&limit=1..200&cursor=<число>` (по умолчанию `open`, 50). `open`: есть непрочитанное, или открытый тикет, или была активность за 7 дней. Неизвестное значение: 400 `invalid`.
```json
{ "ok": true, "unread": 2, "nextCursor": null,
  "items": [ { "id": "c3", "client": { "id": 3, "name": "Анна", "email": "anna@example.com", "contact": "@anna" },
    "channels": ["cabinet", "telegram"], "lastAt": "2026-11-21T05:10:00.000Z", "unread": 1, "preview": "Когда будет готов макет?",
    "leadId": 12, "ticketId": null, "textsStored": true, "openTicket": false } ] }
```
- Порядок: по `lastAt`, новые первыми. `unread` (верхнего уровня): число тредов с непрочитанным; `nextCursor`: смещение следующей страницы или `null`.
- `id` треда: `c<номер клиента кабинета>`, иначе `l<номер лида>`, иначе `t<номер тикета>`, иначе `w<сессия сайта>`, иначе `g<chat id бота>`. Когда треды склеиваются, id может смениться, поэтому `GET`/`POST` принимают любой псевдоним (`l12` открывает тред `c3`, если лид 12 принадлежит клиенту 3).
- `client`: `{ id (кабинета или null), name, email|null, contact }`; без имени `"Посетитель сайта"`, у бота без лида `@ник`. `channels`: `web|telegram|cabinet`. `unread`: сообщения клиента после последнего сообщения владельца или HQ. `preview`: последнее сообщение, у треда без текстов маскированная сводка. `leadId`: новейший лид, `ticketId`: новейший тикет. `textsStored: false` у треда без сообщений (см. выше).

`GET /admin/chats/:id` → `{ ok, thread, messages: [ { id, at, from: "client"|"hq"|"owner", channel: "web"|"telegram"|"cabinet", text, attachments: [] } ] }` (`thread` как строка списка, сообщения по возрастанию времени). Неизвестный 404. `id` сообщения: `cab_<n>` (кабинет), `lead_<n>` (первое обращение лида), `tk_<n>_q`/`tk_<n>_a` (вопрос и ответ тикета), `rp_<n>` (одобренный ответ на лид), `ow_<n>` (ответ владельца без кабинета). Вложений HQ пока не хранит: `attachments` всегда `[]`. Реплика владельца в треде клиента кабинета показывается с `channel: "cabinet"` (так она лежит в треде).

`POST /admin/chats/:id/reply` тело `{ "text": 1..2000 }` (лишние поля 400 `invalid`, неизвестный тред 404) → `{ ok: true, sent, via, message, thread }`. Владелец написал сам, поэтому **одобрения нет**: текст уходит на последний канал клиента (где он написал последним), если не вышло, на следующий адрес по порядку Telegram-бот (`chatId`), сайт (`sessionId`, текст ждёт следующего ответа чата), кабинет. `via`: `telegram|web|cabinet|none`, `sent` = `via != "none"`. Если у клиента есть кабинет и лид, ответ ВСЕГДА пишется в тред кабинета (`cab_messages`, автор `owner`), иначе он хранится в `ch_messages`. В журнал лида (комментарий задачи «Ответ владельца (канал): текст» и `activity` `chat_reply`) запись попадает всегда, с признаком доставки. Недоставленный ответ (сессия сайта исчезла, бот заблокирован, нет адреса) возвращается как `200 { ok: true, sent: false, via: "none" }` и остаётся в треде, сайт показывает «не доставлено, отправьте вручную». `message` строка треда (`from: "owner"`), `thread` обновлённая строка.

## Ссылки владельца для Трендвотчера
`POST /admin/trends` тело `{ "url": string (1..600), "note"?: string (до 500) }` и Telegram `/trend <ссылка> [заметка]` (только владелец, Директор, команда в `/help`, в меню бота нет: меню заполнено 20 командами). Берутся публичные https-ссылки на пост или ролик Instagram, TikTok и YouTube (хосты `www.instagram.com`, `instagram.com`, `www.tiktok.com`, `vm.tiktok.com`, `vt.tiktok.com`, `www.youtube.com`, `m.youtube.com`, `youtube.com`, `youtu.be`), без логина в адресе. Лишние поля и пустой `url`: 400 `invalid`; не ссылка, не https, чужой хост, логин в адресе: 400 `invalid_link` + `reason` (по-русски). Без головы Маркетинга 503 `unavailable`. Та же ссылка за последние сутки (не упавшая) не ставится второй раз: `already: true` и прежняя строка. Ответ `{ ok: true, already, item }`.
Что происходит: задача Маркетингу (`meta.action: "owner_link"`), Трендвотчер через `ctx.tools.web` читает то, что платформа показывает анонимному посетителю (oEmbed YouTube и TikTok, тэги `og:*` страницы; у Instagram oEmbed без токена приложения нет, остаются `og`-тэги; логина и входа нет никогда, хосты только из списка выше, `docs/tools.md`), анализирует (формат, хук, структура, почему работает, цифры только если они есть на странице, аналог для Fir Tech) и сохраняет разбор в `ts_links`. Затем Маркетинг ставит Контент-мейкеру задачу `topic` с аналогом (рилс, карусель или пост, разбор идёт подсказкой в промпт), материал проходит обычный конвейер (ревью по чек-листу, одобрение, рендер после решения) и появляется в ревью-центре с `meta.source: "owner_link"`, `meta.link` и разбором в `versions[0].note`. Владельцу приходит сообщение «Разбор ссылки готов» (во входящие или в Telegram по присутствию).
`GET /admin/trends?limit=1..200&cursor=<id>` → `{ ok, items, nextCursor, statuses: ["analysing","proposed","done","failed"] }`, новые первыми, неверный параметр 400 `invalid`. Строка:
```json
{ "id": 3, "url": "https://www.youtube.com/shorts/xyz789", "host": "www.youtube.com", "platform": "youtube", "note": "", "status": "proposed", "error": null,
  "createdAt": "...", "updatedAt": "...", "taskId": 91,
  "analysis": { "format": "...", "hook": "...", "structure": ["..."], "whyItWorks": "...", "numbers": null, "analogue": { "type": "clip|carousel|post", "topic": "...", "angle": "..." } },
  "reviewId": "ap_412", "itemId": 57 }
```
`status`: `analysing` (ждёт Трендвотчера, читает и анализирует, пишется аналог), `proposed` (аналог ждёт владельца в ревью-центре, `reviewId` его элемент), `done` (владелец решил аналог: одобрил или отклонил), `failed` (`error` по-русски: страница не отдала данные без входа, нет LLM, разбор не получился, аналог не получился; при сбое аналога `analysis` остаётся). `analysis`, `reviewId`, `itemId` бывают `null` до своего шага. `platform`: `youtube|instagram|tiktok`.

## Reach (2026-11-21)
Agent Reach на Маке владельца (`packages/mac-poster`, `reach:run`): очередь заданий для CLI `agent-reach`, который нельзя запустить в контейнере HQ. Все маршруты под `x-admin-token`, код `apps/hq/src/reach.ts`, таблица `rc_jobs` (`id`, `key` = sha256 канала, действия и аргументов, `channel`, `action`, `args`, `task_id`, `waiters`, `agent_id`, `status` = `queued|running|done|failed`, `result`, `error`, `created_at`, `started_at`, `finished_at`, `ttl`).
- `GET /admin/reach/jobs?status=queued|running|done|failed&limit=1..100&channels=youtube,web` → `{ ok, items: [ { id, channel, action, args, status, taskId, agentId, error, createdAt, startedAt, finishedAt } ], counts: { queued, running, done, failed }, channels }`. Без `status` последние задания, с `status` старые первыми (очередь для Мака). `channels` (через запятую из `youtube|web|instagram|twitter|reddit|linkedin|github`) Мак сообщает так, какие каналы у него настроены: HQ кладёт их в `settings.reach.channels`; неизвестное имя 400 `invalid`. Каждый вызов сначала закрывает зависшие задания (в очереди дольше 6 часов или в работе дольше 30 минут: `failed`).
- `POST /admin/reach/jobs/:id/claim` тело `{ "channels"?: [..] }` → `{ ok, item }`; уже взятое или законченное 409 `already_claimed`; неизвестное 404.
- `POST /admin/reach/jobs/:id/result` тело `{ "ok": true, "result": { "ok", "items": [..], "meta": {..}, "error"?: { code, message, hint } } }` или `{ "ok": false, "error": "причина до 300" }` (с необязательным `result`). Ответ `{ ok, item, already }`: повтор после ответа ничего не меняет (`already: true`); задание без `claim` 409 `not_claimed`; неверное тело 400; неизвестное 404. `result.ok: false` (NEED_LOGIN, NOT_FOUND...) делает задание `failed` и сохраняет ответ CLI. Результат хранится до 200 КБ (длинные тексты режутся, `meta.truncated: true`); это единственный маршрут с телом до ~420 КБ (остальные 16 КБ).
- `POST /admin/reach` тело `{ channel, action, args }` (владелец или скрипт; те же проверки, кэш и потолок, что у агента) → `{ ok, item, cached }`; плохой канал, действие или аргумент 400 `invalid` с `hint`; потолок 200 заданий в сутки 429 `cap`.
- `GET /admin/reach/:id` → `{ ok, item }` вместе с `result` (ответ CLI) и `error`; неизвестный 404.
Аргументы: строки без управляющих знаков и не начинаются с `-`, `limit` 1..25, лишние ключи 400. Тот же (канал, действие, аргументы) отдаёт открытое задание, готовое за 24 часа или упавшее за последний час (не повторяется). Задачу, ждавшую задание (`blocked`, тег `reach-wait`), HQ возвращает в inbox, когда закрыты все её задания. Старше 7 дней задания удаляются ночной очисткой (`rendersCleanup` Бэк-офиса).
`GET /admin/trends`: у строки ссылки новые поля `chip` (`"ждёт Мак"` пока задание в очереди, `"Мак читает"` пока Мак его выполняет, иначе `null`) и `reach` (`{ jobId, status, channel, action }` или `null`); `status` остаётся `analysing`.

## POST /admin/prices/reload
Загружает прайс-лист сайта сразу (тот же `x-admin-token`): `{ ok, updatedAt, source: 'fetched'|'cached'|'fallback' }`; HQ и так перечитывает его каждые 15 минут (`PRICES_RELOAD_MS`).

## Таблицы и отличия от черновика
- Новые таблицы: `review_versions` (версии, ключ `approval_id` = id элемента: `v`, `created_at`, `text` и `media` JSON, `note`, `author`), `ch_messages` (ответы владельца клиентам без кабинета), `ts_links` (ссылки владельца и их разбор). Колонка `cab_messages.author` (`owner|hq`, по умолчанию `hq`): кто написал строку менеджера (ответ владельца со страницы лида или из чатов пишется как `owner`). Очередь Мака: `mac_queue` (общая функция `macEnqueue` в `@fir/core`).
- Отличия от черновика контракта: `id` это `ap_<номер строки task_approvals>` (составных id нет); `meta.slot` у материала это день `YYYY-MM-DD` (в HQ нет времени публикации), `reschedule` принимает день; `meta.source` не выдаёт `trend` (см. выше), есть `owner`; у `GET /admin/chats` добавлены `textsStored`, `openTicket` и верхнеуровневый `unread`, и тексты анонимных диалогов веб-чата и бота не хранятся; `publish_now` для нескольких площадок возвращает `results`; сбой публикации и недоставка это `200` с `ok: false` (как у `POST /admin/approvals`); `revise` есть только у материалов Маркетинга (`content_item`, `article`); `send` это `approve` с необязательной правкой текста и ответом о доставке, а не второй путь отправки; в `GET /admin/review` добавлены `taskId` и `error`, у статуса `published` и `failed`.
