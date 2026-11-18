# apps/hq: Директор и головы отделов (этап 1: Маркетинг)

Один процесс, один контейнер, одна SQLite (`$DATA_DIR/hq.db`). Спека: `../../../docs/architecture-hq.md`, ядро:
`packages/hq/README.md`. Dono и Polly остаются отдельными ботами.

## Как идёт задача
```
владелец пишет Директору            рутина (cron) -> hq.runRoutine
          |  LLM (strict JSON)               |
          v                                  v
   задача отделу (inbox) + wake головы   задача (creator: routine) + wake
                         \                  /
                          heartbeat, 30 с: голова просыпается
   голова: claim -> разбить (worker.plan или LLM-сплит) -> подзадачи исполнителю -> worker.run
        -> LLM-ревью по чек-листу отдела -> одна доработка -> requestApproval (в очередь) или done -> отчёт
   Директор: 10:00 и /approve собирает очередь всех отделов одной серией с номерами (кнопки)
   владелец: Одобрить / Править / Отклонить -> задача done / rejected
```
Голова владельцу в личку не пишет никогда. Отчёты: запись в журнале задачи (идёт в утреннюю сводку 08:00) и, если
настроены группа, тема отдела и бот отдела, сообщение в тему. Директор пишет сам только три вещи: утреннюю сводку,
пачку на одобрение, алерты (в тихие часы алерты ждут сводки).

## Директор (бот `HQ_BOT_TOKEN`, только `OWNER_TELEGRAM_ID`, личный чат)
Любое сообщение разбирается LLM в одно из: задача отделу, вопрос о статусе, изменение правил, «нужен строитель»
(задача `blocked` с пометкой `builder`, отдел `hq`). Ответ модели не команда: отдел, настройка и агент проверяются по
спискам, неизвестное отклоняется. Изменение правил пишется только после кнопки «Применить»: настройки `tz`,
`summary_time`, `approval_time`, `quiet_hours` или новая строка в раздел «Правила владельца» инструкции агента.
Без LLM (нет ключа) Директор отвечает, что не смог разобрать, команды работают.
Команды: `/status`, `/tasks [отдел]`, `/approve`, `/costs`, `/org`, `/pause <отдел>`, `/resume <отдел>`, `/skip`, `/help`.

## Маркетинг (`src/heads/marketing.ts`)
Бот отдела `MARKETING_BOT_TOKEN` необязателен (тишина без него). Рутины создаются при первом старте (дальше правятся
через `hq import` и не перезаписываются): понедельник 09:00 пакет недели (7 клипов, карусель раз в две недели),
ежедневно 09:00 «что публикуем сегодня» (одобренное на сегодня из `cm_ready`). Задачу владельца голова делит LLM
(`pack` / `topic` / `daily` / `none`); без LLM работают только очевидные формулировки. Исполнитель:
`packages/workers/content-maker`. Правка карточки по частям (сценарий, Instagram, TikTok, Shorts) работает через
`ApprovalEditor` головы. Отклонённый материал закрывает задачу; переделку владелец заказывает новой задачей.

### Остальные исполнители отдела (этап 1, текст, без платных API)
| Исполнитель | Рутина | Что делает | Документ |
|---|---|---|---|
| Трендвотчер | 08:30 ежедневно, вс 20:00 итог недели | 5 хуков и форматов дня из Google Trends и YouTube, отдаёт их Контент-мейкеру | `packages/workers/trend-scout/README.md` |
| Публикатор | 09:00 «что публикуем сегодня» | пакеты публикации по платформам, кнопка «Опубликовано» (ручная публикация) | `packages/workers/publisher/README.md` |
| SEO | пн 11:00 | проверка сайта и llms.txt, до 5 правок в пачку одобрения, `builder` для кода | `packages/workers/seo/README.md` |
| Аналитик | пн 08:00 | отчёт из данных HQ: 5 чисел и 3 рекомендации | `packages/workers/analyst/README.md` |
Задачи трендов, SEO и отчёта голова запускает напрямую (без чек-листа контента); предложения SEO идут в очередь одобрений
(`seo_proposal`, уровень 0). Кнопка `pb:<id>` («Опубликовано») обрабатывается в `src/index.ts` и пишет `published_at`.
Все источники необязательны: без ключа источник выключен.

## Инструкции агентов
`instructions/director.md` и `instructions/marketing-head.md` (русский) загружаются в таблицу `agents` один раз при первом
старте (`ensureAgent`). Дальше правда в базе: меняются через Директора (кнопка) или `hq import`. Чек-лист проверки
материалов лежит в инструкции головы маркетинга.

## Переменные
См. `.env.example`: `HQ_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `TZ`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL_FAST/SMART`;
необязательные `YOUTUBE_API_KEY`, `YOUTUBE_CHANNEL_ID`, `TRENDS_REGIONS` (по умолчанию `KZ,UZ,RU`), `GSC_SERVICE_ACCOUNT_JSON`, `GSC_SITE_URL`, `SITE_URL` (по умолчанию `https://firtech.pro`), `MARKETING_BOT_TOKEN`, `HQ_GROUP_ID`, `HQ_TOPICS` (JSON `{"general":2,"marketing":3}`; ключи: `general` и
id отдела), `DATA_DIR`, `CLIPS_PER_WEEK`, `CAROUSELS_PER_WEEK`, `MARKETING_BUDGET_USD`, `TRUST_THRESHOLD`.

## Как добавить отдел
1. Исполнители: `packages/workers/<имя>` (контракт в `packages/hq/README.md`).
2. Инструкция головы `apps/hq/instructions/<отдел>-head.md` с чек-листом отдела; агенты и рутины в `src/org.ts` (`ensureAgent`,
   `scheduleRoutine`; бот: имя переменной в поле `bot`).
3. Голова: `src/heads/<отдел>.ts` по образцу `marketing.ts` (`onHeartbeat`, разбиение, `worker.run`, ревью, `hq.requestApproval`,
   отчёт через `Reporter`). Тип одобрения регистрирует голова (`hq.registerKind`).
4. `src/index.ts`: создать голову, добавить в `HeartbeatWorker` (по `agent.id`), при боте отдела добавить отправителя в `senders`.
5. Тесты по образцу `tests/marketing.test.ts` (`MemoryMessenger`, `MockLlm`, `:memory:`).

## Запуск
`pnpm --filter hq dev` (`.env.local`). Docker: `apps/hq/Dockerfile`, сервис `hq` в `compose.yaml` (без портов, `read_only`,
данные `/opt/fir-agents/data/hq`), образ `agents-hq` в CI. Экспорт оргструктуры:
`docker compose exec hq node node_modules/@fir/hq/dist/cli.js export`.
