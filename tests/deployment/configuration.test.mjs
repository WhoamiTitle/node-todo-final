import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { configure } from '../../deploy/helios/configure.mjs';

const run = promisify(execFile);
const defaults = { AUTHOR_LOGIN: 'vasiliy_only1f', AUTHOR_FULL_NAME: 'Test Author' };

test('private configuration separates app/admin/reviewer and cannot replace existing credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'todo-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, '.node-todo-final');
  await mkdir(root);
  await configure(root, defaults);
  const read = (name) => readFile(join(root, 'config', name), 'utf8');
  const app = parseEnv(await read('app.env'));
  const admin = parseEnv(await read('database.env'));
  const reviewer = parseEnv(await read('reviewer.env'));
  assert.equal(app.HOST, '127.0.0.1');
  assert.equal(app.PORT, '30356');
  assert.equal(app.AUTHOR_LOGIN, defaults.AUTHOR_LOGIN);
  assert.match(app.API_TOKEN, /^[a-f0-9]{64}$/);
  assert.equal(new URL(app.MONGO_URI).username, 'todo_app');
  assert.equal(new URL(reviewer.MONGO_REVIEWER_URI).username, 'todo_reviewer');
  assert.notEqual(admin.MONGO_APP_PASSWORD, admin.MONGO_REVIEWER_PASSWORD);
  assert.notEqual(admin.MONGO_ADMIN_PASSWORD, admin.MONGO_APP_PASSWORD);
  assert.doesNotMatch(await read('app.env'), new RegExp(admin.MONGO_ADMIN_PASSWORD));
  const mongo = JSON.parse(await read('mongod.json'));
  assert.equal(mongo.security.authorization, 'enabled');
  assert.equal(mongo.net.bindIp, '127.0.0.1');
  assert.equal(mongo.setParameter.enableLocalhostAuthBypass, false);
  for (const name of ['app.env', 'database.env', 'reviewer.env', 'mongod.json']) {
    assert.equal((await stat(join(root, 'config', name))).mode & 0o777, 0o600);
  }
  await assert.rejects(configure(root, defaults), /already exists/);
  assert.deepEqual(parseEnv(await read('app.env')), app);
});

test('invalid settings and existing symlink are refused without writing secrets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'todo-invalid-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, '.node-todo-final');
  await mkdir(root);
  await assert.rejects(configure(root, { ...defaults, PORT: 30357 }), /different ports/);
  await assert.rejects(configure(root, { ...defaults, AUTHOR_LOGIN: undefined }), /identity/);
  await symlink(directory, join(root, 'config'));
  await assert.rejects(configure(root, defaults), /already exists/);
});

test('insufficient disk space stops bootstrap before starting mongod or initializing data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'todo-db-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, '.node-todo-final');
  await mkdir(root);
  await configure(root, defaults);
  const script = fileURLToPath(new URL('../../deploy/helios/bootstrap-db.mjs', import.meta.url));
  const preload = `
    import fs from 'node:fs/promises';
    import child from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    fs.statfs = async () => ({ bavail: 262143, bsize: 4096 });
    child.spawn = () => { throw new Error('mongod started on a full filesystem'); };
    syncBuiltinESMExports();`;
  await assert.rejects(
    run(process.execPath, [
      '--import',
      `data:text/javascript,${encodeURIComponent(preload)}`,
      script,
      root,
    ]),
    { stderr: /At least 1 GiB of free filesystem space/ },
  );
  assert.deepEqual(await readdir(join(root, 'data/mongo')), []);
  await assert.rejects(stat(join(root, 'config/db.initialized')), { code: 'ENOENT' });
});
