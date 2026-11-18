# @fir/worker-referral

Рекомендации: `rf_referrals`, статусы proposed, paid, rewarded. Награда (`REFERRAL_REWARD`) только после оплаты реферала
(`/paid <id>`), через одобрение `referral_reward` (уровень 0, locked). Напоминания для утренней сводки: действие `reminders`.
Тесты: `pnpm --filter @fir/worker-referral test`.
