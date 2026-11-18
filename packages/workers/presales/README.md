# @fir/worker-presales

Пресейл: лид (`li_leads`) или текст владельца в КП, смету и черновик договора (Markdown, русский, `ps_documents`).
Цены только из `src/offers.ts`; модель пишет формулировки с метками `[цена]` и `[срок]`, шаблоны `templates/*.md` их подставляют.
Одно одобрение `presales_pack` (уровень 0, locked). Настройки: `PREPAYMENT_PERCENT`, `KP_VALID_DAYS` (передаёт `apps/hq`).
Тесты: `pnpm --filter @fir/worker-presales test`.
