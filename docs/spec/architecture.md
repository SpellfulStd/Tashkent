# Архитектурная спецификация

## Компоненты (все на хосте `186.246.21.136`, Docker-сеть `tashkent-net`)
- **nginx** (хост) — TLS-терминация (Let's Encrypt), reverse-proxy, проксирование WebSocket. Vhosts: `tashkent.spellful.site` (приложение), `auth.spellful.site` (Keycloak).
- **Приложение** — контейнер `tashkent` (`node:24-alpine`, Express), порт `127.0.0.1:7777`, монтирует `/opt/tashkent`. OIDC-клиент, сессии в Postgres, WebSocket `/ws`.
- **PostgreSQL** — контейнер `postgres` (17), БД `tashkent` и `keycloak`, volume `pgdata`. Бэкап: `pg_backup.sh` + systemd-таймер `pg-backup.timer` (ежедневно, хранение 14 дней).
- **Keycloak** — контейнер `keycloak` (26.4), realm `spellful`, OIDC-клиент `tashkent`, за nginx на `auth.spellful.site`, тема `spellful`. Приложение ходит в Keycloak через `--add-host auth.spellful.site:host-gateway` (валидный TLS на бэкенд-канале).
- **Хост-воркер админ-чата** — systemd-сервис `tashkent-codex-worker`: опрашивает `admin_tasks`, запускает `codex exec` над `/opt/tashkent`, коммитит/пушит, перезапускает контейнер при правках бэкенда. См. `ai-native.md` и ADR-0004.

## Потоки данных
- **HTTP:** браузер → nginx (TLS) → app (`127.0.0.1:7777`) → Postgres.
- **OIDC:** `/login`→`/auth/login`→Keycloak (authorization code) → `/callback` → сессия в Postgres. Анониму на `/` отдаётся `landing.html`, вошедшему — `index.html`.
- **Real-time:** клиент открывает WS `/ws` (сессия проверяется на upgrade) → действие шлёт `POST /api/games/:id/events` (append) → сервер делает `broadcast` → клиенты перезапрашивают игру (notify-and-refetch). См. ADR-0003.
- **Админ-чат:** `POST /api/admin/chat` (только `spellful`) → запись в `admin_tasks` → хост-воркер → codex → git → передеплой → статус/вывод обратно в `admin_tasks` → поллинг в UI.

## Развёртывание и устойчивость
- Контейнеры `--restart unless-stopped`; Ollama/Keycloak/Postgres/app переживают перезагрузку.
- Сертификаты — автопродление (certbot).
- swap 4 ГБ (страховка от OOM при Keycloak + соседних сервисах на хосте).
- Код+данные в `/opt/tashkent` (git-клон); живые данные защищены `skip-worktree`; ассеты лендинга — `public/img/` (jpg, оптимизированы).
