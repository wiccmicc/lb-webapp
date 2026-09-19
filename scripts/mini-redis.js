'use strict';

// ТОЛЬКО ДЛЯ ЛОКАЛЬНОЙ ДЕМОНСТРАЦИИ без Docker/Redis.
// Минимальный сервер, говорящий по протоколу RESP и реализующий подмножество
// команд Redis, которое использует приложение. Запускается как ОТДЕЛЬНЫЙ
// процесс (общее внешнее хранилище для всех экземпляров) — так же, как
// настоящий Redis. В docker-compose используется настоящий redis:7.
//
//   node scripts/mini-redis.js [порт=6379]

const net = require('net');

const port = Number(process.argv[2]) || 6379;
const strings = new Map();
const hashes = new Map();
const lists = new Map();

// --- RESP ---------------------------------------------------------------
function parse(buf) {
  // Возвращает [команды[], остаток буфера]. Поддерживает только массивы bulk-строк
  // и inline-команды (для redis-cli/telnet).
  const cmds = [];
  let pos = 0;
  while (pos < buf.length) {
    if (buf[pos] === 0x2a) { // '*'
      const start = pos;
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd === -1) break;
      const n = Number(buf.toString('latin1', pos + 1, lineEnd));
      pos = lineEnd + 2;
      const args = [];
      let ok = true;
      for (let i = 0; i < n; i += 1) {
        if (buf[pos] !== 0x24) { ok = false; break; } // '$'
        const le = buf.indexOf('\r\n', pos);
        if (le === -1) { ok = false; break; }
        const len = Number(buf.toString('latin1', pos + 1, le));
        if (buf.length < le + 2 + len + 2) { ok = false; break; }
        args.push(buf.toString('utf8', le + 2, le + 2 + len));
        pos = le + 2 + len + 2;
      }
      if (!ok) { pos = start; break; }
      cmds.push(args);
    } else {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd === -1) break;
      const line = buf.toString('utf8', pos, lineEnd).trim();
      pos = lineEnd + 2;
      if (line) cmds.push(line.split(/\s+/));
    }
  }
  return [cmds, buf.subarray(pos)];
}

const enc = {
  simple: (s) => `+${s}\r\n`,
  error: (s) => `-ERR ${s}\r\n`,
  int: (n) => `:${n}\r\n`,
  bulk: (s) => (s === null || s === undefined ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`),
  array: (arr) => `*${arr.length}\r\n${arr.map((x) => enc.bulk(x)).join('')}`,
};

// --- команды ------------------------------------------------------------
const commands = {
  ping: (args) => (args[0] ? enc.bulk(args[0]) : enc.simple('PONG')),
  echo: (args) => enc.bulk(args[0]),
  info: () => enc.bulk('# Server\r\nredis_version:7.0.0-mini\r\nredis_mode:standalone\r\n# Replication\r\nrole:master\r\n'),
  select: () => enc.simple('OK'),
  client: () => enc.simple('OK'),
  quit: () => enc.simple('OK'),
  command: () => enc.array([]),

  get: ([k]) => enc.bulk(strings.has(k) ? strings.get(k) : null),
  set: ([k, v]) => { strings.set(k, v); return enc.simple('OK'); },
  incr: ([k]) => {
    const v = (Number(strings.get(k)) || 0) + 1;
    strings.set(k, String(v));
    return enc.int(v);
  },
  del: (keys) => {
    let n = 0;
    for (const k of keys) {
      if (strings.delete(k)) n += 1;
      if (hashes.delete(k)) n += 1;
      if (lists.delete(k)) n += 1;
    }
    return enc.int(n);
  },

  hincrby: ([k, f, by]) => {
    if (!hashes.has(k)) hashes.set(k, new Map());
    const h = hashes.get(k);
    const v = (Number(h.get(f)) || 0) + Number(by);
    h.set(f, String(v));
    return enc.int(v);
  },
  hgetall: ([k]) => {
    const h = hashes.get(k);
    if (!h) return enc.array([]);
    return enc.array([...h.entries()].flat());
  },

  lpush: ([k, ...vals]) => {
    if (!lists.has(k)) lists.set(k, []);
    const l = lists.get(k);
    for (const v of vals) l.unshift(v);
    return enc.int(l.length);
  },
  ltrim: ([k, start, stop]) => {
    const l = lists.get(k);
    if (l) {
      let s = Number(start); let e = Number(stop);
      if (s < 0) s = l.length + s;
      if (e < 0) e = l.length + e;
      lists.set(k, l.slice(Math.max(0, s), e + 1));
    }
    return enc.simple('OK');
  },
  lrange: ([k, start, stop]) => {
    const l = lists.get(k) || [];
    let s = Number(start); let e = Number(stop);
    if (s < 0) s = l.length + s;
    if (e < 0) e = l.length + e;
    return enc.array(l.slice(Math.max(0, s), e + 1));
  },
};

// --- сервер -------------------------------------------------------------
const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const [cmds, rest] = parse(buf);
    buf = rest;
    for (const [name, ...args] of cmds) {
      const fn = commands[String(name).toLowerCase()];
      sock.write(fn ? fn(args) : enc.error(`unknown command '${name}'`));
      if (String(name).toLowerCase() === 'quit') sock.end();
    }
  });
  sock.on('error', () => {});
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mini-redis] dev-only store listening on redis://127.0.0.1:${port}`);
});
