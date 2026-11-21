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
**`enrichment` (2026-11-22, ИИ-менеджер заявок 2.0)**: у каждой строки (и в `GET /admin/crm/clients/:id` (клиент 360), `meta.lead` карточки ревью) поле `enrichment` или `null` (лид старше поля):
```json
"enrichment": { "summary": ["Бизнес: салон красоты; задача: вечерние заявки.", "Подходит: ИИ-администратор; каналы: instagram; срок: не назван.", "Предложено: сборку по ссылке, созвон; контакт оставил; вопросов в диалоге: 2."],
  "productFamily": "admin", "niche": "салон красоты", "intentScore": 71, "builderLink": "/ru/builder?b=k.salon~p.adminbot~g.booking" }
```
`summary`: до трёх строк (по-русски, для владельца); `productFamily`: продукты, которые определил ИИ-менеджер заявок, через запятую в порядке каталога (`admin|receptionist|automation|content|miniapp|agent|ai|site|bot|app`; 2026-11-22: их может быть несколько, «админ-бот и ещё сайт» это `admin, site`; `summary[1]` и поле `product` лида называют их все, `service` лида по первому), у лидов формы это услуга (`bot`, `site`, `app`, `automation`, `bundle`) или выбранный продукт; `niche`; `intentScore` 0..100 (у разговора: что назвал посетитель, цена, контакт, просьба о менеджере; у лида формы: 80/55/25 по температуре); `builderLink`: путь сайта `/<locale>/builder?b=...`, который предложил приёмщик (у лида формы найденный в его смете). Тот же блок печатается строками в тексте карточки Приёмщика (`Разговор:`, `Семейство продукта`, `Намерение: N/100`, `Сборка, которую предложил ИИ-менеджер заявок`) и в `meta.lead.enrichment` элемента `lead_reply` в ревью-центре. Лид из веб-чата или бота приносит свой `enrichment` в задаче (`meta.lead.enrichment`, схема `enrichmentSchema` в `@fir/worker-lead-intake`); `POST /lead` формы его не принимает от сайта.

**Разбор заявки (2026-11-21)**: к строке лида (`GET /admin/crm/leads`, клиент 360) и к `meta.lead` карточек ревью добавлены три поля для блока «Разбор заявки» на сайте: `message` (слова клиента, поле `task` лида целиком, до 4000 знаков; в `task` по-прежнему обрезка 500), `estimate` (текст сметы так, как пришёл с сайта, до 4000 знаков, `""` если нет) и `builderUrl` (ссылка сборки: сначала `enrichment.builderLink`, иначе первая ссылка `https://firtech.pro/<locale>/builder?b=...` в `message` или `estimate`; `null`, если ссылки нет; хвостовая пунктуация срезана).

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
  new «Первый ответ за 5 минут, круглосуточно; цены и сроки подтверждает основатель», qualified «Готовим коммерческое предложение», proposal «КП отправлено, ждём вашего решения», contract «Договор и счёт первого этапа готовы»,
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
- `{ "action": "complete_milestone", "milestoneId" }`: команда `/mdone` Производства (этап «Сдача» заводит деплой, последний этап закрывает проект), повтор безопасен; для этапа оплаты это ПРИЁМКА этапа (`/mdone <проект> <номер>`): приходит счёт следующего этапа, оплаченный этап обязателен; с 2026-11-22 (P-15) только из `awaiting_acceptance`: неоплаченный этап 409 `not_paid`, этап в работе 409 `not_ready` + `hint` (сначала `ready_milestone`);
- `{ "action": "ready_milestone", "milestoneId" }` (2026-11-22, P-14): этап оплаты готов без цепочки строителя, команда `/mready <проект> <номер>`: `markDone` + `afterMilestone`, клиент получает строку в треде проекта и письмо «Этап N готов к приёмке», `nextAction: accept_stage`. Неоплаченный этап 409 `not_paid` + `hint`; повтор ничего не шлёт (200). У этапа старого плана то же, что `complete_milestone`;
- `{ "action": "set_deadline", "milestoneId", "dueAt": "<ISO>" }`;
- `{ "action": "set_status", "status": "draft|active|done|paused" }`. P-15: `done` у проекта с этапами оплаты, пока не все этапы приняты, 409 `stages_open` + `stages` (номера) + `hint` (проект закрывается приёмкой последнего этапа, акт уходит сам). `paused` записывается в `pm_projects.status` как есть (раньше такого статуса не было). Другое значение: 400 `invalid` + `allowed`;
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
  - `presales_pack`: `body` (КП) и `documents` (`[{ id, key: "kp"|"estimate"|"contract", title, body }]`; `id`: строка `ps_documents` этого пакета (новейшая каждого вида), `null`, если строки нет).
  - `seo_proposal`: `body` (что менять), `page`.
  - `content_pack`, `referral_*` и неизвестные виды: `body` (текст карточки).
  - остальные виды с текстом для клиента (`lead_reply`, `lead_price`, `support_*`, `bo_document`, `billing_*`, `onboarding_guide`, `pm_*`, `prospect_*`, `audit`): `draft` и `body` (одинаковые: текст, который правит владелец и который уйдёт или будет утверждён).
- `versions[]`: `{ v, createdAt, text, media, note, author: "owner"|"worker" }`, по возрастанию `v`; `text` и `media` того же вида, что у элемента. Нетронутый материал: одна версия `v: 1`, `author: "worker"`. Первая правка владельца записывает снимок до правки как `v: 1`, правка идёт как `v: 2`, `author: "owner"`, `note: "владелец"` или `"владелец: <note>"`. У материала, сделанного по «Правкам» (`revise`), версии родителя идут первыми, а его собственная первая версия получает `note: "владелец: <замечание>"`. У материала по ссылке владельца для Трендвотчера `versions[0].note` это разбор ссылки (формат, хук, структура, почему работает, аналог). Тексты версий читаются и в списке, и в ответе действия.
- `currentVersion`: номер последней версии. `parentId`: `id` материала, который эти «Правки» переделывают (у статьи: прошлая карточка той же статьи), иначе `null`.
- `taskId`: задача отдела, из которой пришло одобрение.
- `actions[]`: какие действия сейчас можно (всегда в этом порядке): `approve`, `edit`, `revise`, `reject`, `publish_now`, `reschedule`, `send`, `call`. Правила:
  - `approve`, `reject`: пока `pending`. `edit`: пока `pending` и у вида есть текст для замены (`content_item`; `lead_reply`, `lead_price`, `support_answer`, `support_money`, `bo_document`, `billing_invoice`, `billing_reminder`, `onboarding_guide`, `pm_spec`, `pm_client_status`, `prospect_*`, `audit`). Нет у `article`, `content_pack`, `referral_*`, `seo_proposal`. У `presales_pack` `edit` есть всегда (с полем `doc`, см. ниже). После одобрения `edit` остаётся (новая версия, клиент видит последнюю) у `presales_pack` (КП и смета, пока клиент не принял КП) и `bo_document` (пока клиент не подписал); тогда `approve`/`reject` уже недоступны, а `edit` не требует `pending`.
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
  - `presales_pack`: `pack` (`{ id, documentIds, direction, totalUsd, prepayUsd, prepayPercent, stages, timeline }`; `documentIds`: числа `ps_documents.id` документов пакета по порядку КП, смета, договор, без `null`; сайт сопоставляет ими свои строки документов точно, а не по виду и имени клиента; у флагманов добавлены `pilot` (булево: в КП есть блок «пилот») и `monthlyUsd`). `support_*`: `ticket` (`{ id, clientName, contact, status, money, question, createdAt, answeredAt }` или `null`). `billing_*`: `invoice` (`{ id, number, client, amountUsd, dueDate, status, what, leadId, projectId }`). `bo_document`: `document` (`{ id, type, client, version, projectId }`). `referral_*`: `referral` (`{ id, referrer, referred, status, reward }`). `pm_*`: `project` (`{ id, client, status }`). `onboarding_guide`: `client` (`{ id: null, email: null, cabinet: false, name }`), `onboarding: { id }`. `prospect_*`: `prospect` (`{ id, name, niche, city, telegram, instagram }`), `draftKind` (`first|followup|reply`). `seo_proposal`: `seo: { key, page, needsBuilder }`. `audit`: `audit: { id, host, locale }`. Если строки в базе уже нет, в объекте остаётся только `{ id }`.
- Пакет недели: карточка `content_pack` это отдельный элемент (действия `approve`, `reject`), а каждый её материал отдельный элемент `content_item` с `meta.heldByPack`. `approve` материала решает только его (у него появляется своя строка одобрения без Telegram-карточки), карточка пакета остаётся и дальше одобряет остальные. `approve` или `reject` пакета решает оставшиеся.

## POST /admin/review/:id
`:id` вида `ap_<номер>`. Тело `{ "action": "approve|edit|revise|reject|publish_now|reschedule|send|call", "text"?: {...} | "строка" (= {draft}), "doc"?: "kp|estimate|contract" (только `presales_pack`), "pilot"?: boolean (только `presales_pack` флагмана, см. ниже), "note"?: string (1..4000), "slot"?: string (до 40), "platform"?: "instagram|tiktok|shorts|youtube" }`, лишние поля запрещены. `youtube` это `shorts`. Ответ `{ ok: true, item }` (элемент как в списке, уже после действия) плюс поля действия. Порядок проверок: 404 `not_found` (id не такого вида или нет), 400 `invalid` + `allowed` (плохое тело), затем повторы и состояния, затем действие.
- Повтор того же решения безопасен (`approve` уже одобренного или опубликованного, `reject` уже отклонённого дают `{ ok: true, item }`, в журнале решений второй записи нет). Обратное решение: 409 `already_decided` + `status`. `edit`, `revise`, `send` не у `pending`: 409 `not_pending` + `status`; так же `approve`/`reject` у `failed`. Действие, которого нет в `actions` элемента: 409 `not_applicable` + `status` + `actions` (список допустимых сейчас). `approve` карточки с шаблоном в тексте или устаревшей карточки счёта: 409 `placeholder` (+ `placeholders`) или `not_ready` (+ `reason`), одобрение остаётся `pending`.
- `approve`, `reject`: решение ядра, как нажатие кнопки. Предложение, которое ещё не уходило карточкой (лежит в пачке, под пакетом), получает строку одобрения без карточки. `reject` с `note` у `content_item` сохраняет замечание комментарием материала. Если выполнение одобренного упало: `200 { ok: false, error: "failed", status: "failed", item }`.
- `edit`: владелец заменил текст сам (в Telegram это «Править»), тело `text` обязательно (иначе 400 `invalid`). Одобрение остаётся `pending`, счётчик чистых одобрений сбрасывается, в журнале решений запись `edit`, Telegram-карточка показывает новый текст с кнопками, нового сообщения владельцу не приходит. Создаётся версия `v+1` (`note: "владелец"`, с `note` в теле: `"владелец: <note>"`). Что можно передать в `text` (ключи строгие, лишний: 400 `invalid`):
  - `content_item`: `draft` (весь текст сразу), `body` (сценарий или слайды: только эта часть), `captions` (`{ instagram?, tiktok?, shorts? }`: подпись площадки целиком), `caption` и `hashtags` (подпись и хештеги Instagram: собираются обратно в `captions.instagram`). Можно несколько ключей сразу. Метки площадок HQ расставляет сам. Такой части у материала нет, текст пустой или не изменился: 409 `not_applied` + `reason`.
  - остальные виды: `draft` (или `body`), непустая строка до 8000; не изменился: 409 `not_applied`. `text` можно передать и просто строкой (то же, что `{ "draft": "..." }`).
  - `presales_pack` флагманов (2026-11-22). Направления пакета `personal` («Персональный ИИ») и `company` («ИИ-компания»); `agent` старое имя `personal` (старые пакеты и заявки с `direction: "agent"` читаются как `personal`). **Персональный ИИ**: цена пакета это план уровня сборки (`basic` $290 + $29/мес, `plus` $490 + $49/мес, `max` $790 + $79/мес, всё из `personalPlans` прайса), один этап «Настройка» 100% (как у подписок), ежемесячная плата вперёд. **ИИ-компания**: план `companyPlan` («от», точная сумма по смете), четыре этапа по 25% («Карта компании и Директор», «Первые отделы на ваших данных», «Пульт, база знаний и каналы», «Обучение команды и запуск») и ежемесячный платёж; в КП под таблицей цен пояснение «точную сумму фиксируем в Смете до подписания договора», в договоре цена названа суммой по Смете. Суммы только из `GET /api/prices`. **Пилот**: в КП флагмана необязательный блок «## Пилот» («первый пилот бесплатно, в обмен на ваш кейс и отзыв; условия записываем до начала работ, объём пилота определяет Fir Tech»); поле пакета `pilot: true` (задача `presales` с `meta.pilot: true`) кладёт блок сразу, а владелец включает и выключает его в ревью-центре: `POST /admin/review/:id` `{ "action": "edit", "pilot": true|false }` без `text` и `doc` (только `presales_pack` флагмана, иначе 409 `not_applicable`; блок уже есть или его нет: 409 `not_applied`; меняет текст КП, `payload.pilot`, `ps_documents` и версию ревью, как обычная правка `doc: "kp"`). Автоматики у пилота нет: ни скидки в счёте, ни срока, это слова КП.
  - `presales_pack` (КП, смета, договор пакета; 2026-11-21): тело `{ "action": "edit", "doc": "kp"|"estimate"|"contract", "text": { "draft": "новый текст целиком" } }`. `doc` обязателен (иначе 400 `invalid`), правится один документ за раз. Пока карточка `pending`: меняются поле пакета (`payload.kp|estimate|contract`, которое одобрение потом использует) и сохранённый черновик в `ps_documents`, карточка остаётся `pending`, версия `v+1` (в `text.documents[]` и `text.body` уже новый текст), Telegram-карточка не дублируется. После `approve` (КП и смета у клиента в кабинете): тот же запрос меняет текст строки кабинета (`cab_documents`), заново рисует PDF (старая ссылка перестаёт быть последней), кладёт клиенту в тред строку «Документ обновлён», ревью-версия `v+1`, статус остаётся `approved`. Пока клиент не принял КП (строка `awaiting_client`); принял: 409 `not_pending` (в `actions` `edit` уже нет). `doc: "contract"` после одобрения: 409 `not_applicable` (договор тогда отдельный документ `bo_document`, правится его карточкой). Правка `contract` в `pending`-карточке (2026-11-22) помечает пакет (`payload.contractEdited: true`): после одобрения КП Бэк-офис составляет договор из этого текста (`meta.contractText` задачи `doc`, плейсхолдеры `{{...}}` заполняются как в шаблоне), а не из шаблона; без правки договора остаётся шаблон. Правки КП и сметы пометку не ставят.
  - `bo_document` после одобрения (договор или акт, пока клиент не подписал): `{ "action": "edit", "text": { "draft": "..." } }` создаёт НОВУЮ версию документа (`bo_documents`, `version`+1, `approved`), строка кабинета клиента следует за ней (текст, новый PDF, строка в треде), `meta.document` показывает новую версию, ревью-версия `v+1`. Подписан: `edit` пропадает из `actions`, запрос 409 `not_pending`. Неизменённый текст: 409 `not_applied`. Пока документ `pending`, правка идёт как у остальных видов (`draft`).
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

`GET /admin/chats/:id` → `{ ok, thread, messages: [ { id, at, from: "client"|"hq"|"owner", channel: "web"|"telegram"|"cabinet", thread: "lead"|"support"|"project-<id>", text, attachments: [] } ] }` (`thread` как строка списка, сообщения по возрастанию времени). Неизвестный 404. `id` сообщения: `cab_<n>` (кабинет), `lead_<n>` (первое обращение лида), `tk_<n>_q`/`tk_<n>_a` (вопрос и ответ тикета), `rp_<n>` (одобренный ответ на лид), `ow_<n>` (ответ владельца без кабинета), `tg_<n>` (слова клиента из @firtech_bot после «позвать человека», см. «Клиентский бот через HQ» ниже). Вложений HQ пока не хранит: `attachments` всегда `[]`. **`thread` сообщения (2026-11-22)**: тред кабинета, в который оно написано: `support` или `project-<id>` для сообщений `ct_<n>` (как они лежат в `cab_tmsgs`), `lead` для всего остального (`cab_<n>`, `lead_<n>`, тикеты, ответы на лид, Telegram, чат сайта, реплики владельца без кабинета). Тред агента (`agent-<id>`) в чатах владельца не показывается, поэтому значения `agent-*` здесь не бывает. Тред ответа по умолчанию это `thread` последнего сообщения клиента (`from: "client"`): так же выбирает его `POST .../reply` без `thread` и `replyTo`. Реплика владельца в треде клиента кабинета показывается с `channel: "cabinet"` (так она лежит в треде).

`POST /admin/chats/:id/unread` (без тела, 2026-11-22) → `{ ok: true, thread }` (`thread` как строка списка). Владелец помечает клиента непрочитанным снова: у треда, где все сообщения клиента уже отвечены, `unread` становится 1 (отметка в таблице `ch_unread`, хранится на псевдонимы треда); у треда, где непрочитанное уже есть, ничего не меняется; отметка исчезает, когда владелец или HQ отвечает в треде (последний ответ новее отметки). Новое сообщение клиента считается как обычно. Неизвестный `id` 404, другой метод 404.

`POST /admin/chats/:id/reply` тело `{ "text": 1..2000, "thread"?, "replyTo"? }` (лишние поля 400 `invalid`, неизвестный тред 404; поля `thread` и `replyTo` описаны ниже) → `{ ok: true, sent, via, message, thread }`. Владелец написал сам, поэтому **одобрения нет**: текст уходит на последний канал клиента (где он написал последним), если не вышло, на следующий адрес по порядку Telegram-бот (`chatId`), сайт (`sessionId`, текст ждёт следующего ответа чата), кабинет. `via`: `telegram|web|cabinet|none`, `sent` = `via != "none"`. Если у клиента есть кабинет и лид, ответ ВСЕГДА пишется в тред кабинета (`cab_messages`, автор `owner`), иначе он хранится в `ch_messages`. В журнал лида (комментарий задачи «Ответ владельца (канал): текст» и `activity` `chat_reply`) запись попадает всегда, с признаком доставки. Недоставленный ответ (сессия сайта исчезла, бот заблокирован, нет адреса) возвращается как `200 { ok: true, sent: false, via: "none" }` и остаётся в треде, сайт показывает «не доставлено, отправьте вручную». `message` строка треда (`from: "owner"`), `thread` обновлённая строка.
**Тред кабинета, в который ляжет ответ (2026-11-22).** `thread`: `lead` (тред заявки), `support` или `project-<id>` (`agent-*` нельзя, 400). `replyTo`: id сообщения, на которое отвечает владелец (`cab_<id>` из треда заявки, `ct_<id>` из проекта или поддержки). Если `thread` не прислан, ответ идёт в тред сообщения `replyTo`, а без него в тред, где клиент написал последним (сообщение, пришедшее из бота или чата сайта, считается тредом заявки). Один тред (или ни одного) работает как раньше: заявка, у клиента без заявки, но с сообщением в поддержке или проекте, ответ ложится туда (раньше терялся в `ch_messages`). Когда тредов несколько, а клиент нигде не писал и `replyTo` нет: `422 { ok: false, error: "thread_required", threads: ["lead","support",...] }`, ничего не сохранено, повторить с `thread`. Явный `thread` всегда выигрывает. Старый сайт без этих полей продолжает работать: он получает тред последнего сообщения клиента (раньше всегда тред заявки).

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

## Кабинет v3 (2026-11-22)
Решения владельца 2026-11-22: после заявки договор не выходит сразу; одобренное КП доходит до клиента; в договоре есть место подписи, клиент расписывается мышью (простая электронная подпись, без кода);
клиент видит «КП утверждено, договор подготовлен, счёт выставлен»; чат кабинета устроен по темам; профиль сохраняется; проект виден до оплаты; площадка агента (playground) для тех, кому не нужен сайт.
Финальный контракт для сайта (согласован с черновиком `cabinet-docs-contract.md`, отличия в конце раздела). Те же `x-admin-token`, loopback, общий лимит 6000 запросов за 10 минут и формат `{ ok, ... }` / `{ ok: false, error }`, что выше.
Код: `apps/hq/src/{cab-docs,cab-threads,playground,cabinet-api}.ts`, тесты: `tests/drill/cabinet-flow.test.ts`, `tests/drill/cabinet-chat.test.ts`, `tests/playground.test.ts`, `tests/cab-docs.test.ts`.
Ошибки по всему разделу: `invalid` (400), `unauthorized` (401, только публичный `/agent`), `not_live` и `origin` (403, только `/agent`), `not_found` (404: неизвестный клиент, и чужой документ, тред, файл или агент выглядят как отсутствующие),
`not_awaiting`, `limit` (409), `too_large` (413), `unsupported_type` (415), `bad_signature` (422), `rate_limited`, `limit_reached` (429), `unavailable` (503).

### 1. Поток (заменяет «одобренное КП: договор и счёт сразу»)
Действует для лида с аккаунтом кабинета (`li_leads.client_id`); лид из бота Telegram без аккаунта идёт по прежней цепочке (договор и счёт этапа 1 карточками сразу, владелец отправляет сам).
1. Заявка: договор и счёт НЕ создаются. Пресейл делает пакет (КП, смета, черновик договора внутри пакета); карточка пакета говорит, что «Утвердить» отправляет КП и смету клиенту.
2. Владелец одобряет пакет = отправка. Создаются документы клиента: `quote` (`awaiting_client`, номер `КП-<packId>`) и `other` «Смета» (`issued`), резервируется проект (`preparing`, этапы по КП), письмо клиенту (инструмент `email.send`, Resend; без ключа Resend письма нет, в журнале `doc_delivered` строка `journal`) и строка Fir Tech в треде заявки. В письме ссылка на кабинет `<SITE_URL>/<ru|en>/cabinet`, самого PDF нет.
3. Клиент «Принять КП» (`accept`): `quote` -> `accepted`, Бэк-офис получает задачу «Договор» (карточка `bo_document` владельцу, цепочка в тексте карточки: «КП → клиент принял → договор → клиент подписал → счёт этапа 1»), в тред строка «КП принято», владельцу строка во входящие.
4. Владелец одобряет договор (заполнив `[срок]`, как раньше) = отправка: `contract` (`awaiting_signature`), письмо, строка в треде; владельцу «утверждён и отправлен клиенту в кабинет и на почту» вместо «отправьте сами».
5. Клиент подписывает (`sign`): `contract` -> `signed`, подписанный PDF, запись в `bo_signatures`; Поддержка получает задачу «Счёт этапа 1» (карточка `billing_invoice` владельцу).
6. Владелец одобряет счёт = отправка: `invoice` (`issued`, `payUrl`), письмо, строка в треде; проект остаётся `preparing`.
7. Оплата (`/paid`, сторож блокчейна, `mark_paid` Пульта): документ `paid`, строка в треде, проект `in_progress`, дальше цепочка этапов как раньше (ТЗ, приёмка, счёт следующего этапа).
Правила: ничего не уходит клиенту до одобрения владельца (одобрение и есть отправка); каждый шаг один раз (повторный `accept` и `sign` дают 409, повторное одобрение документа ничего не дублирует); письмо не обязательно, без Resend или при его ошибке поток идёт дальше (тред и документы на месте).
Воронка Пульта: стадия `contract` у такого лида наступает, когда договор дошёл до клиента, а не когда одобрен пакет (черновик договора внутри пакета больше не считается).

### 2. Документы
`GET /admin/clients/:id/documents` → `{ ok, items }`, новые сверху (по `id`), без страниц. Строка:
```json
{ "id": 7, "kind": "contract", "title": "Договор оказания услуг", "number": "2026-3", "leadId": 12, "projectId": 4, "state": "awaiting_signature",
  "createdAt": "...", "deliveredAt": "...", "acceptedAt": null, "signedAt": null, "pdfUrl": "https://hq.firtech.pro/media/<sig>/cabinet/c1/contract-7.pdf?e=1795000000",
  "amountUsd": 660, "stageNo": 1, "payUrl": "https://firtech.pro/ru/pay/FT-2026-001?k=..." }
```
- `kind`: `quote` (КП), `contract`, `invoice`, `act`, `other` (смета «Смета»). `number`: `КП-<пакет>`, номер из текста договора, номер счёта `FT-...`, иначе `null`. `leadId`, `projectId`: числа или `null`. `htmlUrl` не отдаётся (только PDF).
- `state` по видам: `quote` `awaiting_client` -> `accepted`; `contract` `awaiting_signature` -> `signed`; `invoice` `issued` -> `paid` или `void` (состояние читается из счёта при каждом запросе, оплата и аннулирование видны сразу); `act` и `other` `issued`. `acceptedAt` и `signedAt` `null`, пока шага не было; `deliveredAt` время отправки клиенту.
- `amountUsd` (у `quote`, `other`, `invoice`) и `stageNo` (у счёта этапа) есть только когда известны. `payUrl` только у `invoice` в `issued` (ссылка страницы оплаты `GET /pay/...`).
- `pdfUrl`: подписанная ссылка `/media/<sig>/<путь>?e=<unix-секунды>` на 7 дней с момента запроса (подпись покрывает срок, ссылка без `?e=` или с чужим `e` даёт 404, просроченная 404), собирается заново при каждом чтении; после подписания договора это подписанный экземпляр. `null`, если PDF не удалось собрать (нет шрифтов или папки) или не задан `IG_PUBLIC_BASE`/`MEDIA_SECRET`. Файл лежит в `DATA_DIR/renders/cabinet/c<клиент>/`.
`POST /admin/clients/:id/documents/:docId/accept` (только `quote`) → 200 `{ ok: true, next: "contract" }`; 404 `not_found` (чужой или неизвестный документ); 409 `not_awaiting` (`state` в ответе: уже принят, не КП).
`POST /admin/clients/:id/documents/:docId/sign` тело `{ signaturePng, name, consent: true, ip?, userAgent? }`: `signaturePng` data URL `data:image/png;base64,...` не больше 200 КБ (204 800 знаков), `name` 2..120, `consent` строго `true`, `ip` до 64 и `userAgent` до 300 знаков (сайт передаёт IP и браузер клиента).
Порядок проверок: 404 `not_found`, 400 `invalid` (форма тела, `consent` не `true`, короткое имя), 409 `not_awaiting` (не договор или он не в `awaiting_signature`, в ответе `state`), 422 `bad_signature` с `reason`: `not_png` (не data URL PNG или битый PNG), `too_large` (больше 200 КБ), `bad_size` (меньше 20x10 или больше 4000x2000), `blank` (ничего не нарисовано: прозрачный или сплошной холст).
Успех: `{ ok: true, pdfUrl }` (`pdfUrl` подписанного экземпляра или `null`, если PDF не собрался; подпись при этом записана). Подписание одно, повтор 409. Тело маршрута `sign` может быть до 330 КБ (у остальных маршрутов `/admin/*` 16 КБ).
Что хранится (`bo_signatures`): `doc_id`, `signature_png`, `name`, `at`, `ip`, `ua`, `sha256` (контрольная сумма PDF договора, который клиент видел до подписи; если PDF не собирался, сумма текста договора). PDF подписанного: в блоке «Заказчик» нарисованная подпись, имя, «Простая электронная подпись в кабинете firtech.pro», дата и время; в блоке «Исполнитель» «Fir Tech», hello@firtech.pro и та же дата. Неподписанный PDF договора тоже с двумя блоками (у заказчика пустая линия).
Текст договора (`packages/workers/documents/templates/contract.md`, раздел 10; краткая копия в черновике пакета Пресейла) содержит пункт о простой электронной подписи и блок «Подписи сторон». Тот же абзац нужен в условиях на сайте (на стороне сайта).
Доставка: одобрение владельцем КП, договора (и акта) и счёта пишет строку документа, шлёт письмо клиенту (тема `Ваше коммерческое предложение Fir Tech`, `Договор Fir Tech готов к подписанию`, `Счёт <номер> от Fir Tech`; на английском для клиентов `en`) и добавляет строку Fir Tech в тред заявки (в тред поддержки, если у документа нет заявки). Журнал HQ: `doc_delivered` с `email`, `journal` или `email_failed:<код>`, без текстов.

### 3. Проекты и заявки
`GET /admin/clients/by-email`: каждый проект получает `state` (`preparing` пока не оплачен этап 1, затем `in_progress`; `paused`; `done`), `documents` (id документов проекта и его заявки), `nextAction`, остальное как раньше (`milestones[]` без изменений). Проект существует с одобрения КП (резервируется там, не после оплаты), этапы видны сразу.
`nextAction` (клиентское «что делать дальше», один объект): `{ kind: "accept_quote" | "sign_contract" | "pay_stage" | "accept_stage" | "wait", docId?, stageNo?, payUrl? }`. Порядок: КП на принятие (`docId`), договор на подпись (`docId`), этап к оплате (`stageNo`, `payUrl`, `docId` счёта, когда он выставлен), готовый этап к приёмке (`stageNo`), иначе `wait`.
`leads[]`: появилось поле `nextAction` (тот же словарь), `nextStep` остаётся предложением на языке лида и для заявки с КП в кабинете говорит то же: «Прочитайте КП в разделе «Документы» и нажмите «Принять КП»», «КП принято, готовим договор», «Подпишите договор в разделе «Документы»», «Договор подписан, готовим счёт на первый этап», дальше «Оплатите этап N...» и «Примите этап N...» как раньше. `timeline[]` для такой заявки идёт по документам клиента: `kp` (отправлено), `kp_accepted` («КП принято вами»), `contract` (договор отправлен), `contract_signed` («Договор подписан»), затем `invoice`, `paid`; черновик договора внутри пакета и договор на согласовании у владельца событиями клиента не являются.
`documents[]` в `by-email` (прежние виды из `ps_documents` и `bo_documents`) не повторяет бумаги заявки, которая идёт через кабинет; новые документы только в `GET .../documents`. `client` в `by-email` получил `phone`, `company`, `locale`.
Пульт: `GET /admin/crm/projects` и `GET /admin/crm/projects/:id` отдают те же `state`, `documents`, `nextAction` (в `item`); строка счёта `GET /admin/crm/invoices` получила `documentId` (документ клиента или `null`). Пульт-заявка (`/admin/crm/leads`) оставила `nextAction` строкой для владельца как была.
Кабинет показывает статус ПРОЕКТА клиента, а не офис Fir Tech: `state`, `milestones`, `nextAction`.

### 4. Чат кабинета (треды)
Тред это тема переписки: `lead-<id заявки>`, `project-<id проекта>`, `support` (всегда один), `agent-<id агента>`. Старые сообщения `cab_messages` НЕ переносились: они и есть тред заявки (в таблицу добавлена колонка `attachments`); остальные треды в таблице `cab_tmsgs`.
`GET /admin/clients/:id/threads` → `{ ok, items: [{ id, kind: "lead"|"project"|"agent"|"support", refId, title, unread, lastAt }] }`: `refId` число или `null` (support), `title` на языке клиента («Заявка #12: ...», «Проект #4: ...», «Поддержка», имя агента), `unread` число сообщений от Fir Tech или агента после последней отметки прочтения, `lastAt` ISO или `null`; новая активность сверху.
`GET /admin/clients/:id/threads/:tid/messages?after=<id>` → `{ ok, items: [{ id, at, from: "client"|"firtech"|"agent", text, attachments: [{ name, url, size }], readAt }] }`, по возрастанию, до 200; `after` целое (иначе 400 `invalid`), `id` числовые внутри треда. `from: "firtech"` это ответы владельца, головы продаж, Поддержки и строки о документах и оплате. `readAt`: у сообщений Fir Tech и агента время отметки прочтения клиентом, если она не раньше сообщения, иначе `null`; у сообщений клиента всегда `null`. `attachments[].url`: подписанная ссылка на 7 дней (`null` без `MEDIA_SECRET` и `IG_PUBLIC_BASE`).
`POST /admin/clients/:id/threads/:tid/messages` тело `{ text, attachments? }`: `text` до 2000 знаков после обрезки (может быть пустым, только если есть вложения, тогда сохраняется «(вложение)»), `attachments` до 5 id файлов (`"<id>"` или `{ "uploadId": "<id>" }`), файл должен быть этого клиента (иначе 400 `invalid` с `reason: "attachment"`). Ответ `{ ok, item, ticketId }` (`item` как сообщение выше с `from: "client"`); для треда агента `{ ok, item, reply }` (`reply` сообщение с `from: "agent"`).
Маршрутизация: `lead`, `project`, `support`: сообщение становится обращением Поддержки (`cs_tickets`, `source: "cabinet"`; для заявки `lead_id`, для проекта и поддержки колонка `thread`, текст проекта с пометкой «[по проекту #N]»), владельцу строка во входящие без текста («Сообщение по заявке #N / по проекту #N / в поддержку от <имя>»), в журнал задачи заявки строка (для `lead`), голова Поддержки делает черновик ответа (карточка `support_answer`), одобренный ответ дописывается в ТОТ ЖЕ тред как `firtech`, один раз на обращение. Всё это видно владельцу в `GET /admin/chats` одним тредом клиента; `POST /admin/chats/:id/reply` принимает необязательные `thread` (`lead`, `support`, `project-<id>`) и `replyTo` (id сообщения); без них тред выводится из последнего сообщения клиента, `422 thread_required` только если вывести нечего (раздел «GET /admin/chats и ответы клиентам»). `agent`: отвечает агент клиента через шлюз (§5), без Поддержки и без владельца.
Лимиты: 20 сообщений клиента в час на `lead`, `project`, `support` вместе (иначе 429 `rate_limited`); тред агента без часового лимита, действует суточный лимит агента (429 `limit_reached`, `item` в ответе). Прежний `POST /admin/clients/:id/leads/:leadId/messages` работает как был (10 в час).
`POST /admin/clients/:id/threads/:tid/read` → `{ ok, unread: 0 }`: всё в треде прочитано сейчас.
Чужой, неизвестный или с кривым `tid` тред 404 `not_found`.
Файлы: `POST /admin/clients/:id/uploads` тело `{ name, dataBase64 }` (JSON, не multipart: сайт читает файл и пересылает) → `{ ok, item: { id, name, type, size, url } }`. Допустимые расширения: png, jpg, jpeg, webp, pdf, docx, zip, txt, md, csv (txt, md, csv нужны для базы знаний агента); содержимое проверяется по первым байтам (PNG, JPEG, WEBP, `%PDF-`, `PK\x03\x04` для docx и zip, текст как UTF-8 без нулевых байтов), поэтому переименованный исполняемый файл не пройдёт; исполняемые файлы, html, svg, скрипты не допускаются. Антивирусной проверки нет, только список типов и сверка содержимого. До 10 МБ (после раскодирования), 30 файлов в час на клиента. Ошибки: 400 `invalid`, 404, 413 `too_large` (`maxBytes`), 415 `unsupported_type` (`allowed` или `reason: "content_mismatch"`), 429 `rate_limited`. Тело маршрута может быть до 14 МБ.
Хранение: `DATA_DIR/uploads/<id клиента>/<id>.<расширение>`; скачивание по подписанной ссылке `<IG_PUBLIC_BASE>/<sig>/uploads/<клиент>/<файл>?e=<unix-секунды>` на 7 дней (HEAD и GET, 404 при чужой подписи, ином `e` или истёкшем сроке); Word, zip и текст отдаются с `content-disposition: attachment`, всё с `x-content-type-options: nosniff`.

### 5. Площадка агента (playground)
Агент клиента: экземпляр с персоной из ответов конструктора лида. Таблицы `pg_agents`, `pg_knowledge`, `pg_conversations`, `pg_messages`, `pg_journal`, `pg_leads`, `pg_bookings`. До трёх агентов на клиента (4-й 409 `limit`, `max: 3`).
Строка агента: `{ id, publicId, name, company, niche, goals[], tone, languages[], persona, tools[], channels: { web: true, telegram: { connected }, siteWidget: "<origin>"|null }, limits: { msgsPerDay }, state: "draft"|"live", mode: "demo"|"live", usageToday: { messages }, leadId, projectId, chatPath: "/agent/<publicId>/chat", createdAt, updatedAt }`. Токена и Telegram-токена в строке нет.
`POST /admin/clients/:id/agents` тело `{ leadId?, projectId?, name?, company?, niche?, goals?, tone?, languages?, tools? }`: с `leadId` (своя заявка клиента, иначе 404) персона строится из ответов конструктора в `estimate` и тексте заявки: строки вида «Ниша: ...», «Цели: a; b», «Тон: ...», «Компания: ...», «Языки: ru, en» (ниша ещё ищется по словам заявки среди салон, клиника, магазин, кафе, сервис, курсы), остальное берётся из колонок лида; поля тела перекрывают. Без `leadId` нужны `company` или `niche`. Ответ `{ ok, item, token }`; `token` (`ft_...`) показывается ОДИН раз, в базе хранится только его sha256. `tools`: любые из `faq_search`, `booking_slots`, `book_slot`, `capture_lead`, `handoff_human` (по умолчанию все пять). Новый агент `draft`. Ошибки 400, 404, 409 `limit`.
`GET /admin/clients/:id/agents` → `{ ok, items }`; `GET .../agents/:aid` → `{ ok, item }`.
`PATCH .../agents/:aid` (и `POST` на тот же путь; `PATCH` принимает только этот маршрут, остальные `/admin/*` только GET и POST, иначе 405) тело, только перечисленные ключи (другие 400): `name`, `company`, `niche`, `goals` (до 6), `tone`, `languages` (1..4 кода по 2..8 знаков), `persona` (20..6000; без него смена полей профиля пересобирает персону), `tools`, `state` (`draft`|`live`), `limits: { msgsPerDay: 1..2000 }`, `channels: { telegram: { botToken } | null, siteWidget: "http(s)://хост[:порт]" | null }`. По умолчанию суточный лимит 50 сообщений пока `draft` и 500 когда `live`, пока владелец не задал свой. Telegram-токен хранится зашифрованным (AES-256-GCM, ключ `PG_SECRET`, иначе `MEDIA_SECRET`; без ключа 503 `unavailable`) и наружу не отдаётся; запускать Telegram-канал агента HQ пока не умеет (токен только сохраняется). Ответ `{ ok, item }`.
`POST .../agents/:aid/token` → `{ ok, item, token }`: новый токен, старый перестаёт работать сразу.
`POST .../agents/:aid/chat` тело `{ conversationId?, text }` (`text` 1..1000, `conversationId` 8..64 знаков `[A-Za-z0-9_-]`, по умолчанию `cab-<клиент>-<агент>`) → `{ ok, reply, conversationId, usedTools }`. Через шлюз LLM (`client-bot` в учёте расходов), память разговора: последние 12 реплик ЭТОГО разговора, другого разговора агент не помнит; разговоры старше 30 дней стираются. Модель отвечает JSON `{ reply, tool? }`, до трёх вызовов инструментов подряд. Без модели или при мусоре: ответ из базы знаний, иначе вежливая передача менеджеру (и `handoff_human`), выдуманных ответов нет. Суточный лимит: сверх лимита 429 `limit_reached`.
Инструменты: `faq_search` (поиск по базе знаний агента), `booking_slots` (ЗАГЛУШКА: 12 фиксированных окон на ближайшие три дня, 10:00, 12:00, 15:00, 17:00 по часовому поясу компании, в ответе `stub: true`), `book_slot` (заявка на окно из показанных, в календарь ничего не пишется), `capture_lead` (контакт посетителя в `pg_leads` и сообщение `from: "agent"` в тред агента; владельцу только строка «собран новый контакт» без данных), `handoff_human` (сообщение в тред поддержки клиента и обращение Поддержки).
`GET .../agents/:aid/conversations` → `{ items: [{ id, channel: "cabinet"|"widget", startedAt, lastAt, messages, leadsCaptured }] }`; `GET .../journal` → `{ items: [{ day, counts }] }` (до 14 дней; счётчики `message`, `limit_hit`, `llm_fail`, `lead_captured`, `booking`, `handoff`, `tool:<имя>`; ТЕКСТОВ нет); `GET .../leads` → `{ items: [{ id, conversationId, name, contact, note, at }] }`.
База знаний: `GET .../agents/:aid/knowledge` → `{ items: [{ id, title, size, createdAt }] }`; `POST .../knowledge` тело `{ title?, text? | uploadId? }` (`text` до 8000; `uploadId` текстовый файл txt, md или csv этого клиента из `POST .../uploads`; иначе 400) → `{ ok, item }`, до 100 записей на агента (409 `limit`); `POST .../knowledge/:kid/delete` → `{ ok }`.
Публичные маршруты (без `x-admin-token`, на порту webhook; nginx должен проксировать `/agent/` на `127.0.0.1:8787` так же, как `/media/`; описаны и в `docs/public-api.md`):
- `POST /agent/:publicId/chat`, заголовок `x-agent-token` (токен агента), тело `{ text, conversationId? }` (до 8 КБ) → `{ ok, reply, conversationId, usedTools }`; без `conversationId` выдаётся `w-...`. Только для `live`. Ошибки: 401 `unauthorized` (агента нет или токен не тот, одинаково), 403 `not_live`, 403 `origin` (заголовок `Origin` есть и не равен `channels.siteWidget`, если он задан; запрос без `Origin`, не из браузера, не проверяется), 400 `invalid`, 429 `rate_limited` (20 в минуту и 300 в сутки с одного IP) или `limit_reached` (суточный лимит агента), 503 `unavailable`. CORS: `access-control-allow-origin` равен origin клиента из `siteWidget`; `OPTIONS` отвечает 204.
- `POST /agent/demo-<ниша>/chat`, ниши `salon`, `clinic`, `shop`, `cafe`, `service`, `courses` (салон, клиника, магазин, кафе, сервис, курсы), тело `{ sessionId, text }` (`sessionId` 8..64 `[A-Za-z0-9_-]`, `text` 1..500) → `{ ok, reply, conversationId: <sessionId>, usedTools }`. Для превью конструктора на сайте: токена нет, CORS `*`, память только внутри сессии браузера (в памяти процесса 20 минут, не больше 12 обменов, потом 429 `session_limit`), между сессиями ничего не помнит, в базу ничего не пишется (кроме суточного счётчика в `settings`). Неизвестная ниша 404. Лимит по IP тот же, что выше.

**Агент создаётся сам (2026-11-22).** Когда клиент ПРИНЯЛ КП (`POST .../documents/:docId/accept`), а сборка лида называет площадку (в ссылке конструктора, которую HQ находит в `estimate` или тексте лида, кусок `l.` содержит `playground`; либо направление КП `agent` и кусок `z.` равен `no`, то есть сайт не нужен), HQ сразу создаёт строку `pg_agents` клиента: персона из ниши и ответов лида (как `POST .../agents` с `leadId`), `state: "draft"` = режим `mode: "demo"` (в строке оба поля; лимит демо 50 сообщений в сутки, публичный маршрут `/agent/:id/chat` закрыт `not_live`, токен не показывается, новый выдаёт `POST .../token`). Во вкладке «Ваш агент» он появляется сразу, в треде `agent-<id>` строка «Ваш агент готов в демо-режиме…» (что можно делать сейчас, и что рабочий режим включится после оплаты первого этапа). Оплата первого счёта (этап 1, или счёт вне плана этапов) переводит агентов этой заявки в `state: "live"` (`mode: "live"`, лимит 500, без демо-ограничений) и пишет вторую строку в тред агента. Один раз: повторное принятие или оплата ничего не меняет, больше одного агента на заявку автоматически не создаётся; ручной `POST .../agents` работает как раньше. В Пульт (`GET /admin/hub`, `inbox`, `kind: "info"`, `dept: "production"`, `link: "clients:<id>"`) попадают два события: «Агент «…» клиента … создан в демо-режиме (КП принято)» и «… включён в рабочий режим (оплачен этап 1)», плюс обычная строка владельцу; в журнале `activity`: `agent_auto_created`, `agent_live`. Разбор ссылки: `apps/hq/src/builder-plan.ts` (`parseBuilderPlan`, `wantsPlayground`).

### 6. Профиль
`POST /admin/clients/:id` (на `PATCH` отвечает 405) тело `{ name?, telegram?, phone?, company?, locale? }`: меняются только присланные поля (пустая строка очищает), `name`, `telegram`, `company` до 120, `phone` до 40, `locale` `ru|en` (иначе 400 `invalid`); неизвестный клиент 404. Ответ `{ ok, client: { id, email, name, telegram, phone, company, locale } }`. Смена `telegram` довязывает лиды с этим ником, как регистрация. `POST /admin/clients` (регистрация) по-прежнему upsert по email и перезаписывает `name`, `telegram`, `locale`: профильную форму сайта нужно слать на `POST /admin/clients/:id`, а не на регистрацию.
Сайт: если форма всё равно не сохраняется, причина на стороне сайта (серверное действие, таблица `profiles` и её RLS), HQ-часть проверена тестом `tests/drill/cabinet-chat.test.ts`.

### Отличия от черновика
- Ответы списков в конверте `{ ok, items }` (в черновике голые массивы). Тред `id` строкой `lead-12`, `project-4`, `support`, `agent-5`.
- Вложения: JSON с `dataBase64` и отдельный `POST .../uploads` (id файла кладётся в сообщение), не multipart и не подписанный URL загрузки; скачивание по подписанной ссылке на 7 дней.
- `htmlUrl` документа не реализован. Документ `other` «Смета» добавлен к КП (в черновике его не было).
- Проект резервируется при одобрении КП (а не при принятии клиентом), чтобы клиент видел «Готовим договор» и кнопку «Принять КП» в карточке проекта; состояние `preparing` до оплаты этапа 1.
- Уточняющие вопросы перед КП сделаны 2026-11-22, раздел «Уточняющие вопросы перед КП» ниже.
- Telegram-канал агента: токен хранится зашифрованным, но запуск канала не сделан. Бронирование в агенте заглушка.
- Права: `PATCH` только на `/admin/clients/:id/agents/:aid`.


## Клиент видит каждый шаг цепочки (2026-11-22)
Для проекта клиента с кабинетом (заявка привязана к аккаунту) HQ сам пишет в его тред проекта `project-<id>` (строка `from: "firtech"`, флаг непрочитанного вкладки «Проекты» и тред поднимаются сами) и шлёт письмо через `email.send`, если Resend настроен (ссылка на кабинет, без файлов; сбой письма пишется в журнал `activity`: `stage_ready_notified`, `stage_accepted_notified`, `project_closed_notified` с итогом `email`, `email_failed:<причина>` или `journal`):
- **Этап готов** (веха этапа закрыта, `awaiting_acceptance`): «Этап N «…» готов к приёмке: откройте вкладку «Проекты» и нажмите «Принять этап».», письмо «Этап N готов к приёмке».
- **Этап принят** (клиентом или владельцем `/mdone`), есть следующий: «Этап N принят. Следующий этап: M «…». Счёт на него готовим, он придёт в раздел «Документы» и на почту.» Счёт этапа M только ПРЕДЛАГАЕТСЯ владельцу, поэтому строка обещает его, а не сообщает, что он выставлен; когда владелец одобрит, клиент получает обычную строку «Счёт … выставлен» и письмо.
- **Последний этап принят**: «Этап N принят. Проект завершён, спасибо! Акт сдачи-приёмки в разделе «Документы».», письмо «Проект завершён», проект `done`. Документ `act` («Акт сдачи-приёмки», номер `АКТ-<id проекта>`, `state: "issued"`, `acceptedAt` = момент приёмки) строится из шаблона акта по этапам и суммам проекта, PDF как у остальных документов; владельцу его одобрять не нужно (клиент сам принял последний этап), ручной `/doc акт` для того же проекта второго акта не создаёт, а в тексте закрытия проекта владельцу вместо «/doc акт» написано, что акт уже у клиента.
Проект без кабинета ничего клиенту не шлёт (владелец пишет сам, как раньше).

### Лиды без кабинета (бот Telegram, старая цепочка)
Документы такого лида владелец отправляет сам. К тексту, который он пересылает (КП по кнопке «Скопировать документы», утверждённые договор и счёт), HQ дописывает строку со ссылкой `/<язык>/cabinet/login?email=<почта из контакта лида>` и просьбой зарегистрироваться с той же почтой (контакт не почта: ссылка без `email`). Когда аккаунт появился (`POST /admin/clients`, `GET /admin/clients/by-email`, `GET /admin/clients/:id/documents`), лид привязывается по почте или нику, а уже утверждённые бумаги лида (КП и смета `ps_documents`, договор и акт `bo_documents`, выставленные и оплаченные счета `bl_invoices`) добавляются к его документам кабинета со статусом `issued` (принимать и подписывать нечего, у счёта живое состояние и `payUrl`); повторно не добавляются, лид, чьё КП шло через кабинет, не трогается. Письма клиенту при этом нет (аккаунта не было, когда бумаги уходили).

## Уточняющие вопросы перед КП (2026-11-22)
Лид с аккаунтом кабинета (`li_leads.client_id`) приходит с пробелами: нет услуги (`unknown|other` без выбранного продукта), нет ниши, нет цели (в словах заявки и сметы нет ни заявок, ни записи, ни клиентов, ни рутины), нет канала. **Блокируют КП**: неясный состав работ, либо одновременно нет ни ниши, ни цели; нехватка только канала лид не задерживает. Для такого лида голова продаж задаёт один раунд из не более трёх вопросов (порядок: состав, ниша, цель, канал) и КП не предлагает:
- вопросы идут в тред заявки кабинета (`cab_messages`, `from: manager`, виден в `by-email.leads[].replies` и `/admin/chats`) и письмом через `email.send` (Resend), если ключ настроен; сбой письма пишется в журнал `clarify_sent`, тред остаётся;
- владелец видит их в ревью-центре как элемент `lead_reply` уровня 1: `meta.clarify = { questions: [...], sent: true }`, одобрение не нужно (`status` не `pending`), карточка считается в обычных счётчиках отдела продаж; при уровне доверия 0 вопросы ждут одобрения как любой `lead_reply`;
- ответом считаются сообщения клиента в этом треде после вопросов (`POST /admin/clients/:id/leads/:leadId/messages`, `POST /admin/clients/:id/threads/lead-<leadId>/messages`): они дописываются в `li_leads.task` («Уточнения клиента: ...»), ниша определяется по ним, голова ставит задачу `kp` (`meta.clarified = "answers"`);
- без ответа через 24 часа задача `kp` ставится с `meta.assumptions` (по пункту на каждый неотвеченный вопрос), в КП и смету (не в договор) добавляется блок «Допущения (клиент не ответил на уточняющие вопросы, подтвердим их до договора)»; владелец получает строку в топике продаж;
- один раунд на лид (`li_clarify`, `status`: `asked|answered|assumed`); проверка идёт на каждом пульсе головы и каждые 30 секунд в приложении (`SalesHead.clarifyTick`).
Лид без аккаунта (форма не вошедшего, бот Telegram) идёт прежним путём; `lead_reply` с `payload.clarify = true` доставляется в тред и письмом, владельцу «отправьте клиенту» не присылается.

## Поручения: история Директора (2026-11-22)
`GET /admin/director/history?limit=1..200` (по умолчанию 50, иначе 400 `invalid`) → `{ ok, items: [ { id, at, role: "owner"|"command"|"hq", text, taskId: number|null } ] }`, **новейшая последней** (последние `limit` строк по возрастанию `id`). Строки пишут существующие пути сайта: `POST /admin/say` (`owner` с текстом владельца, затем по строке `hq` на каждый ответ Директора из `replies`) и `POST /admin/command` (`command` как `/<имя> <аргумент>`, затем ответы `hq`); `taskId` у строк `hq`: задача владельца, которую создала эта реплика (как поле `taskId` ответа `say`/`command`), иначе `null`. Текст до 4000 знаков, хранится 2000 последних строк (таблица `director_history` в базе HQ). Реплики из Telegram сюда не попадают (только путь сайта).

## КП по смете конструктора (2026-11-22)
Лид несёт смету конструктора: ресепшн и конструктор сайта присылают несколько продуктов, а Пресейл раньше считал одно направление (`guessDirection`). Теперь цена КП это смета клиента, источник истины: сайт считает её через `quote()` (`firtech/src/lib/{builder,pricing,estimate-doc}.ts`). Что читается (ссылка сборки, если она есть, главнее остальных; без неё смета JSON, затем текст):
1. **`estimate` как JSON** (контракт для конструктора сайта, строка до 1500 знаков, начинается с `{`): `{ "v": 1, "lines": [ { "label": "Сайты и лендинги: Сайт компании + Заявки в Telegram", "usd": 510 }, ... ], "discountUsd": 90, "totalUsd": 820, "monthlyUsd": 20, "onRequest": ["Контент на автопилоте"] }`. `lines` 1..30 строк (`usd` > 0), `discountUsd` необязательна, `totalUsd` должна равняться сумме строк минус скидка (иначе JSON не принимается), `monthlyUsd` поддержка по подписке (вне суммы), `onRequest` продукты «по смете» (вне суммы).
2. **`estimate` как текст конструктора** (`leadSummary` сайта, как он уходит сегодня, RU и EN): строки частей `Название: состав ($510, срок)`, допы `Название ($50)`, `Скидка 10% от двух частей проекта: $910 -> $820`, `Итого: $820`, `По смете, без цены: ...`, `Поддержка по подписке: $20/мес`. Читаются только строки до «Итого» (бриф после них слова клиента, деньги из него не берутся); сумма строк должна сходиться с «Итого» (и «до» скидки с «Итого»), иначе текст не принимается (обрезка, правка).
3. **Ссылка сборки** (`?b=` в `estimate`, в словах клиента, в `page` формы или в `enrichment.builderLink`): части и допы (`websites.company.telegram-cms`, `bots.booking`, `x.support-seo`) считаются по каталогу сайта (`getPrices()`, это кэш `GET /api/prices`, обновляется раз в 15 минут и по `POST /admin/prices/reload`) так же, как `quote()` сайта: вариант плюс допы, допы-экстра (`seo`, `design`, `rescue`, `crm`, `internal`) по `extraPrice`, скидка за набор `bundleDiscountPercent` (10 по умолчанию, `round10`) от двух строк, `support` отдельно в месяц; `p.` с продуктами без цены (`content`) идёт в `onRequest`; флагманы `personal` и `company` (2026-11-22) идут туда же строкой «по смете» с планом, в разовую сумму не входят: «Персональный ИИ (Почта, Календарь, Голос; Плюс: $490 + $49/мес)», «ИИ-компания (Продажи, Пульт; от $1 490 + $149/мес, точная сумма по смете)» (уровень Персонального ИИ: до двух сервисов `basic`, три-четыре или `voice` `plus`, пять и больше или `memory` `max`; без опций сервисы `mail`, `calendar`). Старый `p.agent` читается как `personal`.
Если есть и смета, и ссылка и они считают по-разному, ценой становится ссылка (её нельзя подделать, форма публичная), а в карточке КП строка «Внимание: в смете клиента $Y, по ссылке сборки $X, берём ссылку: сверьте состав». Смета (JSON или текст) цену задаёт, только когда ссылки нет совсем. Без сметы и ссылки считается как раньше (одно направление). Результат: строки КП и сметы это строки конструктора плюс строка `Скидка за набор` с минусом, `totalUsd` итог со скидкой, этапы по шаблону самой дорогой части (как `stagesFor` сайта), `what` и название в КП называют все части (`Сайт + ИИ-администратор`), в карточке «Цена взята из сметы конструктора (...)» и продукты по смете. `PricesPayload.bundleDiscountPercent` теперь читается из `GET /api/prices`.

## Деньги и документы: разрывы процессов (2026-11-22, аудит P-xx)
Добавлено веткой `process-gaps-money`. Всё новое необязательно для сайта: старые поля и маршруты не менялись, кроме отмеченных «меняется».

### Документы кабинета глазами владельца (P-07)
`GET /admin/crm/cabinet-docs` (`?problem=1` только проблемные, `?clientId=`, `?limit=` 1..500, по умолчанию 100) → `{ ok, items }`, новые сверху. Строка:
```json
{ "id": 7, "clientId": 3, "client": "Anvar", "kind": "quote", "title": "Коммерческое предложение", "number": "КП-12", "leadId": 12, "projectId": 4, "state": "awaiting_client",
  "createdAt": "...", "deliveredAt": null, "mail": { "state": "failed", "error": "http_500", "attempts": 1 }, "pdf": true, "signedPdf": false,
  "problems": ["email_failed"], "actions": ["resend"] }
```
- `mail.state`: `sent` (письмо ушло), `failed` (не ушло, `error` код причины без адреса и текста), `off` (Resend не настроен, доставка = строка в треде), `null` (ещё не пробовали).
- `problems`: `email_failed`, `no_pdf` (у документа, кроме счёта, нет PDF), `no_signed_pdf` (договор подписан, подписанного PDF нет). Пометка для Пульта: «письмо не ушло», «нет PDF».
- `actions`: `["resend"]` у КП, договора, счёта и акта (у сметы своего письма нет, она едет с КП).
`POST /admin/crm/cabinet-docs/:id` тело `{ "action": "resend" }` → 200 `{ ok, mail }` (письмо ушло); 502 `email_failed` + `mail` (снова не ушло, пометка остаётся); 409 `not_sendable` (смета) или `no_email` (Resend не настроен); 404 неизвестный документ; 400 `invalid` + `allowed` для другого тела. Повторной строки в треде нет: клиент её уже видел.
Алерт владельцу: каждое неушедшее письмо (КП, договор, счёт, акт, письма этапов проекта, уточняющие вопросы) пишется в `email_failures` (вид, ссылка вроде `КП-12` или `лид #5`, код причины), раз в час один алерт «Письма клиентам не ушли: N (…), причина: …», строка в утренней сводке. Журнал: `email_failed`, `doc_resent`.

### PDF и уведомления после рестарта (P-09)
- `deliveredAt` (меняется): время, когда клиент получил строку в треде о документе (раньше ставилось при создании строки). Пока фоновая работа после одобрения не дошла до клиента, `deliveredAt: null`. У сметы, акта по последнему этапу и документов старой цепочки время ставится сразу.
- `GET /admin/clients/:id/documents`: у документа без PDF (рестарт во время фоновой сборки, не было шрифтов) PDF собирается при этом чтении (не чаще раза в 10 минут на документ), `pdfUrl` появляется сразу в ответе. Журнал `pdf_rebuilt`.
- Старт HQ: документы `quote|contract|invoice|act` с `delivered_at IS NULL` получают PDF, строку в треде и письмо; документы с `mail.state = failed` получают письмо ещё раз. Всего не больше трёх писем на документ (`mail.attempts`), дальше только «Отправить снова» владельцем. Журнал `deliveries_recovered` (счётчики).

### Подписанный PDF (P-12)
`POST .../documents/:docId/sign` по-прежнему отвечает `{ ok: true, pdfUrl: null }`, если подписанный PDF не собрался (подпись записана). Теперь владелец сразу получает алерт, а следующее чтение `GET /admin/clients/:id/documents` (не раньше чем через 10 минут после неудачи) собирает подписанный экземпляр из сохранённой подписи `bo_signatures`; удача: строка во входящих владельца и журнал `signed_pdf_rebuilt`. До этого у договора `problems: ["no_signed_pdf"]` в `GET /admin/crm/cabinet-docs`.

### Этап готов от владельца (P-14)
`POST /admin/crm/projects/:id` `{ "action": "ready_milestone", "milestoneId" }` и команда `/mready <проект> <номер этапа>`: см. «Проекты» выше. Клиент получает «Принять этап» так же, как после результата строителя; задача строителя этапа остаётся как есть (в её журнале строка), поздний результат строителя ничего не повторяет.

### КП: отклонить, обсудить, срок (P-11)
- Новые состояния `quote` (меняется): `awaiting_client` -> `accepted` | `declined` (клиент отклонил или хочет обсудить) | `expired` (срок вышел). Сайт показывает их как есть; кнопок у `declined` и `expired` нет.
- `POST /admin/clients/:id/documents/:docId/reject` тело `{ reason: "1..1000", mode?: "decline" | "discuss" }` (по умолчанию `decline`) → 200 `{ ok: true, state: "declined" }`; 404 `not_found`, 400 `invalid`, 409 `not_awaiting` (+`state`), как у `accept`. Слова клиента пишутся в тред заявки от клиента, Fir Tech отвечает строкой «ваш ответ у менеджера», у Продаж появляется задача `kp_declined` (владелец получает её текст с причиной и подсказкой `/kp <лид>`), договор не готовится. Журнал `quote_declined` (только вид).
- Срок: `KP_VALID_DAYS` (14) от `deliveredAt`. За сутки до конца владелец получает алерт «КП … истекает завтра», в момент истечения КП становится `expired`, клиенту строка в тред, владельцу алерт. Правка истёкшего КП владельцем (ревью-центр, `revise`) возвращает его в `awaiting_client` с новым сроком.
- `nextStep` заявки: «Ваш ответ по КП у менеджера: он ответит в сообщениях» (`declined`), «Срок КП истёк: напишите в сообщениях, обновим предложение» (`expired`).

### Проект резервируется при «Принять КП» (P-10)
Для лида с кабинетом (меняется): одобрение КП владельцем больше не создаёт проект. Его резервирует `POST .../documents/:docId/accept` клиента (`pm_projects` `draft`, этапы оплаты с датами от дня принятия), у КП и сметы появляется `projectId`, задача договора и будущий счёт этапа 1 несут его номер. До принятия `projects` в `by-email` и в Пульте пусты, у КП `projectId: null`; отклонённое или истёкшее КП проекта не оставляет. Лид без кабинета (бот Telegram) резервирует проект при одобрении, как раньше. Журнал `project_reserved`.

### КП из нескольких продуктов (P-08)
Пакет Пресейла несёт `directions` (все продукты сметы конструктора, самый дорогой первым). После одобрения: `what` проекта и договора начинается с заголовка сметы («Сайт + ИИ-администратор»), задачи договора и счёта этапа 1 несут `products` (названия), строка счёта «Этап 1 из N: «…», КП #12: Сайт + ИИ-администратор», даты этапов считаются по самому долгому продукту пакета (приложение, сайт, агент, автоматизация). Старые пакеты без `directions` идут одним направлением, как раньше.

### Приёмка за клиента и закрытие проекта (P-15)
Владелец принимает этап за клиента (`/mdone <проект> <номер>`, `complete_milestone`) только когда этап оплачен и готов (`awaiting_acceptance`); иначе ответ с подсказкой `/mready`. `set_status done` у проекта с этапами оплаты запрещён, пока не приняты все этапы: закрытие идёт через приёмку последнего (оплата последнего этапа обязательна, акт клиенту уходит сам).

## Клиент заметит: разрывы процессов (2026-11-22, аудит P-xx, ветка `process-gaps-client`)
Пакет 2 ревью владельца (пункт 8). Таблица процессов: `docs/process-census.md`, раздел 12; дрилл `apps/hq/tests/drill/process-gaps-client.test.ts`.

### Письма о новых сообщениях и об оплате (P-13)
Ответ менеджера по заявке (Пульт `POST /admin/crm/leads/:id/reply`, чаты `POST /admin/chats/:id/reply`, одобренный ответ лиду), ответ Поддержки в треде
(тикет кабинета) и передача разговора агентом площадки (P-21) помечают строку треда `notify = 1` (`cab_messages`, `cab_tmsgs`). Тикер HQ раз в 30 с (`ClientMail.messageTick`,
`apps/hq/src/client-mail.ts`) шлёт клиенту ОДНО письмо «Новое сообщение в кабинете Fir Tech» на тред в час: без текста сообщения, со ссылкой
`<SITE_URL>/<ru|en>/cabinet?thread=<тред>`. Тред уже прочитан (`POST .../threads/:tid/read` после строки): письма нет. Неушедшее письмо идёт в часовой алерт владельца
(`email_failures`, вид `message`) и не повторяется на каждом тике. Оплата счёта (`/paid`, сторож, Пульт `mark_paid`) кроме строки в треде сразу шлёт письмо «Оплата по счёту <номер>
получена». Отметки «раз в час» и «один раз» переживают рестарт (таблица `client_marks`).

**Нужно от сайта:** открывать тред из `?thread=` в кабинете (если параметра нет, ничего не ломается).

### Созвоны живут в HQ (P-02, P-04, P-06, P-18, P-19, P-20)
Таблица `call_bookings` (`apps/hq/src/calls.ts`): одна живая бронь на лид (`pending | confirmed`, `cancelled`), откуда пришла (`chat`, `bot`, `form`, `pult`), что сказал сайт
(`site_state`: `site` сайт забронировал сам в своей форме, `booked` HQ забронировал на сайте, `not_accepted`, `taken`, `failed`), отметки напоминаний. `li_leads.chosen_slot`
всегда равен времени живой брони.

- **Окно из чата (P-03, P-04).** ИИ-менеджер в чате сайта больше не просит у анонима контакт: предложение созвона говорит «Напишите номер окна (1 или 2)», а аноним получает
  ссылку на вход `<SITE_URL>/<ru|en>/cabinet/login`. Выбор («1», «второе», «в пятницу в 14») сохраняется в черновике сессии (`QState.slot`). Вошедший клиент получает лид сразу,
  аноним, вернувшись в ту же сессию уже с `clientEmail`, пишет «да», и лид уходит с `slot` (ISO). Лид с окном: голова Продаж бронирует его на сайте
  (`POST <SITE_URL>/api/slots`, ниже) и ставит бронь в HQ; если сайт не принял, окно всё равно в лиде, а владелец получает задачу «Подтвердить созвон: лид #N» и строку в Telegram.
- **Окно из формы сайта (P-02).** `POST /lead` с `slot` (сайт уже забронировал окно у себя): HQ ставит бронь `site_state = site` и на сайт её не шлёт.
- **Первый ответ лиду (P-06).** Два ближайших свободных окна сайта (`GET /api/slots` минус окна, которые держит HQ); если сайт недоступен или окон меньше двух,
  прежние свои часы `SLOT_HOURS` ближайших рабочих дней. Окна, которые держит HQ, не предлагаются и в чате.
- **Пульт (P-18, P-19).** `POST /admin/crm/leads/:id/call`:
  - `{ "at": "<ISO>" }` (как раньше) или `{ "action": "book", "at" }`: бронь, окно на сайт, клиенту время по его каналу;
  - `{ "action": "confirm" }`: подтверждено; `{ "action": "reschedule", "at" }`: перенос (напоминания заново); `{ "action": "cancel" }`: отмена.
  - Ответ: `{ ok, item: { ...лид, callAt }, booking: { id, at, state, site } | null, told: ["cabinet", "email", "telegram", "web"] }`. 400 `invalid` (с `allowed`),
    404 лид, 409 `no_call` для `confirm`/`cancel` без брони. Повтор того же времени ничего не шлёт (`told: []`).
  - Канал клиента: лид с кабинетом получает строку в треде заявки и письмо (`Созвон с Fir Tech назначен / подтверждён / перенесён / отменён`), лид из бота сообщение
    в бот, лид из чата без кабинета ответ в сессию чата.
- **Напоминания (P-20).** Тикер HQ: за 24 часа и за час до созвона клиенту (тред, письмо «Завтра созвон с Fir Tech» / «Через час созвон с Fir Tech», бот или чат) и владельцу в
  инбокс (с пометкой, если время не подтверждено), время в зоне рынка `TZ`. Каждое по одному разу; созвон, назначенный меньше чем за сутки, получает только часовое; пропущенное
  во время простоя не догоняет.

**Нужно от сайта (контракт `POST /api/slots`):** заголовок `x-hq-token` = `SITE_BOOKING_TOKEN` HQ (если пусто, `LEAD_WEBHOOK_TOKEN`), тело
`{ slot: ISO UTC, leadId, name, contact, locale, source }`. Ответ 200/201: окно занято за лидом и не отдаётся в `GET /api/slots`; 409: окно уже занято; 401/403/404/405/501: сайт не
принимает (HQ ставит задачу «подтвердить созвон»). Подтверждение и перенос в боте сайта (`lead-bot.ts`) больше не нужны для заявок, на которые HQ ответил
`notified: true`: созвоном управляет Пульт.

### Один канал уведомлений о заявке (P-02)
`POST /lead` отвечает `{ ok: true, id, leadId?, notified: true }`: HQ принял заявку и сам сообщит владельцу (карточка Приёмщика, инбокс). Сайт шлёт заявку своим ботом только если
HQ не ответил (ошибка, таймаут, `queued`). Голова Продаж отмечает обработанную заявку (`tasks.meta.notifiedAt`, журнал `lead_notified`).

### Передача разговора агентом площадки (P-21)
Посетитель сайта клиента просит человека (`handoff_human`, в том числе когда модель недоступна): строка уходит владельцу агента, клиенту Fir Tech, в его тред `agent-<id>`
(причина, слова посетителя, контакт, если он оставил его в этом разговоре через `capture_lead`, номер разговора) и в журнал агента (`pg_journal` `handoff`,
`hq.log` `agent_handoff`); с виджета ещё и письмо «новое сообщение» (P-13). Тикета в поддержке Fir Tech нет, Поддержка ничего не отвечает; владелец Fir Tech получает только факт
в инбокс. Telegram-канал агента (токен хранится) пока не запущен, поэтому только тред.

### Отзыв и рекомендация после проекта (P-16)
Приёмка последнего этапа (клиентом или владельцем): в тред проекта строка и письмо «Как вам работа с Fir Tech?» с формой отзыва кабинета
(`<SITE_URL>/<ru|en>/cabinet?review=<проект>`) и реферальной ссылкой клиента (`<SITE_URL>/<ru|en>/?ref=<slug>`, 10% каждого оплаченного этапа приведённого клиента). Один раз на
проект. Через 7 дней без отзыва (ни формы, ни сообщения клиента в треде проекта после просьбы) владельцу одна строка в инбокс.
- `POST /admin/clients/:id/reviews { projectId, rating: 1..5, text }` → `{ ok, item }`; 400 `invalid`, 404 чужой или неизвестный проект, 409 `exists` (один отзыв на проект).
- `GET /admin/crm/reviews?limit=` → `{ ok, available: true, items: [{ id, clientId, client, projectId, rating, text, at }] }`; в `GET /admin/crm/overview` `reviews.available = true`.

**Нужно от сайта:** форма отзыва в кабинете (открывается по `?review=<projectId>`, оценка 1-5 и текст), список отзывов в Пульте.

### Демо на ваших данных за 24 часа (решение владельца)
Новая заявка с известной нишей (сборка, чат, бот) сразу получает черновой агент площадки `pg_agents` (`state: draft`, лимит демо 50 сообщений в сутки, персона из данных лида,
не больше одного на лид). Лиду с кабинетом агент виден во вкладке «Ваш агент» сразу (строка в его треде), у лида без кабинета (бот) `client_id = 0` до привязки аккаунта.
Ссылка демо-чата `<SITE_URL>/<ru|en>/demo/<publicId>?k=<ключ>` (ключ HMAC от `publicId`, токена агента наружу нет) стоит в первом ответе Приёмщика. Публичный
`POST /agent/:publicId/chat` с телом `{ demoKey, conversationId?, text }` без `x-agent-token` отвечает черновику лида (лимит демо, ответ с `mode: "demo"`; без ключа и без токена 401 `unauthorized`). Принятое КП
не создаёт агента заново: черновик лида переиспользуется (и переходит к аккаунту клиента), оплата этапа 1 включает его как раньше.

**Нужно от сайта:** страница `/<locale>/demo/<publicId>` с чатом, которая шлёт `demoKey` из `?k=` в `POST /agent/:publicId/chat`.

## Клиентский бот через HQ (2026-11-22)
«Позвать человека» в @firtech_bot больше не пишет владельцу из клиентского бота и не ждёт `/reply` в его чате (команды `/chats`, `/reply`, `/mute`, `/resume` в клиентском боте убраны; владельцу в нём отвечает одна строка «ответы в Пульте»). Всё идёт через HQ и Пульт:
- Клиент нажал «Позвать человека» (или бот передал разговор), бот замолчал в этом чате; в тред клиента (`/admin/chats`, склейка по `chatId` Telegram как раньше) ложится строка `from: "client"`, `channel: "telegram"`, id `tg_<n>`, текст «Просит позвать человека». Любое следующее сообщение клиента, пока бот молчит, и вопросы без ответа бота (нужен человек, цена, сбой модели) тоже строки треда (до 2000 знаков, хранятся 90 дней, таблица `ch_inbound`). Обычная беседа бота по-прежнему текстов не хранит.
- HQ-бот напоминает владельцу одной строкой со ссылкой на чат: «Клиент просит человека: Анвар, Telegram.» (тип напоминания `human`, сразу, тихие часы действуют) и «Клиент написал в Telegram: Анвар.» (тип `chat`, группируется как остальные). Текста клиента и @ника в Telegram нет. Ссылка: `/admin/chats?thread=g<chatId>` (псевдоним треда `g<chatId>` понимают `GET /admin/chats/:id`, `reply`, `resume`).
- В строке списка и в `thread` ответа `GET /admin/chats/:id` появилось поле `botMuted` (boolean): клиентский бот молчит в чате этого клиента, владелец на связи.
- Ответ владельца `POST /admin/chats/:id/reply` уходит клиенту в бот (`ClientChannel`) и оставляет бот молчащим (как раньше делал `/reply`). Вернуть клиента сценарию бота: **`POST /admin/chats/:id/resume`** (без тела) → `{ ok: true, thread }` (`botMuted: false`); тред без чата бота: 409 `no_bot_chat`; неизвестный 404.
- Тихие часы и лимиты клиентского бота не менялись.

## Настройки (2026-11-22)
Экран «Компания → Настройки» (`office?panel=company&tab=settings`). Всё под `x-admin-token`, код `apps/hq/src/settings.ts`. Значение env остаётся умолчанием, пока владелец не менял настройку; сохранённое значение сильнее env. Применение без рестарта там, где значение читается на лету; флаги службы читаются при старте, и `GET` говорит об этом (`restartRequired`, `restartKeys`).

`GET /admin/settings` → `{ ok: true, settings, usage, restartRequired, restartKeys }`:
```json
{ "ok": true,
  "settings": {
    "schedule": { "summaryTime": "08:00", "approvalTime": "09:00", "digestDay": 1, "digestTime": "08:30",
                  "quietHours": { "from": "23:00", "to": "08:00" }, "ownerTz": "Asia/Kuala_Lumpur", "tz": "Asia/Dushanbe" },
    "notices": { "types": { "client": true, "lead": true, "approval": true, "payment": true, "stage": true, "signed": true, "call": true, "chat": true, "human": true },
                 "alerts": { "lost_lead": true, "email_failed": true, "llm": true, "budget": true, "service": true },
                 "groupWindowMin": 5, "skipWhileDesk": true },
    "trust": { "defaultThreshold": 20,
               "kinds": [ { "kind": "lead_reply", "level": 1, "locked": false, "streak": 3, "approvals": 24, "threshold": 20, "custom": false } ] },
    "limits": { "deptBudgetUsd": { "marketing": 25, "sales": 20, "support": 15, "production": 15, "backoffice": 10, "director": 5 }, "clientLlmDailyCap": 300 },
    "calls": { "slotHours": ["11:00", "15:00"], "durationMin": 30, "bufferMin": 0 },
    "kp": { "validDays": 14, "defaultLang": "ru" },
    "playground": { "draftMsgsPerDay": 50, "liveMsgsPerDay": 500 },
    "service": { "tgApprovalCards": false, "tgGroupReports": false } },
  "usage": { "deptMonthUsd": { "marketing": 4.2, "sales": 1.1, "support": 0, "production": 0, "backoffice": 0, "director": 0.6 }, "clientLlmToday": 41, "monthStartedAt": "2026-10-31T19:00:00.000Z" },
  "restartRequired": false, "restartKeys": [] }
```
- `schedule`: время `HH:mm` на часах владельца (`ownerTz`), `digestDay` 0 (воскресенье) .. 6, `quietHours` `{ from, to }` или `null` (тихих часов нет), `tz` часы рынка (клиентский бот, слоты, сроки), `ownerTz` часы владельца. Любое изменение пересоздаёт крон Директора и рутины (`director.start`, `onTimingChange`).
- `notices.types`: включено ли напоминание HQ-бота этого типа (`stage` это «этап готов» и «этап принят», `human` и `chat` это клиентский бот, см. выше); выключенный тип пишется в базу как `muted` и не отправляется, и не повторится при включении. `alerts`: виды алертов, идущих в Telegram короткой строкой. `groupWindowMin` окно группировки, 0..120 минут (0: каждое напоминание отдельно), `skipWhileDesk` не слать, пока Пульт открыт. Сводки и дайджест отключить нельзя.
- `trust.kinds`: таблица видов действий с уровнем (0: ждёт кнопку, 1: делает сам), `locked` (деньги, цены: поднимает только владелец), `streak` одобрений подряд, `approvals` всего, `threshold` сколько нужно подряд для уровня 1 (`custom`: задан для вида, иначе `defaultThreshold`, иначе `TRUST_THRESHOLD`).
- `limits.deptBudgetUsd`: **ключ лимитов отделов, USD в месяц** (0 = без лимита), пишется в `agents.budget_usd_month` головы отдела (для `director`: самого Директора и его ассистента), его читает `overBudget`; применяется сразу, алерты 80% и 100% остаются. `usage.deptMonthUsd` расход месяца рядом (`director` это отдел `hq`). `clientLlmDailyCap` дневной потолок ответов модели клиентского бота и чата сайта (0: только шаблоны), `usage.clientLlmToday` сколько израсходовано сегодня.
- `calls`: `slotHours` два окна по умолчанию (когда сайт не отдал свои), `durationMin` 5..240 и `bufferMin` 0..240: занятый созвон закрывает окна ближе, чем длительность плюс буфер. `kp.validDays` 1..90, `kp.defaultLang` `ru|en` (язык документов по умолчанию, сохраняется; документы клиентов с языком кабинета идут на его языке). `playground`: лимит сообщений в сутки у агента площадки без своего лимита, 1..2000.
- `service`: флаги `TG_APPROVAL_CARDS` и `TG_GROUP_REPORTS`; смена читается при старте HQ, поэтому после неё `restartRequired: true` и `restartKeys: ["service.tgApprovalCards"]`.

`PATCH /admin/settings`: тело — любое подмножество тех же групп, лишние поля 400 `invalid` (`fields` перечисляет пути), всё или ничего:
```json
{ "schedule": { "summaryTime": "09:30", "digestDay": 3, "quietHours": { "from": "22:00", "to": "07:00" } },
  "notices": { "types": { "lead": false }, "alerts": { "budget": false }, "groupWindowMin": 10, "skipWhileDesk": true },
  "trust": { "defaultThreshold": 10, "thresholds": { "lead_reply": 5, "content_item": null }, "levels": { "lead_reply": 1 } },
  "limits": { "deptBudgetUsd": { "sales": 30 }, "clientLlmDailyCap": 200 },
  "calls": { "slotHours": ["10:00", "16:30"], "durationMin": 45, "bufferMin": 15 },
  "kp": { "validDays": 30, "defaultLang": "en" },
  "playground": { "draftMsgsPerDay": 20, "liveMsgsPerDay": 800 },
  "service": { "tgApprovalCards": true } }
```
Ответ `200 { ok: true, changed: ["schedule.summaryTime", ...], settings, usage, restartRequired, restartKeys }` (то же, что `GET`, плюс `changed`: только ключи, значение которых действительно поменялось). Ошибки: 400 `invalid` (формат, диапазон, неизвестный ключ, часовой пояс не IANA), 422 `unknown_kind` + `kinds` (вид действия не существует; `thresholds: { вид: null }` сбрасывает порог вида), 422 `unknown_department` + `department` (у отдела нет головы), 503 `unavailable` (нет объекта настроек). `levels` это тот же код, что `POST /admin/company/trust/:kind` и `/level`.

Журнал: таблица `settings_log` (`at`, `key`, `old`, `new`, `source`): ключ в той же записи, что в `changed` (`schedule.summaryTime`, `limits.deptBudgetUsd.sales`, `trust.levels.lead_reply`...), `source` `owner` или `seed 2026-11-23`; значения только настроек, текстов клиентов нет. Первичные лимиты (marketing 25, sales 20, support 15, production 15, backoffice 10, director 5, USD в месяц, бюджет API 100 USD) пишутся один раз при старте, если у всех голов 0 (метка `limits_seeded`: лимит, который владелец позже вернул в 0, остаётся 0).

Ассистент HQ-бота: «какие настройки?» читает эти же значения (инструмент `company_settings`, только чтение), «поставь сводку на 9:30» не меняет ничего и отвечает ссылкой `…/admin/office?panel=company&tab=settings`.

## Демо по клиенту (2026-11-23)
`GET /admin/crm/clients/:id` теперь несёт `demoUsage` (30 дней: `days`, `messages`, `tokensIn`, `tokensOut`, `usd`, `today`, `bySource[{source, messages, usd}]`; нули, если демо не было). Учёт, лимит и поля ответа демо: `public-api.md`, «Демо только для вошедших и учёт по клиенту».
