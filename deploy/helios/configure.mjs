import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

export async function configure(root, defaults) {
  if (!/^\/[A-Za-z0-9_./-]+\/\.node-todo-final$/.test(root) || root.includes('/../'))
    throw new Error('Invalid private root');
  const configuration = resolve(root, 'config');
  try {
    await lstat(configuration);
    throw new Error('Configuration already exists; credentials will not be replaced');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const port = Number(defaults.PORT || 30356);
  const mongoPort = Number(defaults.MONGO_HOST_PORT || 30357);
  for (const value of [port, mongoPort]) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('Invalid port');
  }
  if (port === mongoPort) throw new Error('Application and DB need different ports');
  const login = defaults.AUTHOR_LOGIN;
  const fullName = defaults.AUTHOR_FULL_NAME;
  if (
    typeof login !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(login) ||
    !fullName ||
    /[\r\n"\\]/.test(fullName)
  )
    throw new Error('Invalid author identity');
  const secret = () => randomBytes(32).toString('hex');
  const appPassword = secret(),
    reviewerPassword = secret(),
    adminPassword = secret();
  const database = 'node_todo_final';
  const uri = (user, password, source) =>
    `mongodb://${user}:${password}@127.0.0.1:${mongoPort}/${database}?authSource=${source}&directConnection=true`;
  // Exclusive directory creation prevents two configurations from interleaving their secrets.
  await mkdir(configuration, { mode: 0o700 });
  const write = (name, data) =>
    writeFile(resolve(configuration, name), data, { flag: 'wx', mode: 0o600 });
  await write(
    'app.env',
    [
      'HOST=127.0.0.1',
      `PORT=${port}`,
      `AUTHOR_LOGIN=${login}`,
      `AUTHOR_FULL_NAME="${fullName}"`,
      `API_TOKEN=${secret()}`,
      `MONGO_URI=${uri('todo_app', appPassword, database)}`,
      `MONGO_DATABASE=${database}`,
      '',
    ].join('\n'),
  );
  await write(
    'database.env',
    [
      'MONGO_ADMIN_USER=todo_admin',
      `MONGO_ADMIN_PASSWORD=${adminPassword}`,
      `MONGO_ADMIN_URI=${uri('todo_admin', adminPassword, 'admin')}`,
      'MONGO_APP_USER=todo_app',
      `MONGO_APP_PASSWORD=${appPassword}`,
      'MONGO_REVIEWER_USER=todo_reviewer',
      `MONGO_REVIEWER_PASSWORD=${reviewerPassword}`,
      '',
    ].join('\n'),
  );
  await write(
    'reviewer.env',
    `MONGO_REVIEWER_URI=${uri('todo_reviewer', reviewerPassword, database)}\n`,
  );
  await write(
    'mongod.json',
    `${JSON.stringify(
      {
        storage: {
          dbPath: resolve(root, 'data/mongo'),
          wiredTiger: { engineConfig: { cacheSizeGB: 0.25 } },
        },
        net: {
          bindIp: '127.0.0.1',
          port: mongoPort,
          maxIncomingConnections: 50,
          unixDomainSocket: { enabled: false },
        },
        security: { authorization: 'enabled' },
        setParameter: { enableLocalhostAuthBypass: false },
        systemLog: { destination: 'file', path: resolve(root, 'logs/mongo.log'), logAppend: true },
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const defaults = parseEnv(await readFile(new URL('../../.env.example', import.meta.url), 'utf8'));
  await configure(process.argv[2], defaults);
  process.stdout.write('Private configuration created; no credentials printed.\n');
}
