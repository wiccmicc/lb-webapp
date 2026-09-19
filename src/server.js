'use strict';

require('dotenv').config();

const os = require('os');
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const { Store } = require('./store');

// ---------------------------------------------------------------------------
// Конфигурация экземпляра
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOSTNAME = os.hostname();
const INSTANCE_ID = process.env.INSTANCE_ID || `${HOSTNAME}:${PORT}`;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const STARTED_AT = new Date();

const store = new Store(REDIS_URL);
const app = express();

// За реверс-прокси: доверяем X-Forwarded-* заголовкам от Apache/Nginx
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// ---------------------------------------------------------------------------
// Сессии: подписанная cookie (данные хранятся у клиента, а не в RAM/файлах ноды)
// Любой экземпляр с тем же SESSION_SECRET прочитает сессию — ограничение №4.
// ---------------------------------------------------------------------------
app.use(cookieSession({
  name: 'lbapp.sid',
  keys: [SESSION_SECRET],
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  // secure не включаем: TLS терминируется на прокси, до приложения доходит HTTP
}));

// ---------------------------------------------------------------------------
// Общие middleware: заголовок с узлом на каждом ответе + учёт запросов
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Backend-Instance', INSTANCE_ID);
  res.setHeader('X-Backend-Host', HOSTNAME);
  if (req.path.startsWith('/api/')) {
    // не ждём Redis — учёт ведётся в фоне
    store.trackRequest(INSTANCE_ID);
  }
  next();
});

app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`[${INSTANCE_ID}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)} ms)`);
  });
  next();
});

function instanceInfo() {
  return {
    instanceId: INSTANCE_ID,
    hostname: HOSTNAME,
    pid: process.pid,
    port: PORT,
    startedAt: STARTED_AT.toISOString(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
  };
}

// ---------------------------------------------------------------------------
// Health-check для балансировщика
// ---------------------------------------------------------------------------
app.get('/health', async (req, res) => {
  const storeOk = await store.ping();
  res.json({ status: 'ok', instanceId: INSTANCE_ID, store: storeOk ? 'ok' : 'unavailable' });
});

// Строгий вариант: 503, если хранилище недоступно (можно использовать в ЛР3)
app.get('/ready', async (req, res) => {
  const storeOk = await store.ping();
  res.status(storeOk ? 200 : 503).json({ ready: storeOk, instanceId: INSTANCE_ID });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Ограничение №1: однозначно показывает, с какого backend-узла пришёл ответ
app.get('/api/info', (req, res) => {
  res.json({
    ...instanceInfo(),
    store: store.status(),
    request: {
      clientIp: req.ip,
      forwardedFor: req.get('x-forwarded-for') || null,
      forwardedProto: req.get('x-forwarded-proto') || null,
      host: req.get('host'),
      viaProxy: Boolean(req.get('x-forwarded-for')),
    },
    time: new Date().toISOString(),
  });
});

// Асинхронный/долгий запрос — для проверки таймаутов и асинхронной обработки на прокси
app.get('/api/slow', async (req, res) => {
  const ms = Math.min(Math.max(Number(req.query.ms) || 2000, 0), 30000);
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, ms));
  res.json({ instanceId: INSTANCE_ID, requestedMs: ms, actualMs: Date.now() - t0 });
});

// Server-Sent Events — поток событий (асинхронная обработка, долгоживущее соединение)
app.get('/api/stream', (req, res) => {
  const count = Math.min(Math.max(Number(req.query.count) || 5, 1), 60);
  const intervalMs = Math.min(Math.max(Number(req.query.interval) || 1000, 100), 5000);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // подсказка nginx не буферизовать
  });
  res.flushHeaders();

  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    res.write(`data: ${JSON.stringify({ instanceId: INSTANCE_ID, tick: i, time: new Date().toISOString() })}\n\n`);
    if (i >= count) {
      clearInterval(timer);
      res.write('event: end\ndata: {}\n\n');
      res.end();
    }
  }, intervalMs);

  req.on('close', () => clearInterval(timer));
});

// Общий счётчик в Redis — виден со всех экземпляров
app.get('/api/counter', async (req, res) => {
  const value = await store.getCounter();
  res.json({ instanceId: INSTANCE_ID, value, storeAvailable: store.connected });
});

app.post('/api/counter', async (req, res) => {
  const value = await store.incrementCounter();
  if (value === null) return res.status(503).json({ error: 'store unavailable', instanceId: INSTANCE_ID });
  res.json({ instanceId: INSTANCE_ID, value });
});

// Статистика: сколько запросов обработал каждый экземпляр (для демонстрации балансировки)
app.get('/api/stats', async (req, res) => {
  const perInstance = await store.getRequestStats();
  res.json({ instanceId: INSTANCE_ID, perInstance, storeAvailable: store.connected });
});

// Гостевая книга — общие данные в Redis
app.get('/api/messages', async (req, res) => {
  const messages = await store.getMessages();
  res.json({ instanceId: INSTANCE_ID, messages, storeAvailable: store.connected });
});

app.post('/api/messages', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'text is required' });
  const msg = { text, author: req.session.name || 'anonymous', savedBy: INSTANCE_ID, time: new Date().toISOString() };
  const ok = await store.addMessage(msg);
  if (!ok) return res.status(503).json({ error: 'store unavailable', instanceId: INSTANCE_ID });
  res.status(201).json({ instanceId: INSTANCE_ID, message: msg });
});

// Сессия: счётчик визитов и список узлов, которые обслуживали эту сессию.
// Демонстрирует, что сессия переживает переключение между нодами.
app.get('/api/session', (req, res) => {
  req.session.visits = (req.session.visits || 0) + 1;
  const served = req.session.servedBy || [];
  if (served[served.length - 1] !== INSTANCE_ID) served.push(INSTANCE_ID);
  req.session.servedBy = served.slice(-20);
  if (!req.session.createdAt) req.session.createdAt = new Date().toISOString();

  res.json({
    instanceId: INSTANCE_ID,
    session: {
      name: req.session.name || null,
      visits: req.session.visits,
      createdAt: req.session.createdAt,
      servedBy: req.session.servedBy,
    },
  });
});

app.post('/api/session/name', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'name is required' });
  req.session.name = name;
  res.json({ instanceId: INSTANCE_ID, name });
});

app.post('/api/session/reset', (req, res) => {
  req.session = null;
  res.json({ instanceId: INSTANCE_ID, ok: true });
});

app.post('/api/reset', async (req, res) => {
  await store.reset();
  res.json({ instanceId: INSTANCE_ID, ok: true });
});

// ---------------------------------------------------------------------------
// Статика (страница с отображением узла)
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res) => {
  res.status(404).json({ error: 'not found', instanceId: INSTANCE_ID });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(`[${INSTANCE_ID}] error:`, err);
  res.status(500).json({ error: 'internal error', instanceId: INSTANCE_ID });
});

// ---------------------------------------------------------------------------
// Запуск (только HTTP — ограничение №3)
// ---------------------------------------------------------------------------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${INSTANCE_ID}] listening on http://0.0.0.0:${PORT} (pid ${process.pid}, host ${HOSTNAME})`);
});

async function shutdown(signal) {
  console.log(`[${INSTANCE_ID}] ${signal} received, shutting down`);
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
