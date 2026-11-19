# @fir/hq: ядро компании агентов

Одна SQLite и один API для всех отделов (спека: `../../../docs/architecture-hq.md`, раздел «Ядро»). Голова отдела и
Директор (`apps/hq`) работают только через `Hq`; исполнители (`packages/workers/*`) получают узкий `WorkerCtx`.

## Что внутри
| Таблица | Что хранит | API |
|---|---|---|
| `agents` | оргчарт: dept, role (director/head/worker), instructions (md), boss_id, status, trust_level, bot (имя переменной токена), budget_usd_month | `upsertAgent`, `ensureAgent`, `agents`, `headOf`, `setInstructions`, `setDeptStatus` |
| `tasks` | задача: статус `inbox → assigned → running → review → approval → done`, плюс `blocked`, `rejected`; `meta` (JSON для исполнителя), `tags` (например `builder`), `parent_id`, `cost_usd` | `createTask`, `assign`, `claim`, `comment`, `setStatus`, `complete`, `block`, `tasks`, `countByStatus` |
| `task_events` | журнал задачи: статусы, комментарии, результаты, ошибки, отчёты головы (`report`) | `events`, `addEvent`, `reports` |
| `approvals` (+ `task_approvals`) | очередь одобрений из `@fir/core` (кнопки, правка, уровни доверия) и связь предложения с задачей | `registerKind`, `requestApproval`, `releaseApprovals`, `reconcileApprovals`, `onApprovalDecision` |
| `routines` | cron, отдел, шаблон задачи, политика «не запускать, пока идёт прошлая» (`overlap: skip`) | `scheduleRoutine`, `runRoutine`, `startRoutines` |
| `heartbeats` | очередь пробуждений с коалесценцией (одно ожидающее на агента, ближайшее время, причины склеены) | `wake`, `claimDueHeartbeats`, `HeartbeatWorker` (тик 30 с) |
| `costs` | usage по задаче, агенту, отделу; лимит отдела в месяц | `recordCost`, `monthSpend`, `overBudget`, `costSummary`, `meterLlm` |
| `activity` | журнал действий (агент, действие, объект), без текстов клиентов | `log`, `activity` |
| `settings` | `tz`, `summary_time`, `approval_time`, `quiet_hours` и служебные ключи | `setting`, `setSetting`, `isQuiet` |

## Правила
- `claim(taskId, agentId)` атомарен: один `UPDATE ... WHERE status IN ('inbox','assigned')`, второй претендент получает `false`.
  Переходы статусов проверяются таблицей (недопустимый переход бросает ошибку).
- Одобрения: `requestApproval` кладёт предложение в очередь и переводит задачу в `approval`, но **владельцу не пишет**.
  Карточки уходят одной пронумерованной серией, когда Директор вызывает `releaseApprovals` (10:00 и `/approve`). Тип с
  уровнем 1 выполняется сразу. Вид с `registerKind(kind, spec, { urgent: true })` (клиент ждёт, например аудит) уходит владельцу сразу одиночной карточкой «Срочно», не дожидаясь пачки. Деньги, цены, договоры: `locked: true`, всегда уровень 0. `reconcileApprovals` приводит
  задачи в соответствие с решениями владельца (одобрено: `done`, отклонено: `rejected`, сбой выполнения: `blocked`).
- `recoverInterrupted()` вызывается один раз при старте процесса: задачи, оставшиеся в `running` после рестарта или деплоя (их исполнитель умер вместе с процессом), возвращаются в `assigned`, запись в журнале задачи.
- Лимит отдела: `budget_usd_month` головы отдела (0: без лимита). При достижении `recordCost` ставит задачу в `blocked`,
  один раз за месяц зовёт `alert`; `meterLlm` отказывает в новых вызовах. Токены оценочные (клиент ядра отдаёт только
  текст, примерно 4 символа на токен), цена из `hq.prices` по тарифу (`{sonnet: {in, out}}` за 1 млн), бесплатные модели $0.
- Алерты: `hq.alert(text)` отдаёт текст всем подписчикам (`onAlert`), Директор шлёт владельцу.

## Экспорт и импорт компании
`hq export [файл.yaml]` и `hq import <файл.yaml>` (БД: `$HQ_DB` или `$DATA_DIR/hq.db`; в контейнере
`docker compose exec hq node node_modules/@fir/hq/dist/cli.js export`). В YAML: оргчарт с инструкциями, рутины, четыре
настройки. Без секретов по построению: токены только как имя переменной (`bot: MARKETING_BOT_TOKEN`, проверка по маске),
неизвестные поля и посторонние настройки отклоняются (zod strict), задач и расходов в файле нет.

## Как добавить исполнителя (worker)
1. Папка `packages/workers/<имя>` (копия `content-maker`: `package.json` с зависимостями `@fir/core`, `@fir/hq`; `tsconfig`).
2. Класс с `id`, `run(task, ctx): Promise<WorkerResult>` и при желании `plan(task, ctx)` (разбить задачу на подзадачи).
   Свои таблицы в `ctx.db` с префиксом. Наружу ничего не писать: предложения через `ctx.requestApproval(kind, payload, summary)`.
3. Тип одобрения исполнителя (`KindSpec`) регистрирует голова (`hq.registerKind`); `locked: true` для денег и цен.
4. Тесты на поддельном `WorkerCtx` (см. `packages/workers/content-maker/tests/helpers.ts`), сеть не нужна.

Как добавить отдел: `apps/hq/README.md`.
