# Ops: чистка тестовых данных Пульта и проект zakup (2026-11-26)

Два разовых скрипта в `apps/hq/src` (компилируются в `dist/` образа hq, как `fresh-start.js`): `shell-cleanup.ts` и `seed-zakup-project.ts`.
БД `hq.db` доступна только изнутри контейнера (том `/opt/fir-agents/data/hq` -> `/app/data`, корень контейнера read-only), поэтому все команды идут через `docker compose` в `/opt/fir-agents`. Путь БД: `$DATA_DIR/hq.db` (`/app/data/hq.db`), переопределяется `--db <path>`. Файлы отчёта и бэкапа пишутся в `/app/data` (на хосте `/opt/fir-agents/data/hq/`), потому что другие каталоги в контейнере только для чтения.

## 1. Чистка (shell-cleanup)

Сухой прогон (ничего не пишет в БД, HQ можно не останавливать):

```
cd /opt/fir-agents
docker compose exec hq node dist/shell-cleanup.js --out /app/data/shell-cleanup-report.json
```

Печатает две таблицы и пишет отчёт: A = точно тест (id, тип, название, причина, полные строки и дочерние строки для отката), B = сомнительное (id, тип, почему). В A попадает только явное: почта на example.com/.test/.invalid, e2e, «тестовый», заголовок с «Тест:/Test:/Учения:», тег `drill`, фикстуры «Алиса/Боб/Alice/Bob» без реального контакта, строки тест-клиентов и тест-проектов. Слабые совпадения («demo», «test» внутри слова), маркер рядом с реальным контактом, работающие задачи, оплаченные этапы, подписанные документы идут в B и этим скриптом не удаляются.

Типы: `task` (с событиями, согласованиями, подзадачами), `lead` (li_leads), `client` (cab_clients с сообщениями, ветками, загрузками), `cs_client` (с тикетами), `project` (pm_projects с этапами), `document` (cab_documents с подписями и PDF из `renders`), `bo_document`.

Применить (после того как владелец посмотрел отчёт): оставить в файле только нужные id. Формат: JSON-массив `[{"type":"task","id":12},...]`, строки `"task:12"`, сам отчёт целиком, или текст по строке `task:12` (`#` комментарий).

```
docker compose exec hq node dist/shell-cleanup.js --apply --ids /app/data/shell-cleanup-ids.txt
```

(файл с id сначала положить в `/opt/fir-agents/data/hq/shell-cleanup-ids.txt`). Правила: id должен быть в A по свежему пересчёту; любой id из B или неизвестный = отказ целиком, ничего не удалено. Сначала пишется бэкап `/app/data/hq.db.shell-cleanup-<время>.json` (полные строки, включая дочерние; если запись не удалась, отказ), затем одна транзакция в безопасном порядке и одна строка в `activity` (`shell_cleanup`). Печатает число удалённых по типам. Дочерние строки удаляются вместе с родителем; документ, клиент или лид, которых нет в списке, остаются. Чтобы не оставить сирот, применяйте весь A за один раз.

Откат (INSERT OR IGNORE, можно повторять):

```
docker compose exec hq node dist/shell-cleanup.js --restore /app/data/hq.db.shell-cleanup-<время>.json
```

PDF-файлы документов из `renders` удаляются вместе со строками и из бэкапа не восстанавливаются (HQ пересоберёт PDF из текста документа). Файлы клиентских загрузок (`uploads/`) не удаляются, удаляются только их строки (имена видны в бэкапе).

Применять можно и при работающем HQ (SQLite WAL, таймаут блокировки 5 с); если хочется полной тишины: `docker compose stop hq`, затем `docker compose run --rm --no-deps hq node dist/shell-cleanup.js ...`, затем `docker compose up -d hq`.

## 2. Проект zakup (seed-zakup-project)

```
cd /opt/fir-agents
docker compose exec hq node dist/seed-zakup-project.js --dry-run
docker compose exec hq node dist/seed-zakup-project.js [--today 2026-11-26] [--tz Asia/Dushanbe]
```

Создаёт один `pm_project` (`what` = «ИИ-агент госзакупок zakup.gov.kz», `source=owner`, `status=draft`, `product=automation`, клиент-текст «Знакомый владельца (zakup)»; отдельной строки клиента схема не требует), пять этапов `pm_milestones` (`kind=stage`, `stage_no` 1-5, сроки накопительно от сегодняшнего дня, `amount_usd` пусто) и задачу «Созвон с клиентом: заметки» (отдел `production`, срок сегодня 23:59 по часам HQ, `--today` по умолчанию сегодня в `settings.tz`). Предложение с ценами и оплатой 20/50/30 лежит только в тексте `spec` и помечено «не утверждено владельцем». Повторный запуск печатает id и ничего не делает (поиск по точному названию). Код агента: `~/fir-tech/zakup-agent` (только заметка).

Схема не хранит доли оплаты по этапам: у `pm_milestones` есть `amount_usd`, но не процент, поэтому 20/50/30 только в `spec`.
