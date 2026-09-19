# LB Web App — Практическая работа №2

Веб-приложение для последующего развёртывания (ЛР №3) за реверс-прокси Apache/Nginx
с балансировкой нагрузки (L4/L7), DNS-балансировкой, TLS/SSL-терминацией и обработкой
асинхронных запросов. Поддерживает одновременный запуск двух и более идентичных экземпляров.

**Стек:** Node.js 18+, Express, Redis (общее хранилище), cookie-session (сессии).

## Быстрый старт

### Вариант A — Docker Compose (3 экземпляра + Redis)

```bash
docker compose up --build
```

- http://localhost:3001 — экземпляр `app-1`
- http://localhost:3002 — экземпляр `app-2`
- http://localhost:3003 — экземпляр `app-3`

Для локальной проверки распределения запросов можно поднять демонстрационный nginx
(round-robin по трём экземплярам) на http://localhost:8080:

```bash
docker compose --profile demo up --build
```

> Полноценная настройка Apache/Nginx выполняется в ЛР №3; профиль `demo` — только для самопроверки.

### Вариант B — локально без Docker

```bash
npm install
```

Терминал 1 — общее хранилище. Настоящий Redis (`redis-server`), либо, если его нет,
dev-заменитель из репозитория (отдельный процесс, поддерживает только команды, нужные приложению):

```bash
npm run mini-redis
```

Терминал 2 — три экземпляра приложения на портах 3001–3003:

```bash
npm run cluster
```

Один экземпляр: `PORT=3000 INSTANCE_ID=app-1 npm start` (переменные см. в `.env.example`).

## Что показывает приложение

Главная страница `/` и все ответы API содержат идентификатор узла, обработавшего запрос:

- поле `instanceId` в JSON,
- заголовки `X-Backend-Instance` и `X-Backend-Host` в каждом ответе.

| Эндпоинт | Назначение |
|---|---|
| `GET /` | Страница: узел, распределение запросов, счётчик, сессия, гостевая книга, асинхронные запросы |
| `GET /api/info` | Узел: `instanceId`, hostname, pid, port, uptime; заголовки `X-Forwarded-*` от прокси; статус хранилища |
| `GET /health` | Health-check для балансировщика (всегда 200, если процесс жив) |
| `GET /ready` | 200 если хранилище доступно, иначе 503 (для исключения ноды из upstream) |
| `GET /api/slow?ms=3000` | Долгий асинхронный запрос (проверка таймаутов прокси) |
| `GET /api/stream?count=5&interval=1000` | Server-Sent Events — долгоживущее соединение |
| `GET/POST /api/counter` | Общий счётчик в Redis (виден со всех узлов) |
| `GET /api/stats` | Сколько запросов обработал каждый узел (для демонстрации балансировки) |
| `GET/POST /api/messages` | Гостевая книга в Redis |
| `GET /api/session` | Сессия: число визитов и список узлов, обслуживавших её |
| `POST /api/session/name` | Сохранить имя в сессии (`{"name": "..."}`) |
| `POST /api/session/reset` | Сбросить сессию |
| `POST /api/reset` | Очистить данные в хранилище |

## Соответствие ограничениям задания

| № | Ограничение | Реализация |
|---|---|---|
| 1 | Определение узла backend | `instanceId` во всех ответах API и на странице; заголовок `X-Backend-Instance` |
| 2 | Хранилище не зависит от выхода ноды из строя | Данные только во внешнем общем Redis (отдельный сервис/процесс). Ни одна нода не хранит данные локально; при падении ноды остальные продолжают работать с тем же Redis. При недоступности Redis приложение отвечает, помечая хранилище как `unavailable`, и переподключается автоматически |
| 3 | Приложение не обрабатывает TLS | Только plain HTTP на `0.0.0.0:PORT`; `trust proxy` включён, чтобы читать `X-Forwarded-Proto/For` от Apache/Nginx |
| 4 | Сессии не в RAM и не в локальных файлах | `cookie-session`: данные сессии хранятся в подписанной cookie у клиента. Любая нода с тем же `SESSION_SECRET` читает и обновляет сессию — sticky-сессии не нужны |

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | HTTP-порт |
| `INSTANCE_ID` | `<hostname>:<port>` | Идентификатор экземпляра |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Адрес общего хранилища |
| `SESSION_SECRET` | `dev-secret-change-me` | Секрет подписи cookie; **одинаковый на всех экземплярах** |

## Проверка вручную

```bash
curl -i http://localhost:3001/api/info
curl -s http://localhost:3002/api/info | grep -o '"instanceId":"[^"]*"'
curl -X POST http://localhost:3003/api/counter
curl -N "http://localhost:3001/api/stream?count=3&interval=500"
```

Сессия между узлами (cookie с узла 1 читается узлом 2):

```bash
curl -c cj.txt -b cj.txt http://localhost:3001/api/session
curl -c cj.txt -b cj.txt http://localhost:3002/api/session
```

## Структура

```
src/server.js          — Express-приложение, все эндпоинты
src/store.js           — обёртка над Redis с graceful degradation
public/index.html      — страница демонстрации
scripts/start-cluster.js — запуск N экземпляров локально
scripts/mini-redis.js  — dev-заменитель Redis (только для локальной демонстрации)
Dockerfile, docker-compose.yml — контейнеризация: app1..app3 + redis (+ nginx-demo)
nginx-demo/nginx.conf  — демонстрационный round-robin балансировщик
```
