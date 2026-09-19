'use strict';

// Запуск нескольких идентичных экземпляров приложения локально (без Docker).
// Использование: node scripts/start-cluster.js [количество] [базовый порт]
//   npm run cluster            -> 3 экземпляра на портах 3001, 3002, 3003
//   npm run cluster -- 2 4000  -> 2 экземпляра на портах 4001, 4002

const { spawn } = require('child_process');
const path = require('path');

const count = Number(process.argv[2]) || 3;
const basePort = Number(process.argv[3]) || 3000;
const serverPath = path.join(__dirname, '..', 'src', 'server.js');

const children = [];

for (let i = 1; i <= count; i += 1) {
  const port = basePort + i;
  const env = {
    ...process.env,
    PORT: String(port),
    INSTANCE_ID: process.env.INSTANCE_PREFIX ? `${process.env.INSTANCE_PREFIX}-${i}` : `app-${i}`,
  };
  const child = spawn(process.execPath, [serverPath], { env, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code) => console.log(`[cluster] app-${i} (port ${port}) exited with code ${code}`));
}

console.log(`[cluster] started ${count} instance(s): ${Array.from({ length: count }, (_, i) => `http://localhost:${basePort + i + 1}`).join(', ')}`);

function stopAll() {
  for (const c of children) if (!c.killed) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
