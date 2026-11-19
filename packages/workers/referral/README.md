# @fir/worker-referral

Рекомендации: `rf_referrals`, статусы proposed, paid, rewarded. Награда (`REFERRAL_REWARD`) только после оплаты реферала
(`/paid <id>`), через одобрение `referral_reward` (уровень 0, locked). Напоминания для утренней сводки: действие `reminders`.
Выплата рекомендателю (2026-11-19): когда первый счёт лида с меткой `ref:<имя>` оплачен, `ReferralWorker.requestPayout` записывает сумму (10% сметы в USD, `payoutAmount`) и контакт
рекомендателя, а голова ставит одобрение `referral_payout` (`locked`, кнопки «Отклонить» и «Выплатил»: «Выплатил» переводит реферал в `rewarded`, система денег не двигает).
Выплата, которую ждут 7 дней и больше, попадает в напоминание (действие `reminders`, раз в 7 дней), `/referrals` показывает её в разделе «К выплате». Столбцы `payout_*` в `rf_referrals`.
Тесты: `pnpm --filter @fir/worker-referral test`.
