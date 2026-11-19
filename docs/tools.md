# Инструментарий агентов (`@fir/core` → `tools/`), 2026-11-20

Зачем: исполнители и головы раньше сами звали `fetch`, читали файлы, рисовали PNG и ходили в API каждый по-своему. Каждому
новому агенту приходилось заново решать, что ему можно, как логировать и что делать при ошибке. Теперь у каждого агента есть
один объект `ctx.tools`: набор проверенных инструментов с одинаковым форматом ошибок, правами по отделам, журналом вызовов и
лимитами. Новый агент получает инструменты без правки кода других агентов; новый инструмент добавляется в одном месте.

Состояние: **v1 реализован** (ветка `feat/core-tools`, 2026-11-20). Код: `packages/core/src/tools/*`, тесты-контракты:
`packages/core/tests/tools/*`. Каждая голова HQ даёт исполнителю `ctx.tools` (`apps/hq/src/tools.ts`), прямой `fetch` убран
из Аналитика, SEO и Трендвотчера. Мониторинг остаётся на своём `fetch`: он проверяет внутренние `http://` адреса сети docker
(OmniRoute), а инструменты такие адреса запрещают по замыслу.

## Принципы
- **Один формат результата**: `ToolResult<T> = { ok: true, value: T } | { ok: false, error: ToolErrorCode, message: string, retryable: boolean, status?: number }`.
  Коды: `not_allowed` (отделу нельзя или инструмента нет), `not_configured` (нет ключа, адаптера, базы или папки), `invalid`
  (плохой аргумент), `rate_limited` (429, дневной лимит, капча поиска), `timeout`, `network` (DNS, обрыв), `blocked` (SSRF,
  хост вне списка, путь за пределами папки), `too_large`, `not_found` (404/410, нет файла), `upstream` (ответ сервиса с
  ошибкой, мусор вместо JSON, модель не дала ответа), `internal` (исключение внутри инструмента, поймано).
  Инструмент **никогда не бросает исключений**: любая ошибка превращается в `ok: false`. `status` есть, когда был HTTP-ответ.
- **Права по отделам**: таблица `tools/policy.ts` (`TOOL_POLICY`), отделы `marketing`, `sales`, `support`, `production`,
  `backoffice`, `director`. Вызов не из своего отдела даёт `not_allowed`, строку в журнале, без исключения. Динамический вызов
  `tools.call('web.search', ...)` с неизвестным именем тоже `not_allowed`. Права выгружаются в `GET /admin/company` (`tools`).
- **Журнал**: каждый вызов пишет строку `activity` (agent, `tool:<name>`, объект `task`/id, detail «код длительность», без
  аргументов и текстов). Дешёвые локальные инструменты (`quiet` в политике: кэш, прайс, плейбук, CRM, часы) пишут строку только
  при ошибке. Счётчики вызовов и ошибок по кодам за день лежат в `settings` (`tools.stats.<YYYY-MM-DD>` по часам компании).
- **Лимиты**: сетевые вызовы идут через общую на процесс очередь на хост (`HostQueue`: не больше `perHost` одновременно и
  пауза `minGapMs` между стартами), таймауты по умолчанию, повтор с backoff 0,5 с, 1 с, 2 с только на `retryable` и только
  сколько разрешает политика (`retries`; POST, письма, загрузки и Telegram не повторяются никогда).
- **Безопасность сети**: только `https` и порт 443, без логина в URL, только хосты из списка вызова, адрес резолвится один раз,
  проверяется на публичность и закрепляется (`net.ts`: `resolvePublic`, `pinnedFetch`), редиректы только там, где разрешены
  (`getText`, `readable`: до 3, каждый шаг проверяется заново), ответ ограничен по размеру. `readable` без списка читает только
  хосты, которые вернул `search` этого же набора; `hosts: 'public'` нужно указать явно.
- **Секреты**: только из конфига приложения (`ToolsConfig`, env HQ). Инструмент знает, настроен ли он (`configured(name)`,
  `tools/configured.ts`), и отвечает `not_configured`, а не падает. Значения ключей вычищаются из сообщений (`***`), в URL не
  кладутся (Brave, Resend, TronGrid: заголовки).
- **Тесты-контракты**: успех, каждый код ошибки, отсутствие исключений; реестр проверяет, что каждый инструмент есть в политике
  и в этом файле, а каждый код ошибки описан здесь.

## Состав v1

| Инструмент | Что делает | Кому | Лимиты | Нужно для `configured` |
|---|---|---|---|---|
| `web.getJson(url, {hosts})` | GET JSON с allow-list, pinned DNS | все | 8 с, 1 МБ, 2 на хост, повтор 2 | ничего |
| `web.getText(url, {hosts})` | GET HTML или текст, обрезка до 300 КБ (`truncated`), кодировка из `content-type` | marketing, sales, support, director | 8 с, 300 КБ, редиректы 3 | ничего |
| `web.readable(url, {hosts?})` | статья: заголовок, текст без навигации, рекламы и cookie, дата публикации, язык, ссылки статьи | marketing, sales, director | как `getText`, свой парсер без зависимостей | ничего |
| `web.search(q, {limit, lang})` | веб-поиск: Brave Search API при ключе, иначе DuckDuckGo HTML | marketing, sales, director | 10 результатов, 1 запрос/с на провайдера, кэш 1 ч | `BRAVE_SEARCH_KEY` (необязательно) |
| `web.post(url, body, {hosts, as})` | POST/PUT JSON, формы или байтов к известным API | все | 60 с, без повторов | ничего |
| `cache.get(key)` / `cache.set(key, value, ttlMs)` / `cache.del(key)` | KV-кэш в SQLite (`tool_cache`), своё пространство ключей | все | 64 КБ значение, TTL до 30 дней | ничего (без базы: память) |
| `files.put(dir, name, bytes)` / `files.get(path)` / `files.list(dir)` | файлы в `DATA_DIR/renders/<dir>/`: безопасные имена, атомарная запись, без `..` и симлинков наружу | marketing, sales, backoffice | 50 МБ | `DATA_DIR` |
| `files.url(path)` | подписанный публичный URL `/media/<sig>/<path>` (png, jpg, mp4) | marketing, backoffice | | `MEDIA_SECRET` (или `WEB_CHAT_TOKEN`) и `IG_PUBLIC_BASE` |
| `media.png(frame)` | PNG из кадра: адаптер `renderPng`, который приложение берёт из `content-maker/render` | marketing | 1080×1350, 1080×1920, 2560×1440 | адаптер (в HQ всегда) |
| `media.qr(text)` | QR в SVG, свой кодировщик (byte mode, L/M/Q/H, версии 1-40) | sales, support, backoffice | до 1000 байт | ничего |
| `media.pdf(doc)` | A4 PDF: заголовок, строки сведений, разделы с абзацами и таблицей, подписи, нижний колонтитул «стр. N из M» | sales, backoffice | `pdfkit`, Onest из `packages/core/assets/fonts`, 5 МБ | шрифты в образе |
| `llm.json(req, schema)` / `llm.text(req)` | обёртки `tryJson`/`tryComplete` с учётом расходов задачи | все | как в `llm.ts` | `LLM_API_KEY` или `ANTHROPIC_API_KEY` |
| `prices.get()` | прайс-лист сайта (`getPrices`) | все | | ничего |
| `playbook.excerpt(role)` | выдержка плейбука для промпта | все | 2500 знаков | ничего |
| `knowledge.search(q)` / `knowledge.add({project, text})` | полнотекстовый поиск по `knowledge/**.md` и урокам `kb_lessons`; урок попадает в недельную выгрузку Базы знаний | все | 20 результатов, урок до 2000 знаков | `KNOWLEDGE_DIR` или база |
| `crm.leads()` / `crm.clients()` / `crm.projects()` / `crm.invoices()` / `crm.tickets()` | только чтение через CRM-слой Пульта (`createCrm`); маркетинг видит записи без контактов | по отделам (см. `policy.ts`) | 100 строк | адаптер (в HQ всегда) |
| `events.week()` | события сайта за 7 дней (`site_events`) по дням и именам | marketing, director | | база |
| `chain.transfers(method, address, sinceMs)` | входящие USDT (TronGrid, toncenter), парсер общий с Сопровождением | support, backoffice | 8 с, повтор 1 | `TRONGRID_API_KEY`, `TONCENTER_API_KEY` (необязательно) |
| `google.youtube.channel()` / `google.youtube.videos(ids)` | статистика своего канала и видео | marketing, director | 10 с | `YT_OAUTH_CLIENT_JSON` + `YT_REFRESH_TOKEN`, или `YOUTUBE_API_KEY` (+ `YOUTUBE_CHANNEL_ID`) |
| `google.youtube.upload(v)` | загрузка видео (resumable), квота общая с Публикатором (`pb_quota`) | marketing | 1600 из 10 000 ед./день, потолок 9000 | `YT_OAUTH_CLIENT_JSON` + `YT_REFRESH_TOKEN` |
| `google.trends({geo, q?})` | Google Trends: суточные тренды региона из публичного RSS | marketing, director | кэш 1 ч, 25 строк | ничего |
| `google.searchConsole({days})` | Search Console: топ запросов и страниц (JWT сервисного аккаунта на `node:crypto`) | marketing, director | кэш на день | `GSC_SERVICE_ACCOUNT_JSON` + `GSC_SITE_URL` |
| `telegram.send(text)` / `telegram.sendDocument(path)` / `telegram.sendPhotos(paths)` | сообщение и файлы **владельцу** через мессенджер головы (`OutboxMessenger`: пауза 1,1 с, повтор на 429) | все (фото: marketing, production, director) | без повторов сверх Outbox | бот головы |
| `email.send({to, subject, text})` | письмо через Resend; действие наружу, звать только из одобренного шага | support, sales, backoffice | 100 в день на компанию | `RESEND_API_KEY` + `RESEND_FROM` |
| `mac.poster.enqueue(itemId, platform)` | очередь публикатора на Маке (`mac_queue`), Мак читает `GET /admin/content?queued=1` | marketing | один открытый ряд на материал и площадку | база |
| `clock.now()` / `clock.zoned(tz)` / `clock.week(date)` | время компании, часы в зоне, ISO-неделя | все | | ничего |

## Как пользоваться
```ts
const r = await ctx.tools?.web.search('тренды ИИ для салонов красоты', { limit: 5, lang: 'ru' });
if (!r?.ok) { ctx.log('search_failed', r?.error); return fallback(); }
for (const hit of r.value) {
  const page = await ctx.tools!.web.readable(hit.url); // хост из поиска: можно
  if (page.ok) use(page.value.title, page.value.text);
}
```
Голова строит набор на каждый запуск исполнителя (`apps/hq/src/tools.ts`, `toolsFor(...)`: агент, отдел, задача, журнал HQ,
база, конфиг, счётчик LLM задачи, мессенджер головы, адаптеры `renderPng` и `crm`). `WorkerCtx.tools` необязателен, чтобы
старые тесты с ручным `ctx` компилировались; исполнитель без него берёт `toolsOf(ctx, dept)` из `@fir/hq` (набор без журнала).
В тестах `createTools({ agentId, dept, fetch, lookup, now, db, queue, sleep })` работает без сети.

## Как добавить инструмент
1. Функция в `packages/core/src/tools/<группа>.ts`, вызов обёрнут `k.call('<имя>', async () => ...)`, ответ `ToolResult`, без исключений.
2. Строка в `tools/policy.ts` (имя, отделы, лимиты, env, `quiet`) и правило в `tools/configured.ts`, если инструменту что-то нужно.
3. Подключение в `tools/registry.ts` (`createTools`), строка в таблице выше, тест-контракт в `packages/core/tests/tools/*.test.ts`
   (тест реестра упадёт, если забыть политику или документацию).
4. Если нужен ключ: поле в `ToolsConfig`, переменная в `apps/hq/src/config.ts` и `apps/hq/.env.example`, проводка в `apps/hq/src/tools.ts`.

## Не вошло в v1
- Мониторинг не переведён (внутренние `http://` адреса, см. выше). Аудит сайта SEO (`collectFacts`) уже шёл через `net.ts` и не менялся.
- Шрифт PDF без расширенной кириллицы (таджикские ҳ, қ, ҷ, ӯ): нужен файл `onest-cyrillic-ext`.
- Панель «Компания» на сайте показывает `tools` позже (HQ уже отдаёт).
