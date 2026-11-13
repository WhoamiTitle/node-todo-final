import assert from 'node:assert/strict';
import { mkdir, cp, symlink, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createServer } from 'node:net';
import { configure } from '../../deploy/helios/configure.mjs';
import { createMongoClient } from '../../src/infrastructure/mongo.mjs';

if (process.platform !== 'freebsd') throw new Error('FreeBSD fixture only');
const [action, root, runtime] = process.argv.slice(2);
if (action === 'setup') {
  for (const name of ['run', 'logs', 'data', 'releases'])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  await symlink(runtime, join(root, 'runtime'));
  const release = join(root, 'releases', 'c'.repeat(40));
  await cp(fileURLToPath(new URL('../../', import.meta.url)), release, { recursive: true });
  await symlink(release, join(root, 'current'));
  async function port() {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const value = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return value;
  }
  const appPort = await port();
  let mongoPort = await port();
  while (mongoPort === appPort) mongoPort = await port();
  await configure(root, {
    PORT: appPort,
    MONGO_HOST_PORT: mongoPort,
    AUTHOR_LOGIN: 'fixture',
    AUTHOR_FULL_NAME: 'FreeBSD Test',
  });
} else {
  const app = parseEnv(await readFile(join(root, 'config/app.env'), 'utf8'));
  const reviewer = parseEnv(await readFile(join(root, 'config/reviewer.env'), 'utf8'));
  const client = createMongoClient(reviewer.MONGO_REVIEWER_URI);
  try {
    if (action === 'insert') {
      const response = await fetch(`http://127.0.0.1:${app.PORT}/api/tasks/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${app.API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Persistent FreeBSD fixture', runId: 'freebsd' }),
      });
      assert.equal(response.status, 201);
      const task = await response.json();
      assert.equal(
        (await client.db(app.MONGO_DATABASE).collection('tasks').findOne({ id: task.id })).title,
        task.title,
      );
      await writeFile(join(root, 'test-task-id'), task.id, { mode: 0o600 });
    } else if (action === 'verify') {
      const id = await readFile(join(root, 'test-task-id'), 'utf8');
      const stored = await client.db(app.MONGO_DATABASE).collection('tasks').findOne({ id });
      assert.equal(stored.title, 'Persistent FreeBSD fixture');
      const response = await fetch(`http://127.0.0.1:${app.PORT}/api/tasks/${id}/`, {
        headers: { Authorization: `Bearer ${app.API_TOKEN}` },
      });
      assert.equal((await response.json()).title, stored.title);
    } else throw new Error('Unknown fixture action');
  } finally {
    await client.close();
  }
}
