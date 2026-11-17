# fir-agents

Монорепо исполнителей Fir Tech: общее тело `packages/core` и «головы» в `apps/<агент>`. Компания и роли:
`../COMPANY.md`, бриф фазы 0: `../docs/brief-agents-core.md`. Правила workspace (git как `bokievf9`, без
`Co-Authored-By`, секреты не печатать, ветки, merge после проверок) в `../CLAUDE.md`.
Образец ядра: `../dono/` (Dono переедет на ядро позже; пока его код не трогаем).

## Стек
Node 22, TypeScript ESM (NodeNext), pnpm 12 workspaces. `grammy` (long polling), `better-sqlite3`, `croner`,
`@anthropic-ai/sdk`, `zod`, `vitest`, `eslint`. TypeScript закреплён на 6.x (как в Dono).

## Проверки
`pnpm -r typecheck && pnpm lint && pnpm -r test && pnpm -r build`. Запуск головы локально:
`pnpm --filter lead-intake dev` (берёт `apps/lead-intake/.env.local`, пример `.env.example` рядом).
Внутри монорепо `@fir/core` подключается из исходников через условие экспорта `source` (tsx, vitest, typecheck);
сборка и образ используют `dist`, поэтому `pnpm -r build` собирает ядро первым.

## packages/core (`@fir/core`)
- `env.ts`: общий конфиг (`loadBaseConfig`: токен бота, `OWNER_TELEGRAM_ID`, `TZ`, `DATA_DIR`, порог доверия, LLM).
- `db.ts`: SQLite (WAL), `migrate()` для схемы головы. `time.ts`: часовые пояса через Intl.
- `bot.ts`: `createBot`, `grammyMessenger`, `installApprovals` (кнопки и правка владельца), `startPolling`.
  `messenger.ts`: интерфейс `Messenger` (в тестах `MemoryMessenger`, сеть не нужна).
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

## apps/lead-intake: Приёмщик лидов
Источники: Telegram-бот (публичный, отвечает всем клиентам; команды `/leads`, `/trust`, `/level` и кнопки только
владельцу) и `POST /lead` (заголовок `x-lead-token` = `LEAD_WEBHOOK_TOKEN`, поля как у формы
`../firtech/src/app/api/lead/route.ts`, плюс `estimate` из `leadSummary`; без токена сервер webhook не стартует).
- `agent.ts`: ответ сразу на языке клиента (кириллица: русский, иначе английский), не больше трёх вопросов (бизнес,
  задача, срок), два слота звонка (следующие рабочие дни, `SLOT_HOURS` в `TZ`), карточка владельцу
  (ниша, задача, срок, контакт, оценка горячий / тёплый / холодный), экспорт в `data/leads.jsonl`.
  Клиент молчит 24 часа: ежедневная задача 10:00 всё равно шлёт карточку с тем, что известно.
- Типы одобрений: `client_reply` (вопросы, дежурные ответы; старт на уровне `REPLY_LEVEL`, по умолчанию 1 по брифу)
  и `price_quote` (`locked`, всегда уровень 0). Вопрос о цене: клиенту сразу «уточняю с командой», владельцу
  предложение с черновиком; черновик с `[цена]` / `[срок]` не уходит клиенту, пока владелец не вставит цифры.
- Антиспам: `RATE_LIMIT_MESSAGES` на чат за `RATE_LIMIT_WINDOW_MIN`, боты игнорируются, группы игнорируются.
- LLM здесь только разметка полей (Haiku/fast, `tryJson`) и черновик ответа про цену (Sonnet/smart). Оценка лида
  считается правилами (`text.ts: scoreLead`), поэтому одинакова с LLM и без него.

## Данные и секреты
`.env*` и `data/` не коммитятся (в `data/` контакты клиентов). Секреты: `.env.local` (dev), `/opt/fir-agents/.env`
(сервер, 600). Секреты с `$` в `.env` брать в одинарные кавычки (compose раскрывает `$`).

## Docker и деплой (сервера пока нет)
- `apps/lead-intake/Dockerfile` собирается из корня репо (`-f apps/lead-intake/Dockerfile .`): не root, `tini`,
  `pnpm deploy --prod`. На Mac Docker нет, образ локально не собирали, его соберёт CI.
- `compose.yaml` (ставится в `/opt/fir-agents` скриптом bootstrap, root-owned, из CI не принимается):
  - `lead-intake`: `read_only`, `cap_drop ALL`, `no-new-privileges`, 512 МБ, 0.5 CPU, `pids_limit`, логи json-file
    10 МБ x 5, единственный порт `127.0.0.1:8787` (webhook, за nginx позже), `LLM_BASE_URL=http://omniroute:20128`.
  - `omniroute`: образ `diegosouzapw/omniroute`, только `agents-net`, портов наружу нет, `REQUIRE_API_KEY=true`,
    данные `/opt/fir-agents/data/omniroute`, лимит 1.5 ГБ. Секреты шлюза в `/opt/fir-agents/omniroute.env`
    (`.env` агента шлюзу не отдаём); `LLM_API_KEY` в `.env` агента = ключ, выпущенный в OmniRoute. Образ и имена
    его переменных (`PORT`, `DATA_DIR`, секреты) сверить с документацией OmniRoute при первом запуске; `:latest`
    закрепить на версию. Без `read_only`, пока не проверено, что образ так работает.
  - Плейсхолдеры `__AGENTS_UID__/__AGENTS_GID__` подставляет bootstrap.
- `deploy/bootstrap-vps.sh` (один раз, root на VPS: `sudo bash bootstrap-vps.sh "<ssh-ed25519 публичный ключ>"`):
  пользователь `agents`, дом `/opt/fir-agents`, данные `agents`-owned, всё решающее (compose, `bin/deploy.sh`,
  `authorized_keys`) root-owned. Ключ деплоя с `command="/opt/fir-agents/bin/deploy.sh",restrict`.
  `deploy/deploy.sh`: forced command, stdin = GHCR user и токен, `docker compose pull && up -d --remove-orphans`.
  Образцы: `../dono/deploy/`. Компоуз на VPS обновляется только повторным запуском bootstrap (изменение compose.yaml
  само не доезжает, образы обновляет deploy.sh).
- CI (`.github/workflows/ci.yml`): проверки на каждый push и PR, образ в GHCR (`agents-lead-intake`) только с `main`,
  деплой-job только при переменной репо `DEPLOY_ENABLED=true`; секреты `AGENTS_SSH_KEY`, `VPS_HOST`,
  `VPS_KNOWN_HOSTS` в Environment `production` (ограничен веткой main). Пока `DEPLOY_ENABLED` не выставлен, деплоя нет.
- Не пушить без решения владельца: репо на GitHub ещё не создан.
