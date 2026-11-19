# @fir/worker-publisher: Публикатор (этап 1, ручная публикация)

Исполнитель отдела маркетинга. Собирает пакеты публикации из одобренных материалов Контент-мейкера (`cm_ready`) и
хранит отметки «Опубликовано» в `pb_posts` (`ready_id`, `item_id`, `platform`, `sent_on`, `published_at`). Сам никуда не
пишет и ничего не публикует.

## Поток
1. Рутина `marketing-daily-today` (09:00). Голова запускает Публикатор: он берёт одобренные и не опубликованные строки
   `cm_ready`, чья плановая дата наступила (просроченные тоже, с пометкой).
2. Сначала одна строка дня («Сегодня публикуем: 1 рилс, 1 пост, 1 история. Картинок к отправке: 4.», `dayHeader`), потом материалы в порядке
   рилс, пост, карусель, история. Если у материала есть PNG (`cm_ready.files`, рисуются при одобрении), перед текстом уходит альбом
   (`Messenger.sendPhotos`, до 10 в группе): владелец пересылает его в Instagram. Затем на материал одно инфо-сообщение (без одобрения): подпись и хэштеги каждой платформы, строка о
   файле и по кнопке «Опубликовано: Instagram / TikTok / Shorts». Не удалось отправить альбом или картинки не нарисованы: текст всё равно уходит с пометкой. Это единственное личное сообщение головы, и оно не
   требует решения: оно заменяет утреннюю строку «что публикуем». В тему отдела уходит текстовый отчёт.
3. Владелец публикует руками (видео пока делает человек по сценарию), нажимает кнопку: пишется `published_at` и
   платформа, строка `cm_ready` получает статус `published`. Повторное нажатие ничего не меняет.
4. Не отмеченное напоминается на следующий день (один раз в сутки на материал).

## Видео рилсов
Если у рилса есть `DATA_DIR/renders/<материал>/reel.mp4` (`RenderLookup`), голова шлёт его `sendVideo` (до 49 МБ) с подписью и кнопками «Опубликовано»
(полный текст вместе с видео, если влезает в 1024 знака, иначе короткий заголовок, а текст с кнопками следом). Нет файла: уходит текст как раньше с
пометкой «видео не собралось: <причина>» или «ещё собирается» (`RenderNote`), задача рендера ставится заново на следующий прогон. Команда Директора `/render <id>`.

## Этап 2: YouTube Shorts публикуются сами (2026-11-20)
`YouTubePoster` (`src/youtube.ts`, `PlatformPoster` для платформы `shorts`). Утром (`daily`) до сообщений владельцу `PublisherWorker.autoPublish`
берёт каждый одобренный Shorts с датой «сегодня или раньше», у которого есть MP4 (`DATA_DIR/renders/<материал>/reel.mp4`), и грузит его на YouTube
(resumable upload: сессия `POST .../upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, потом весь MP4 одним `PUT`, таймаут 60 с).
Успех: `pb_posts.published_at` и `pb_posts.url`, строка `cm_ready` становится `published`, в утреннем сообщении строка «YouTube: опубликовано, <ссылка>»,
карточки Instagram и TikTok приходят как раньше. Нет MP4 или рендер не удался: Shorts идёт ручным путём как до этого. Другие платформы не затронуты.

Окружение (всё необязательное, без него ручной поток как раньше):
- `YT_OAUTH_CLIENT_JSON`: JSON клиента Google «Desktop app» одной строкой (`installed.client_id`, `installed.client_secret`);
- `YT_REFRESH_TOKEN`: refresh token, получается один раз командой `pnpm --filter hq yt-auth` (печатает ссылку согласия, читает код со stdin, показывает только длину и sha256-префикс токена, сам токен кладёт в буфер обмена macOS);
- `YOUTUBE_CHANNEL_ID`: как и раньше (аналитика); `YT_PRIVACY`: `public` (по умолчанию), `unlisted` для проб, `private`.
Токены в логи и в тексты ошибок не попадают. Сроки: у проекта Google в режиме Testing refresh token живёт 7 дней, переведите приложение в Production.
Непроверенный проект Google грузит видео только приватными до аудита (см. таблицу ниже).

Квота: загрузка стоит 1600 из 10 000 единиц в сутки. Счётчик в `pb_quota` (`date`, `units`), единицы списываются до загрузки (неудачная тоже считается).
Выше 9000 за день загрузка не начинается: остальное идёт ручным путём, в шапке дня строка «YouTube: квота на сегодня исчерпана». Если у плана есть будущее время (`publishAt`),
видео грузится `private` с `publishAt` (правило API); сейчас у плана только дата, поэтому публикуется сразу.

Сбой выглядит так: одна попытка на строку в сутки (`pb_posts.auto_on`), без повторов вслепую; сессия сбрасывается, строка остаётся `ready`, причина в
`pb_posts.error`, в карточке материала приписка «YouTube: автозагрузка не удалась (<причина>). Публикуйте Shorts вручную.», кнопка «Опубликовано: Shorts» работает. Следующим утром одна новая попытка.
Проба: `YT_PRIVACY=unlisted`, один одобренный клип, проверить ссылку, потом вернуть `public`.

Аналитик (еженедельный отчёт): при `YT_REFRESH_TOKEN` читает `channels?part=statistics&mine=true` и `videos?part=statistics` по роликам недели (из `pb_posts.url`) и
добавляет «YouTube за неделю: N Shorts, X просмотров, Y подписчиков (+Z)». Без токена работает путь по `YOUTUBE_API_KEY`.

## Этап 2: Instagram через Meta Graph API
Рилсы, посты, карусели (2-10 PNG) и истории публикуются утром сами (`InstagramPoster`), если заданы `IG_USER_ID` и `IG_ACCESS_TOKEN`; без них ручной поток как раньше.
Окружение (всё необязательное):
- `IG_USER_ID`: id профессионального аккаунта Instagram; `IG_ACCESS_TOKEN`: долгоживущий токен пользователя (60 дней), уходит только в заголовок `authorization`, в логи и ошибки не попадает;
- `IG_PUBLIC_BASE`: публичная база файлов, `https://firtech.pro/media` (Graph API сам скачивает PNG и MP4 по URL; без неё причина «нет публичного URL файлов», материал остаётся ручным);
- `MEDIA_SECRET` (иначе `WEB_CHAT_TOKEN`): секрет подписи ссылок; `IG_TOKEN_ISSUED_AT` (дата выпуска токена, `2026-11-20`): предупреждение за 7 дней до конца.
Права токена: `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments`, `pages_show_list`.

Публичные ссылки на файлы: `GET /media/<подпись>/<путь>` на вебхук-сервере HQ. Подпись = HMAC-SHA256(секрет, путь) в hex, 32 знака; отдаются только PNG/JPG/MP4 из `DATA_DIR/renders`
с `cache-control: public, max-age=3600`; чужая подпись, `..`, симлинк наружу, другое расширение: 404. nginx на сервере (в блок `firtech.pro`, до `location /`):
```
location /media/ {
    proxy_pass http://127.0.0.1:8787/media/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 120s;
}
```
Потом `sudo nginx -t && sudo systemctl reload nginx`. Проверка: ссылка из лога или `curl -I https://firtech.pro/media/0000/x.png` отвечает 404 от HQ (JSON), не 502.

Как публикуется. Рилс: `POST /{IG_USER_ID}/media` (`media_type=REELS`, `video_url`, `caption`, `share_to_feed=true`), опрос `GET /{container}?fields=status_code` каждые 10 с до `FINISHED` (до 5 минут),
`POST /media_publish`, ссылка из `GET /{media}?fields=permalink`. Не успело за запуск: id контейнера в `pb_posts.container_id`, строка завершается при следующем запуске (новый контейнер не создаётся),
в шапке дня «видео обрабатывается». Пост: `image_url` без `media_type`. Карусель: контейнеры-дети (`is_carousel_item=true`), затем `media_type=CAROUSEL` с `children`. История: `media_type=STORIES` на каждый кадр.
Лимит: `GET /{IG_USER_ID}/content_publishing_limit` перед постом; с 45 из 50 за 24 часа публикация не начинается (остальное вручную, строка в шапке). Одна попытка на материал в сутки (`pb_posts.auto_on`),
ошибка в `pb_posts.error`, в карточке «Instagram: автопубликация не удалась (<причина>). Публикуйте вручную.». `media_id` в `pb_posts.media_id` (для статистики и комментариев).

Утренний прогон `InstagramDaily`: `GET /me?fields=id` проверяет токен. Ответ 400/401/403 (ядро не отдаёт тело ошибок GET, поэтому код 190 виден по статусу) = токен истёк: владельцу раз в сутки
«Токен Instagram истёк: обновите в чеклисте (скрытое окно)»; при `IG_TOKEN_ISSUED_AT` предупреждение за 7 дней. Комментарии к публикациям последних 7 дней (`GET /{media}/comments`) падают в `pb_comments`
(`id`, `media_id`, `username`, `text` до 500, `at`, `replied=0`), в шапке дня «Комментарии в Instagram: N новых» и первые три. Ответы через голову Поддержки позже (TODO, колонка `replied` готова).

Аналитик (недельный отчёт): `GET /{IG_USER_ID}/insights` (`reach,profile_views,accounts_engaged`, `period=day`, `metric_type=total_value`), `followers_count`, `media_count` и по каждой публикации недели
`insights` (`views,reach,likes,comments,shares,saved`; `plays` в API заменён на `views`). Строка «Instagram за неделю: N публикаций, охват X, подписчиков Y (+Z), лучший ролик: <ссылка> (V просмотров)».
Снимок подписчиков в `pb_ig_stats`, дельта к снимку недельной давности.

Продление токена (раз в ~50 дней, владелец; токен кладёт главное окно через скрытое окно, не в чат):
1. developers.facebook.com, приложение, Tools, Graph API Explorer: выбрать приложение, «Generate Access Token» с правами выше (короткий токен живёт 1 час).
2. Обмен на долгоживущий: `GET https://graph.facebook.com/v23.0/oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>&client_secret=<APP_SECRET>&fb_exchange_token=<короткий токен>`
   (в браузере или curl на своём компьютере), в ответе `access_token` на 60 дней.
3. Отдать токен главному окну (поле «Токен Instagram» в чеклисте, скрытое окно), там же дату выпуска для `IG_TOKEN_ISSUED_AT`. `IG_USER_ID`: Graph API Explorer, `GET me/accounts?fields=instagram_business_account`.
Первое подключение: аккаунт Business или Creator, привязанный к Facebook Page; в режиме разработки приложение публикует только для ролей приложения (App Review для остальных).

Остальное по платформам (сети нет, ручной путь):

| Платформа | Нужно |
|---|---|
| Instagram (Graph API, Reels и карусели, сделано) | профессиональный (Business или Creator) аккаунт, привязанный к Facebook Page; приложение на developers.facebook.com с продуктом Instagram Graph API; разрешения `instagram_content_publish`, `instagram_basic`, `pages_show_list`; долгоживущий токен; для боевого режима App Review |
| YouTube Shorts (сделано) | проект в Google Cloud, YouTube Data API v3, OAuth client (Desktop или Web), один раз согласие владельца канала со scope `youtube.upload`; непроверенные приложения грузят видео только как приватные до аудита |
| TikTok | аккаунт на developers.tiktok.com, приложение с продуктом Content Posting API, scope `video.publish`; прямой постинг требует аудита приложения, до него только режим черновиков (`video.upload`) |

Любой другой `PlatformPoster` работает только после одобрения материала и сообщает о результате через голову.
