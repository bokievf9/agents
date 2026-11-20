# renderer: ролики для рилсов (Маркетинг, этап 2)

Сервис собирает вертикальные ролики без лиц (MP4, 1080x1920, 30 к/с, 15-40 с) из одобренных сценариев Контент-мейкера:
фон в цветах бренда, хук крупно первые 2,5 с, текст сцены пружиной, фразы-субтитры вровень с голосом, финальная карточка
«@firtech_bot · firtech.pro» и вордмарк `fir.tech`. Голос синтезирует Piper (русский, без сети). Ролик уходит владельцу в Telegram
утренним сообщением Публикатора до публикации.

## Как устроено
- **Очередь**: таблица `cm_render_jobs` в том же SQLite (`DATA_DIR/hq.db`), что у HQ: `item_id`, `kind` (`reel`), `status`
  (`queued/running/done/failed`), `attempts`, `error`, `created_at`, `started_at`, `finished_at`, `output_path`. Код очереди
  `RenderQueue` лежит в `packages/workers/content-maker/src/render-queue.ts` (его используют и HQ, и рендерер).
  SQLite с WAL между двумя контейнерами одного хоста и одного bind-mount работает (замки и `-shm` общие); на сетевой ФС не будет.
  Рендерер ставит `busy_timeout = 5000`.
- **HQ** (голова Маркетинга) кладёт задачу, когда владелец одобрил рилс, и по `/render <id>`. Если у утреннего пакета нет видео и
  задачи в работе нет, она ставится заново (повтор «в следующий прогон»).
- **Рендерер** каждые `RENDERER_POLL_SECONDS` (20) берёт самую старую `queued` (`claim` атомарный, второй `running` не бывает),
  делает озвучку каждой сцены и CTA, собирает ролик, пишет `DATA_DIR/renders/<материал>/reel.mp4` (через `reel.mp4.part.mp4`,
  потом `rename`) и путь в задачу. Сбой: до 2 попыток, потом `failed` с причиной. Лимит на задачу 10 минут (`RENDER_TIMEOUT_SECONDS`).
  При старте `running` от упавшего процесса считается неудачной попыткой. Процесс один (один контейнер).
- **Тайминг**: сцена = max(длина WAV + 0,4 с, секунды сценария на сцену); секунды сценария делятся поровну между сценами за вычетом
  карточки CTA (не короче 3 с и не короче голос CTA + 0,4 с). Короткий ролик растягивается до 15 с последней сценой. Субтитры: фразы
  по предложениям и запятым до 5 слов, время пропорционально числу знаков по длине WAV сцены (без Whisper).
- **Сценарий** читается из текста материала (`parseReel`: «Клип, 28 с», «Хук», «N. Голос / Субтитр», «CTA»). Правки владельца вручную,
  сломавшие формат, дают `failed` с пометкой «не нашёл сцен». Язык по доле кириллицы: английский сценарий собирается без голоса
  (установлен один русский голос), субтитры по секундам сценария.
- **Шрифты**: Onest и Unbounded из `packages/workers/content-maker/assets/fonts` (OFL), сетевых шрифтов нет. Ни лиц, ни фото, ни стока.
- **Размер**: битрейт видео 3 Мбит/с + AAC 128 кбит/с, 40 с около 16 МБ (лимит бота 50 МБ, HQ не шлёт файл больше 49 МБ).

## Звуковые эффекты (2026-11-21)
Под голосом лежит слой из трёх коротких эффектов (`src/sfx.ts`, файлы `assets/sfx`, происхождение и лицензия в `assets/sfx/CREDITS.md`):
свист (`whoosh_fast/whip`) на каждой смене сцены, мягкий хлопок (`ui_pop/soft`) через 5 кадров после появления текста сцены и хука, удар
(`cut_hit/kick`) на финальной карточке. Громкость -14 дБ к файлу (файлы нормированы на пик -1 дБFS), между началами двух эффектов не меньше
250 мс (при конфликте выигрывают удар, затем свист, затем хлопок). Пик каждого эффекта ставится на событие в кадре (свист пиком на склейку).
Всего в `assets/sfx` двенадцать звуков (48 кГц моно, около 0,5 МБ): остальные девять запасные (стук, удар, шорох, нарастание, уведомление, затвор,
челеста, глитч). Звуки сделаны из банка earshot 0.4.1 (MIT) командой `earshot sfx render <id> -o x.wav --sr 48000` и переведены ffmpeg в 16 бит.
Выключить: `sfx: false` в параметрах задачи (`RenderOptions.sfx`) или `RENDER_SFX=off` у сервиса; без папки `assets/sfx` ролик собирается без эффектов.
Проверено на Mac: `RENDER_NO_TTS=1 pnpm render:sample` даёт AAC-дорожку с эффектами в нужные секунды (0,13; 2,4; 6,2; 12,4; 19,5; 25,8 с).

## Голос и лицензия
Piper `piper-tts` 1.8.0 (GPL-3.0-or-later; запускается отдельным процессом, наш код его не линкует), голос `ru_RU-denis-medium`
(rhasspy/piper-voices, закреплён коммит `04ca88f5`, файлы проверяются по sha256 при сборке образа). Датасет голоса: CC0
(`OHF-Voice/voice-datasets`), репозиторий голосов MIT. Запасной: `ru_RU-irina-medium` (лицензия датасета в карточке «Unknown»,
для коммерческого канала не брать). Колёса Python закреплены хэшами в `docker/piper-requirements.txt`.

## Переменные
| Переменная | По умолчанию | Смысл |
| --- | --- | --- |
| `DATA_DIR` | `./data` | общий том HQ: читает `hq.db`, пишет `renders/` |
| `RENDERER_POLL_SECONDS` | `20` | период опроса очереди |
| `RENDER_TIMEOUT_SECONDS` | `600` | лимит на одну задачу |
| `RENDER_CONCURRENCY` | `2` | вкладок Chromium на один рендер (при памяти 1,5 ГБ не поднимать выше 2) |
| `RENDER_SFX` | `on` | `off`: без слоя звуковых эффектов |
| `RENDER_NO_TTS` | пусто | `1`: без Piper, длины сцен из сценария (локальная проверка) |
| `PIPER_VOICE` | `ru_RU-denis-medium` | имя голоса, модель `<PIPER_VOICES_DIR>/<имя>.onnx` |
| `PIPER_VOICES_DIR`, `PIPER_BIN` | `/opt/piper/voices`, `piper` | в образе заданы; локально указать на свой venv |

HQ: `REELS_RENDER=off` выключает очередь (одобренный рилс тогда уходит старым путём, задачей `builder`).

## Локально (Mac)
```sh
pnpm --filter renderer preview            # Remotion Studio с примером сценария
pnpm --filter renderer render:sample      # packages/renderer/out/sample.mp4
RENDER_NO_TTS=1 pnpm --filter renderer render:sample          # без голоса
pnpm --filter renderer render:sample out/x.mp4 script.txt      # свой текст материала
```
Chrome Headless Shell Remotion скачает сам при первом запуске (~140 МБ, в `node_modules/.remotion`). С голосом: `python3 -m venv v && v/bin/pip install piper-tts`,
скачать `ru_RU-denis-medium.onnx` и `.onnx.json`, затем `PIPER_BIN=v/bin/piper PIPER_VOICES_DIR=<папка> pnpm --filter renderer render:sample`.
Замер на M1 (сценарий на 28 с): 29 с рендера, 9 МБ. `pnpm --filter renderer test`: тайминг, субтитры, WAV, цикл очереди (сам рендер в vitest не гоняется).

## Деплой
Образ `agents-renderer` собирает CI (`image-renderer`), Dockerfile `packages/renderer/Dockerfile` (двухэтапный, как у hq): Node 22 bookworm-slim,
библиотеки Chromium, Chrome Headless Shell (скачивается при сборке в `node_modules/.remotion`), Piper и голос. При старте контейнер ничего не
качает, поэтому в `compose.yaml` у сервиса `renderer` `network_mode: none`, нет секретов, `read_only`, `mem_limit 1536m`, `cpus 1.5`,
`restart: unless-stopped`, том `/opt/fir-agents/data/hq` общий с `hq`. Compose на сервере обновляется только повторным запуском
`deploy/bootstrap-vps.sh`; затем `docker compose pull && docker compose up -d renderer`. Образ на Mac не собирали (нет Docker): не проверено, что
Chromium стартует под `cap_drop ALL` и `read_only`, хватает ли `shm_size 256m` и tmpfs 384m, что колёса Piper с хэшами встали на bookworm.
Если Chromium не стартует, первое, что смотреть: `docker compose logs renderer`, затем ослабить `read_only` или `network_mode`.

## Launch-фильм (2026-11-21)
`LaunchFilm` (38 с) и `LaunchTeaser` (15 с): композиции в `src/remotion/Launch.tsx`, план битов и звука в `src/launch/plan.ts` (чистый, без node), тексты RU/EN в `src/launch/copy.ts`,
реплики голоса в `scripts/launch-ru.txt` и `launch-en.txt`. `pnpm --filter renderer render:launch [--lang en] [--only film|teaser] [--music файл]` кладёт `out/launch-<lang>.mp4`
и `out/launch-teaser-<lang>.mp4`. Английского голоса нет: EN собирается без голоса. Музыка не входит в репозиторий (лицензия), `--music` подкладывает трек. Подробно: `docs/launch-film.md`.
