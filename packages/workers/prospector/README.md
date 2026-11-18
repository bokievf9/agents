# @fir/worker-prospector: Разведчик (исполнитель отдела продаж)

Бывший `apps/prospector` без бота и крона: исполнитель под головой Продаж (`apps/hq/src/heads/sales.ts`). Логика и тесты
сохранены. Отправляет бизнесам владелец сам, исполнитель только готовит.

`ProspectorWorker.run(task, ctx)`, действия (`task.meta.action`):
- `batch`: до `meta.limit` (по умолчанию `batchSize`) новых бизнесов по приоритету ниш (учебные центры, магазины, салоны и
  стоматологии, доставка и кафе, резерв); черновик первого сообщения: LLM со строгим JSON, проверка (цена ровно из `offers.ts`,
  один вопрос, нет других сумм и длинных тире), иначе шаблон.
- `followups`: закрывает молчунов (`no_reply` на 10-й день после отправки) и готовит дожимы через 3 и 7 дней.
- `reply`: бизнес ответил (`meta.prospectId`, `meta.replyText`), черновик ответа со слотами 11:00 и 15:00, без цен (`[цена]`).

Каждый черновик идёт в `ctx.requestApproval` (типы `prospect_first`, `prospect_followup`, `prospect_reply`, все `locked`).
Кнопки карточки: `cardButtons` (Скопировать `pc:<id>:c`, Править, Пропустить, Отправлено), `kindSpecs` регистрирует голова,
`onDecision` возвращает бизнес в `skipped` или в очередь новых при сбое. Статусы: `new → proposed → sent → replied / no_reply / skipped`.
Таблица `pr_prospects` в общей SQLite HQ. Загрузка CSV: `ProspectStore.importCsv` (дедуп по «название + город»),
CLI `apps/hq`: `import-prospects <csv>`. Промпты: `prompts/*.md`. Цены `src/offers.ts` копируют `directions.ts`, правятся вручную.
