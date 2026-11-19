# Образ OmniRoute: закреплён по digest

`compose.yaml` ссылается на `diegosouzapw/omniroute@sha256:...`, а не на `:latest`. Через шлюз идут все тексты агентов, в нём лежат
ключи провайдеров LLM, поэтому образ меняется только руками и только после проверки (аудит 2026-11-19, пункт 8).
`deploy/deploy.sh` делает `docker compose pull`: с digest он тянет ровно этот образ, а не то, что автор успел выложить сегодня.

Закреплено 2026-11-19: `sha256:2c4c755a54f8ce5341bc1856580b71f47a0f16a9afab4a55f84d540810631f68` (индекс с linux/amd64 и linux/arm64,
это был `latest` на тот день).

## Как обновить (вручную, не чаще раза в месяц и только при причине: исправление, нужная модель, уязвимость)
1. Прочитать changelog и релизы автора (`github.com/diegosouzapw/OmniRoute`) между закреплённой и новой версией. Ищем: смену формата
   `storage.sqlite`, новые обязательные переменные, смену порта, сетевые вызовы наружу.
2. Узнать digest нужного тега (анонимный токен, потом HEAD манифеста; digest в заголовке `docker-content-digest`):
   ```
   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:diegosouzapw/omniroute:pull" | jq -r .token)
   curl -sI -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" \
     https://registry-1.docker.io/v2/diegosouzapw/omniroute/manifests/<tag> | grep -i docker-content-digest
   ```
   Лучше брать не `latest`, а конкретный тег версии (`v1.x.y`), если он есть: тогда понятно, что именно закреплено.
3. Сделать копию данных на сервере (`/opt/fir-agents/data/omniroute`, там `storage.sqlite` и ключи) до замены.
4. Подставить новый digest в `compose.yaml`, дописать дату и версию в комментарий над сервисом, закоммитить в ветку.
5. Compose на сервере обновляется только повторным запуском `bootstrap-vps.sh` (CI его не заменяет): владелец ставит новый `compose.yaml`,
   затем `docker compose pull omniroute && docker compose up -d omniroute`.
6. Проверка: `docker compose ps` (healthy), `curl http://omniroute:20128/healthz` из контейнера hq, один ответ чата в тестовом режиме,
   строка «AI gateway» на странице статуса зелёная. Если не взлетело: вернуть прежний digest и `up -d` ещё раз.
