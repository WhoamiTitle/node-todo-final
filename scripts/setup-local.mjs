import { randomBytes } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
for (const name of ['.env', '.env.database']) {
  try {
    await access(new URL(name, root));
    throw new Error(`${name} already exists; refusing to replace credentials`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const secret = () => randomBytes(32).toString('hex');
const admin = secret();
const app = secret();
const reviewer = secret();
const database = 'node_todo_final';
const uri = (user, password, source) =>
  `mongodb://${user}:${password}@127.0.0.1:30357/${database}?authSource=${source}&directConnection=true`;
await writeFile(
  new URL('.env', root),
  [
    'HOST=127.0.0.1',
    'PORT=30356',
    'AUTHOR_LOGIN=vasiliy_only1f',
    'AUTHOR_FULL_NAME="Крылов Василий Анатольевич"',
    `API_TOKEN=${secret()}`,
    `MONGO_URI=${uri('todo_app', app, database)}`,
    `MONGO_DATABASE=${database}`,
    '',
  ].join('\n'),
  { mode: 0o600, flag: 'wx' },
);
await writeFile(
  new URL('.env.database', root),
  [
    'MONGO_HOST_PORT=30357',
    'MONGO_INITDB_ROOT_USERNAME=local_admin',
    `MONGO_INITDB_ROOT_PASSWORD=${admin}`,
    `MONGO_ADMIN_URI=${uri('local_admin', admin, 'admin')}`,
    'MONGO_APP_USER=todo_app',
    `MONGO_APP_PASSWORD=${app}`,
    'MONGO_REVIEWER_USER=todo_reviewer',
    `MONGO_REVIEWER_PASSWORD=${reviewer}`,
    `MONGO_REVIEWER_URI=${uri('todo_reviewer', reviewer, database)}`,
    '',
  ].join('\n'),
  { mode: 0o600, flag: 'wx' },
);
process.stdout.write(
  `Created private local configuration in ${fileURLToPath(root)}. No credentials printed.\n`,
);
