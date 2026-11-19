import type { ReelScript } from '@fir/worker-content-maker';

/** A sample reel for Studio and `render:sample` (same shape the content-maker approves). */
export const SAMPLE_SCRIPT: ReelScript = {
  title: 'Запись ночью',
  hook: 'Клиент пишет в 2 ночи. Кто ответит?',
  durationSec: 28,
  lang: 'ru',
  scenes: [
    { voice: 'Клиент пишет в два часа ночи. Вы спите, а заявка остывает.', subtitle: 'Заявка в 2:00 ночи' },
    { voice: 'Бот-администратор отвечает за секунды и предлагает свободные окна.', subtitle: 'Ответ за секунды' },
    { voice: 'Клиент выбирает время, получает подтверждение и напоминание, никто не переписывается вручную.', subtitle: 'Запись без переписки' },
    { voice: 'Утром мастер открывает календарь, и запись уже там. Это один из примеров сценария.', subtitle: 'Утром всё в календаре' },
  ],
  cta: 'Хотите так же? Напишите нам, ссылка в профиле.',
};
