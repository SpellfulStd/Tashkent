# Architecture Decision Records

Ключевые архитектурные решения проекта «Ташкент» (формат: Статус / Контекст / Решение / Последствия).

| # | Решение | Этап |
|---|---------|------|
| [0001](0001-datastore-postgresql.md) | PostgreSQL как хранилище данных | 2 |
| [0002](0002-auth-keycloak-oidc.md) | Авторизация через Keycloak (OIDC) | 2 |
| [0003](0003-realtime-websocket.md) | Real-time через WebSocket (notify-and-refetch) | 2 |
| [0004](0004-admin-chat-codex-agent.md) | Админ-чат как автономный codex-агент (хост-воркер) ⚠️ | 3 |
| [0005](0005-ai-generated-illustrations.md) | Генеративные иллюстрации с ИИ-ревью на артефакты | 4 |
| [0006](0006-player-account-model.md) | Модель «игрок ↔ аккаунт», гости, объединение, видимость | 2–3 |
| [0007](0007-deployment-topology.md) | Топология развёртывания (Docker + nginx + хост-воркер) | 1–3 |

⚠️ ADR-0004 содержит осознанный незакрытый риск безопасности (RCE через вход `spellful`) — см. также `../evaluation.md`.
