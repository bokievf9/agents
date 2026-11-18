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

## Сопровождение (`src/heads/support.ts`)
Голова `support-head`, исполнители `packages/workers/monitoring` и `packages/workers/finance`. Бот `SUPPORT_BOT_TOKEN`
необязателен (тишина без него; проверки и алерты работают). Отчёты идут в тему `support` из `HQ_TOPICS`.
- Мониторинг каждые 5 минут идёт от собственного крона головы, а не от рутины: рутина создавала бы 288 задач в сутки.
  События дня (тревога, «снова в норме») собираются в одну задачу «Дежурство ДД.ММ», она закрывается на следующий день
  строкой аптайма. Тревога после двух неудач подряд, один раз; «снова в норме» один раз; в тихие часы тревога ждёт
  сводки (путь Директора). Проверки: `MONITOR_URLS` (по умолчанию health firtech.pro, 200 и ok), срок TLS (меньше
  14 дней), OmniRoute (`OMNIROUTE_HEALTH_URL`), диск `DATA_DIR` (больше 85%), контейнеры только при `MONITOR_DOCKER=true`.
- `MONITOR_DOCKER`: нужен том `/var/run/docker.sock` (в `compose.yaml` закомментирован). Доступ к сокету Docker равен root
  на сервере, а `:ro` не ограничивает API: оставляйте выключенным, пока нет реальной нужды.
- Рутины (создаются при первом старте): `support-daily` 07:50 (строка финансов и аптайма в утреннюю сводку) и
  `support-weekly` воскресенье 20:00 (расходы за месяц на данный момент, прогноз). Расходы берутся из `costs` с реальным
  usage модели; цены за 1M токенов в таблице `prices` (`hq.setPrice`), бесплатные модели шлюза стоят 0. Постоянные расходы
  (`FIXED_COSTS_USD_MONTH`) делятся на дни месяца. Лимит отдела: `SUPPORT_BUDGET_USD`.

## Инструкции агентов
`instructions/director.md` и `instructions/marketing-head.md` (русский) загружаются в таблицу `agents` один раз при первом
старте (`ensureAgent`). Дальше правда в базе: меняются через Директора (кнопка) или `hq import`. Чек-лист проверки
материалов лежит в инструкции головы маркетинга.

## Переменные
См. `.env.example`: `HQ_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `TZ`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL_FAST/SMART`;
необязательные `MARKETING_BOT_TOKEN`, `HQ_GROUP_ID`, `HQ_TOPICS` (JSON `{"general":2,"marketing":3}`; ключи: `general` и
id отдела), `DATA_DIR`, `CLIPS_PER_WEEK`, `CAROUSELS_PER_WEEK`, `MARKETING_BUDGET_USD`, `TRUST_THRESHOLD`; сопровождение: `SUPPORT_BOT_TOKEN`, `MONITOR_URLS`, `MONITOR_DOCKER`, `OMNIROUTE_HEALTH_URL`,
`FIXED_COSTS_USD_MONTH`, `SUPPORT_BUDGET_USD`.

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
