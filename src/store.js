'use strict';

// Обёртка над Redis — единственное общее хранилище для всех экземпляров.
// Redis живёт отдельно от нод приложения, поэтому падение любой ноды
// не влияет на доступность данных (ограничение №2 задания).
// При недоступности Redis приложение продолжает отвечать, но помечает
// хранилище как "unavailable", а не падает.

const Redis = require('ioredis');

const KEY_PREFIX = 'lbapp:';
const MESSAGES_KEY = `${KEY_PREFIX}messages`;
const COUNTER_KEY = `${KEY_PREFIX}counter`;
const REQUESTS_KEY = `${KEY_PREFIX}requests`; // hash: instanceId -> число запросов
const MAX_MESSAGES = 50;

class Store {
  constructor(url) {
    this.url = url;
    this.connected = false;
    this.lastError = null;

    this.redis = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });

    this.redis.on('ready', () => {
      this.connected = true;
      this.lastError = null;
      console.log(`[store] connected to ${url}`);
    });
    this.redis.on('error', (err) => {
      this.lastError = err.message;
      if (this.connected) console.warn(`[store] error: ${err.message}`);
    });
    this.redis.on('close', () => {
      if (this.connected) console.warn('[store] connection closed');
      this.connected = false;
    });

    this.redis.connect().catch((err) => {
      this.lastError = err.message;
      console.warn(`[store] initial connect failed: ${err.message} (will retry)`);
    });
  }

  status() {
    return {
      type: 'redis',
      url: this.url.replace(/\/\/.*@/, '//***@'),
      connected: this.connected,
      error: this.connected ? null : this.lastError,
    };
  }

  // Выполняет операцию; при недоступном Redis возвращает null вместо исключения.
  async safe(fn) {
    if (!this.connected) return null;
    try {
      return await fn(this.redis);
    } catch (err) {
      this.lastError = err.message;
      return null;
    }
  }

  async ping() {
    const r = await this.safe((c) => c.ping());
    return r === 'PONG';
  }

  async incrementCounter() {
    return this.safe((c) => c.incr(COUNTER_KEY));
  }

  async getCounter() {
    const v = await this.safe((c) => c.get(COUNTER_KEY));
    return v === null ? null : Number(v);
  }

  async trackRequest(instanceId) {
    return this.safe((c) => c.hincrby(REQUESTS_KEY, instanceId, 1));
  }

  async getRequestStats() {
    const h = await this.safe((c) => c.hgetall(REQUESTS_KEY));
    if (!h) return null;
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Number(v)]));
  }

  async addMessage(msg) {
    return this.safe(async (c) => {
      await c.lpush(MESSAGES_KEY, JSON.stringify(msg));
      await c.ltrim(MESSAGES_KEY, 0, MAX_MESSAGES - 1);
      return true;
    });
  }

  async getMessages() {
    const list = await this.safe((c) => c.lrange(MESSAGES_KEY, 0, MAX_MESSAGES - 1));
    if (!list) return null;
    return list.map((s) => JSON.parse(s));
  }

  async reset() {
    return this.safe((c) => c.del(COUNTER_KEY, REQUESTS_KEY, MESSAGES_KEY));
  }

  async close() {
    try { await this.redis.quit(); } catch { /* ignore */ }
  }
}

module.exports = { Store };
