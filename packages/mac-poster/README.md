# @fir/mac-poster

Публикатор Instagram на Маке владельца. Meta не даёт нашему приложению публиковать без проверки бизнеса (нужно юрлицо),
поэтому одобренные материалы публикует этот помощник: он открывает instagram.com в настоящем Chromium с профилем, в который
владелец один раз вошёл руками, и проходит обычные шаги «Создать → файлы → Далее → подпись → Поделиться».
**Только Mac: пакета нет в Docker-образах, на сервере он не запускается.** HQ остаётся главным: одобрения, файлы и отметки
«Опубликовано» живут там, помощник только читает `GET /admin/content`, качает `GET /admin/files/*` и отчитывается
`POST /admin/content/:id` (`published` с `url` или `failed` с причиной).

## Как устроено
- **Связь с HQ.** HQ слушает только `127.0.0.1:8787` на сервере. На время запуска помощник сам поднимает
  `ssh -N -L 127.0.0.1:18787:127.0.0.1:8787 -i ~/.ssh/id_ed25519_firtech root@201.79.122.133` и в конце его закрывает.
  Если на порту уже есть туннель, использует его и не трогает.
- **Что публикует.** Материалы Instagram (рилс, пост, карусель, история) со статусом `approved`/`ready`, днём по плану не позже
  сегодняшнего (берёт текущую и прошлую неделю), ещё не опубликованные в Instagram и с файлами. Порядок: рилсы, карусели, посты,
  истории. Не больше 6 за запуск (`--limit`) и 10 в сутки (`MP_DAILY_CAP`). Каждый материал пробуется один раз в день.
- **Истории.** В десктопной версии загрузки историй нет. Помощник открывает вкладку того же профиля в режиме iPhone и ищет
  «Ваша история». Не нашлось за 20 с: материал уходит в HQ как `failed` с причиной «вручную: …», карточка в Telegram остаётся.
- **Остановки.** «Подтвердите, что это вы», подозрительный вход, «Повторите попытку позже», «Действие заблокировано» или
  страница входа: запуск останавливается, материал не помечается ошибкой (повторится в следующий раз), на Маке всплывает уведомление.
- **Двойная публикация.** Если «Поделиться» нажато, а подтверждения нет, материал помечается «застрявшим» в `state.json` и
  сам больше не пробуется: проверьте профиль руками и нажмите «Опубликовано» в Telegram или Пульте.
- Паролей помощник не знает и не вводит. Пауза 1–4 с между шагами, случайная задержка до 10 минут при запуске по расписанию,
  одно окно браузера, второй экземпляр не запустится (lock-файл).

## Установка (один раз)
1. В клоне репозитория: `pnpm install`.
2. Chromium для Playwright: если `~/Library/Caches/ms-playwright/chromium-1255` нет, `pnpm --filter mac-poster exec playwright install chromium`.
3. Файл `~/.fir-mac-poster.env` с правами 600 (`chmod 600 ~/.fir-mac-poster.env`, иначе помощник откажется запускаться):
   ```sh
   MP_ADMIN_TOKEN=<ADMIN_TOKEN из env HQ на сервере>
   # необязательно:
   # MP_SSH_TARGET=root@201.79.122.133
   # MP_SSH_KEY=~/.ssh/id_ed25519_firtech
   # MP_LOCAL_PORT=18787
   # MP_IG_USERNAME=firtech.pro   # если имя не прочиталось при входе
   # MP_LIMIT=6
   # MP_DAILY_CAP=10
   ```
   Ключ SSH должен работать без вопросов (`BatchMode`): если на ключе пароль, добавьте его в связку ключей
   `ssh-add --apple-use-keychain ~/.ssh/id_ed25519_firtech`.
Команды пакета начинаются с `ig:` (`ig:login`, `ig:run`, `ig:install-launchd`, `ig:uninstall-launchd`): голые `login` и `run` совпадают со
   встроенными командами pnpm (`pnpm --filter mac-poster login` запускал `npm login`, 2026-11-20). Сам CLI по-прежнему понимает `instagram` и `run instagram`.
4. Вход: `pnpm --filter mac-poster ig:login`. Откроется окно Chromium с instagram.com, войдите руками (логин, пароль, код).
   Когда видна лента, окно закроется само, профиль сохранён в `~/Library/Application Support/fir-mac-poster/instagram`.
5. Пробный прогон без публикации: `pnpm --filter mac-poster ig:run --dry-run` (печатает план: что, в каком порядке, сколько файлов).
6. Настоящий запуск: `pnpm --filter mac-poster ig:run` (окно видно; `--headless` без окна, `--limit N`, `--date YYYY-MM-DD`).
7. Расписание: `pnpm --filter mac-poster ig:install-launchd` ставит `~/Library/LaunchAgents/pro.firtech.mac-poster.plist`:
   10:00, 14:00 и 19:00 по часам Мака (Куала-Лумпур). Убрать: `pnpm --filter mac-poster ig:uninstall-launchd`.
   Мак в это время должен не спать: «Настройки → Аккумулятор/Энергосбережение → не переходить в сон при подключении к сети»
   или `caffeinate -dims` в отдельном окне Терминала. Пропущенный из-за сна запуск launchd выполнит при пробуждении.
   После переезда клона (`git clone` в другое место) расписание нужно поставить заново.

## Agent Reach для агентов (reach:*), 2026-11-21
Тот же помощник на Маке выполняет задания Agent Reach (`~/Agent-Reach`, MIT, `agent-reach` в `~/.local/bin`) для агентов: субтитры и данные YouTube для Трендвотчера, Reddit и LinkedIn для Разведчика, публичные цифры чужих каналов для Аналитика, чтение страниц для Контент-мейкера. В контейнере HQ нет браузера и Python, поэтому агент кладёт задание в очередь HQ (`ctx.tools.reach`), а Мак забирает его по тому же SSH-туннелю и тому же `~/.fir-mac-poster.env` (`MP_ADMIN_TOKEN`, `MP_SSH_*`).
```sh
pnpm --filter mac-poster reach:status            # каналы Agent Reach (состояние, нужен ли вход) и очередь HQ
pnpm --filter mac-poster reach:now               # один запуск сейчас (то же, что reach:run)
pnpm --filter mac-poster reach:run [--limit N]   # один запуск: забрать очередь, выполнить, ответить (до 20 заданий, N 1..10)
pnpm --filter mac-poster reach:install-launchd   # расписание pro.firtech.reach: каждые 15 минут
pnpm --filter mac-poster reach:uninstall-launchd
```
- Запуск: поднимает туннель (как `ig:run`), читает `agent-reach doctor` и сообщает HQ, какие каналы настроены, берёт `GET /admin/reach/jobs?status=queued`, для каждого задания `claim` (409: взял другой запуск), `agent-reach <канал> <действие> ... --timeout 105` без shell, жёсткий предел 120 с (`MP_REACH_TIMEOUT`), ответ `POST .../result`. Не больше 20 заданий за запуск (`MP_REACH_MAX`), по одному, второй запуск не стартует (`~/Library/Application Support/fir-mac-poster/reach.lock`). Логи: `~/Library/Logs/fir-mac-poster/run-reach-YYYY-MM-DD.log` и `launchd.log`.
- Что в JSON от CLI берётся как данные: `ok`, `items`, `meta`, `error`; ничего оттуда не исполняется. Аргументы собираются только по таблице `src/reach/spec.ts` (известные каналы и действия, значение не начинается с `-`, без управляющих знаков); задание не из таблицы получает ответ `failed` с причиной.
- Без входа работают YouTube (поиск, карточка, субтитры; `transcribe` нужен ключ Groq: `agent-reach configure groq-key`), веб, GitHub, Reddit. **Instagram и X**: владелец сам делает на Маке `agent-reach add instagram`, затем `agent-reach login instagram` (откроется окно, вход руками, отдельным аккаунтом, не основным), так же `twitter`. Пока это не сделано, Мак не сообщает канал HQ, и HQ не ставит туда задания; задание, пришедшее раньше, закончится ответом CLI `NEED_LOGIN` как `failed`. LinkedIn: `agent-reach add linkedin` и `agent-reach login linkedin`.
- `agent-reach` ищется в `~/.local/bin/agent-reach` (другое место: `MP_AGENT_REACH`); в расписании этот каталог добавлен в `PATH`. Мак в нужное время должен не спать (как для `ig:install-launchd`): пропущенный запуск launchd выполнит при пробуждении, а задание, которое Мак не взял за 6 часов, HQ закрывает как `failed`, агент идёт дальше без него.

## Логи и скриншоты
- `~/Library/Logs/fir-mac-poster/run-YYYY-MM-DD.log`: каждый запуск, план, итог.
- `~/Library/Logs/fir-mac-poster/launchd.log`: вывод запусков по расписанию.
- `~/Library/Logs/fir-mac-poster/<id материала>-<шаг>.png`: скриншот окна на шаге, где что-то сломалось
  (`create`, `files`, `crop`, `next-1`, `next-2`, `caption`, `processing`, `share`, `share-result`, `story-1-upload`…).
- `~/Library/Application Support/fir-mac-poster/state.json`: счётчик за день, попытки, «застрявшие» материалы, имя аккаунта.
  Чтобы помощник снова попробовал застрявший материал, удалите его номер из `stuck`.
- В HQ: у материала в Пульте `error` с причиной или `publishedUrl`; в утренней сводке строка «Instagram с Мака: опубликовано N, ошибок M».

## Когда Instagram меняет вёрстку
Все надписи и селекторы собраны в начале `src/instagram/web.ts` (объект `T`, `CROP_ICON`, `NEW_POST_ICON`, `LOGGED_IN`) на русском
и английском. Порядок починки: найти по логу шаг и открыть его скриншот, запустить `pnpm --filter mac-poster ig:run --limit 1`
и посмотреть в окне, как теперь называется кнопка (или в DevTools, `aria-label`), поправить регулярное выражение в `T`, прогнать
`pnpm --filter mac-poster test`. Тексты остановок (проверка входа, лимиты) в `src/guards.ts`.

## Добавить TikTok
`src/site.ts` описывает сайт (`start`, `post`, `close`). Второй сайт: свой класс рядом с `src/instagram/web.ts` с профилем
`~/Library/Application Support/fir-mac-poster/tiktok`, своя команда в `src/cli.ts`, отбор материалов по `platform` и отчёт в HQ с
`platform: 'tiktok'` (HQ уже принимает `failed`/`url` для любой платформы материала).

## Проверки
`pnpm --filter mac-poster typecheck`, `pnpm --filter mac-poster test` (без сети и браузера; `tests/reach.test.ts`: заглушка `agent-reach` на shell и поддельный HQ по HTTP; без сети и браузера: отбор и порядок, недели, план
сухого прогона, счётчик и лимит, lock, разбор ссылок, клиент HQ на подменённом fetch, туннель на подменённом ssh, plist).
Настоящий instagram.com тестами не проверяется: первый запуск после `ig:login` всегда `--dry-run`, затем `--limit 1`.
