# Launch-фильм Fir Tech

Вертикальный фильм 1080x1920, 30 к/с, 38 с (`LaunchFilm`) и нарезка на 15 с (`LaunchTeaser`) для Shorts и Reels. Код: `packages/renderer/src/launch/*`,
`packages/renderer/src/remotion/Launch.tsx`, `launch-ui.tsx`, `launch-office.tsx`. Текст только из фактов сайта, цифр нет, кроме «24/7».
Шрифты Onest и Unbounded, акцент лайм `#b5eb6a` на `#0a0d0b` (как у рилсов).

Рендер на Маке:
```sh
PIPER_BIN=<venv>/bin/piper PIPER_VOICES_DIR=<папка с ru_RU-denis-medium.onnx> pnpm --filter renderer render:launch
# packages/renderer/out/launch-ru.mp4 и launch-teaser-ru.mp4
pnpm --filter renderer render:launch --lang en          # EN: тот же монтаж, без голоса, субтитры горят
RENDER_NO_TTS=1 pnpm --filter renderer render:launch    # без Piper (длины берутся по тексту)
pnpm --filter renderer render:launch --music ~/track.mp3   # с лицензированным треком
pnpm --filter renderer preview                          # Studio: композиции LaunchFilm и LaunchTeaser
```
Параметры: `--lang ru|en`, `--only film|teaser`, `--out <папка>`, `--music <файл>` (или `LAUNCH_MUSIC`), `RENDER_SFX=off` убирает эффекты.

## Музыка
Трека в репозитории нет (лицензия). Пропс `musicPath` (путь внутри public, скрипт кладёт файл в `music/`) и `musicVolume` (0.35 по умолчанию) уже есть:
трек идёт всю длину, на входе 15 кадров нарастания, на выходе 24 кадра спада, под голосом громкость падает до 45 % (рампа 6 кадров с каждой стороны).
Владелец кладёт любой лицензированный трек и рендерит с `--music`. Эффекты при этом остаются на месте (-14 дБ к файлу), музыку приглушает голос, не наоборот:
earshot советует прижимать музыку на 3-6 дБ под голосом. Если трек громкий, снизить `musicVolume`. Правило earshot про музыку: выбирать трек первым и подгонять
склейки под доли, поэтому после выбора трека стоит сдвинуть длины битов в `src/launch/plan.ts` на целые такты.

## Голос
Piper `ru_RU-denis-medium`, реплики в `packages/renderer/scripts/launch-ru.txt` (секции `# hook`, `# problem`, `# bot`... `# cta`, `# teaser-cta`).
Реплика, не влезшая в бит, ускоряется (`--length-scale` до 0.8), иначе рендер пишет «OVERRUNS» в лог. Замер на Маке: русская Piper-реплика идёт около 16 знаков
в секунду при 0.8, поэтому реплики короткие (тест `launch.test.ts` держит этот предел). `24/7`, `ИИ`, `Mini App`, `Telegram`, `USDT`, `firtech.pro` произносятся
через словарь `launchSpeakable`. Английского голоса Piper в образе нет: `scripts/launch-en.txt` лежит готовым, EN-ролик собирается без голоса с горящими субтитрами; когда
появится модель, `PIPER_VOICE_EN=<имя>` включит её без правок кода.

## Сценарий по секундам (film, RU)
Склейка = «вжух» в сторону (смаз, наклон), новый бит приходит за 8 кадров. Субтитры горят в нижней трети (y 1330-1550), выше зоны интерфейса Instagram.

| Время | Бит | На экране | Голос | Звук |
| --- | --- | --- | --- | --- |
| 0.0-3.0 | Холодный старт | огромное «24/7», под ним «ИИ-агенты» и «вместо сотрудника» | ИИ-агенты вместо сотрудника. | удар (kick) на кадре 0, хлопок на кадре 10 |
| 3.0-8.0 | Проблема | чат: «Здравствуйте! Можно записаться?», точки набора, «Без ответа»; три строки: «Заявка пришла ночью.» «Ответа нет.» «Клиент ушёл.» | Заявка ночью. Ответа нет. Клиент ушёл. | свист на склейке, хлопок, тап на второй строке, удар (punch) на третьей |
| 8.0-10.9 | Бот-администратор | чат с записью: вопрос, ответ бота, три слота, выбранный слот | Бот записывает клиентов. | свист, хлопок на заголовке, тап на ответе бота |
| 10.9-13.7 | ИИ-приёмщик заявок | карточка «Новая заявка» набирается по полям, плашка «Менеджер получил заявку» | Приёмщик собирает заявки. | то же |
| 13.7-16.6 | Автоматизация | три узла «Заявка - Таблица - Сообщение в Telegram», огонёк бежит по линии | Автоматизация берёт рутину. | то же |
| 16.6-19.4 | Контент на автопилоте | сетка из четырёх постов, метки «Опубликовано», недельная полоска | Контент на автопилоте. | то же |
| 19.4-22.3 | Mini App | телефон с каталогом, кнопка «Заказать», «Заказ принят» | Mini App в Telegram. | то же |
| 22.3-25.1 | Личный агент | список «Почта, Календарь, Напоминания, Отчёт» со вставшими галочками | Почта, календарь, напоминания. | то же |
| 25.1-28.0 | Отдел из ИИ-агентов | «Директор» и четыре роли, линии расходятся | Целый отдел из ИИ-агентов. | то же |
| 28.0-33.0 | Доказательство | пиксельный офис, нарисованный кодом: шесть столов, мониторы, люди печатают, один идёт мимо окон, подпись «наш собственный офис», метка «24/7» | Наш собственный офис. Согласования приходят в Telegram. | удар (punch) на открытии, хлопок на подписи, риссер (на полу-скорости) к концу |
| 33.0-38.0 | CTA | вордмарк fir.tech, кнопка «Собрать в конструкторе», firtech.pro, плашки «Цена сразу», «Согласования в Telegram», «Гарантия на первом этапе», «Оплата в USDT» | Собери в конструкторе. Гарантия на первом этапе. | пик риссера за 6 кадров до удара (стоп-даун), удар kick на кадре 991, колокольчик (mallet) на логотипе, хлопок на кнопке |

Правила звука (из `~/earshot/docs/launch-video-sound.md`): звук с первого кадра; «вжух» пиком на склейке (+2 кадра, картинка ведёт); тап стоит на кадре, где в
интерфейсе что-то происходит; акценты только на ключевых местах (холодный старт, открытие офиса, CTA); риссер, пауза в 6 кадров, удар; без длинных хвостов.
Между началами двух эффектов не меньше 250 мс, при конфликте побеждает удар, потом колокольчик, свист, тап, хлопок. Звуки из банка earshot 0.4.1 (MIT), список в
`assets/sfx/CREDITS.md`.

## Teaser, 15 с
Холодный старт 0-3 (то же), бот-администратор 3-6, ИИ-приёмщик 6-9, отдел из ИИ-агентов 9-12, CTA 12-15 с голосом «Собери в конструкторе.» (адрес и плашки на экране).

## Серия постов запуска

### 1. Подпись к рилсу-анонсу
RU:
> Сотрудник, который не уходит домой. Мы собрали ИИ-агентов, которые работают 24/7: бот-администратор, приёмщик заявок, автоматизация, контент на автопилоте, Mini App, личный агент и целый отдел из агентов.
> Цену видно сразу в конструкторе, на первом этапе есть гарантия, оплата в USDT. Согласования приходят вам в Telegram.
> Собрать своё: firtech.pro (ссылка в шапке профиля)
> #ИИагенты #автоматизация #Telegram #бизнес

EN:
> An employee who never goes home. We built AI agents that work 24/7: an admin bot, a lead intake, automation, content on autopilot, a Mini App, a personal agent and a whole department of agents.
> The price shows right in the builder, the first stage has a guarantee, you pay in USDT. Approvals come to you in Telegram.
> Build yours: firtech.pro (link in bio)
> #AIagents #automation #Telegram #business

### 2. Карусель «Что умеет отдел из агентов» (7 слайдов)
1. Обложка: «Что умеет отдел из ИИ-агентов» и «24/7» крупно.
2. Бот-администратор: отвечает клиентам и записывает их.
3. ИИ-приёмщик заявок: собирает заявки и передаёт вам.
4. Автоматизация: берёт рутину на себя.
5. Контент на автопилоте: посты выходят без вас, вы согласуете в Telegram.
6. Личный агент и Mini App: почта, календарь, напоминания; каталог внутри Telegram.
7. Итог: «Соберите своего в конструкторе, цена сразу. firtech.pro». Подпись: «Сохраните, чтобы не потерять».

EN outline: 1 cover "What a department of AI agents can do" with 24/7; 2 admin bot answers and books; 3 AI intake collects requests and hands them to you; 4 automation takes the routine; 5 content on autopilot, you approve it in Telegram; 6 personal agent and Mini App; 7 "Build yours in the builder, the price is instant. firtech.pro". Caption: "Save it for later."

### 3. Сториз (5 кадров)
1. Видео: первые 3 секунды фильма и стикер «Запуск».
2. Опрос: «Заявка пришла ночью. Кто ответит?» Варианты «Я сам» и «Хочу, чтобы отвечал бот».
3. Скриншот конструктора с ценой, надпись «Цена сразу, без звонков».
4. Кадр офиса, надпись «Это наш собственный офис. Агенты работают там сейчас».
5. Кнопка-ссылка «Собрать в конструкторе», подпись «Гарантия на первом этапе. Оплата в USDT».

EN: 1 the first 3 seconds of the film with a "Launch" sticker; 2 poll "A request comes in at night. Who answers?" with "I do" and "I want a bot to"; 3 builder screenshot, "Instant price, no calls"; 4 the office frame, "This is our own office. The agents are at work right now"; 5 link button "Build it in the builder", "First-stage guarantee. Pay in USDT".

### 4. Тизер для блога
RU: заголовок «Мы открыли офис, где работают ИИ-агенты». Текст: «Fir Tech продаёт сайты, Telegram-ботов и автоматизацию. Теперь есть и отдел из агентов, который отвечает клиентам, собирает заявки и ведёт контент 24/7. Мы показываем его без монтажа: наш собственный офис на сайте живёт в реальном времени. Цену любого продукта сразу показывает конструктор, согласования приходят в Telegram, на первом этапе стоит гарантия. Читать дальше: firtech.pro».

EN: title "We opened an office where AI agents work". Text: "Fir Tech sells websites, Telegram bots and automation. Now there is also a department of agents that answers clients, collects requests and runs content 24/7. We show it as it is: our own office on the site runs live. The builder shows the price of any product at once, approvals come to Telegram, and the first stage carries a guarantee. Read on: firtech.pro".

### 5. Закреплённый комментарий
RU: «Что внутри: бот-администратор, ИИ-приёмщик заявок, автоматизация, контент на автопилоте, Mini App, личный агент, отдел из агентов. Цена сразу в конструкторе, гарантия на первом этапе, оплата в USDT: firtech.pro. Напишите в комментариях, какую рутину отдали бы агенту первой.»

EN: "What is inside: admin bot, AI lead intake, automation, content on autopilot, Mini App, personal agent, a department of agents. Instant price in the builder, a first-stage guarantee, pay in USDT: firtech.pro. Tell us in the comments which chore you would hand to an agent first."
