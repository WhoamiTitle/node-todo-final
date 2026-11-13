import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createMongoClient } from '../../src/infrastructure/mongo.mjs';
import { initializeDatabase } from '../../src/infrastructure/schema.mjs';

const root = process.argv[2];
const app = parseEnv(await readFile(resolve(root, 'config/app.env'), 'utf8'));
const admin = parseEnv(await readFile(resolve(root, 'config/database.env'), 'utf8'));
const data = resolve(root, 'data/mongo');
await mkdir(data, { recursive: true, mode: 0o700 });
if ((await readdir(data)).length)
  throw new Error('DB directory is not empty; refusing initialization. Inspect it manually.');
const space = await statfs(data);
if (space.bavail * space.bsize < 1024 ** 3) {
  throw new Error(
    'At least 1 GiB of free filesystem space is required before DB initialization; also check the account quota',
  );
}
const socket = resolve(root, 'run/bootstrap.sock');
if (Buffer.byteLength(socket) > 100) throw new Error('Unix socket path is too long');
const mongo = spawn(
  resolve(root, 'runtime/bin/mongod'),
  [
    '--bind_ip',
    socket,
    '--unixSocketPrefix',
    resolve(root, 'run'),
    '--filePermissions',
    '0700',
    '--port',
    '30357',
    '--dbpath',
    data,
    '--wiredTigerCacheSizeGB',
    '0.25',
    '--maxConns',
    '50',
    '--logpath',
    resolve(root, 'logs/bootstrap-mongo.log'),
    '--logappend',
  ],
  { stdio: 'ignore' },
);
let interrupted = false;
let spawnError;
mongo.on('error', (error) => {
  spawnError = error;
});
const onSignal = () => {
  interrupted = true;
  mongo.kill('SIGTERM');
};
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
const client = createMongoClient(
  `mongodb://${encodeURIComponent(socket)}/admin?directConnection=true`,
);
try {
  // No TCP listener during bootstrap. Only this user's private directory exposes the socket.
  let ready = false;
  let lastConnectionError;
  for (let attempt = 0; attempt < 15; attempt++) {
    if (interrupted || spawnError || mongo.exitCode !== null)
      throw new Error('Bootstrap MongoDB stopped');
    try {
      await client.db('admin').command({ ping: 1 });
      ready = true;
      break;
    } catch (error) {
      lastConnectionError = error;
      await delay(200);
    }
  }
  if (!ready) {
    // This client has no credentials and only addresses the private bootstrap socket.
    throw new Error('Bootstrap MongoDB is not ready', { cause: lastConnectionError });
  }
  await client.db('admin').command({
    createUser: admin.MONGO_ADMIN_USER,
    pwd: admin.MONGO_ADMIN_PASSWORD,
    roles: [{ role: 'root', db: 'admin' }],
  });
  await initializeDatabase(
    client.db(app.MONGO_DATABASE),
    ['APP', 'REVIEWER'].map((kind) => ({
      name: admin[`MONGO_${kind}_USER`],
      password: admin[`MONGO_${kind}_PASSWORD`],
    })),
  );
} finally {
  await client.close();
  if (mongo.exitCode === null && !spawnError) {
    const exited = new Promise((resolve) => mongo.once('exit', resolve));
    mongo.kill('SIGTERM');
    const deadline = setTimeout(() => {
      process.stderr.write(
        'Bootstrap MongoDB did not stop; inspect its PID and log. No SIGKILL sent.\n',
      );
      process.exit(1);
    }, 35000);
    await exited;
    clearTimeout(deadline);
  }
  process.removeListener('SIGTERM', onSignal);
  process.removeListener('SIGINT', onSignal);
}
if (interrupted) throw new Error('Initialization incomplete; database was not erased');
await writeFile(resolve(root, 'config/db.initialized'), `${new Date().toISOString()}\n`, {
  flag: 'wx',
  mode: 0o600,
});
process.stdout.write(
  'DB initialized and bootstrap process stopped. Normal startup requires authentication.\n',
);
