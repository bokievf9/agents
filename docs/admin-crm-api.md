# Admin CRM API («Пульт», этап 2)

Read-mostly представления над таблицами исполнителей для панелей firtech.pro/admin. Код: `apps/hq/src/admin-crm.ts`,
маршруты внутри `/admin/*` (`apps/hq/src/admin.ts`). Тесты: `apps/hq/tests/admin-crm.test.ts`.

## Общее
- Транспорт, токен и формат как у остальных `/admin/*`: `x-admin-token`, порт webhook HQ (`127.0.0.1:8787`), без токена 401, без `ADMIN_TOKEN` 404.
  Общий лимит 600 запросов за 10 минут.
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
Обращения клиентов (`cs_tickets`). Параметры: `limit`, `cursor`, `q` (клиент, контакт, текст), `status` (`open`, `answered`).
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
Клиенты регистрируются на сайте через Supabase (email и пароль, Google, Apple), сайт зовёт HQ по loopback с тем же `x-admin-token`.
Те же 401/404 и общий лимит 600 запросов за 10 минут. Код: `apps/hq/src/admin-crm.ts`, тесты: `apps/hq/tests/admin-cabinet.test.ts`.

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
| cabinet | `cab_clients`, `li_leads.client_id`, `cs_tickets` |
