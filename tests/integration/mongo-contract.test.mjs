import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createMongoClient, createMongoTaskRepository } from '../../src/infrastructure/mongo.mjs';
import { initializeDatabase } from '../../src/infrastructure/schema.mjs';
import { createTaskService } from '../../src/application/task-service.mjs';
import { createApp } from '../../src/presentation/app.mjs';
import { requester, serve } from '../helpers/http.mjs';

function userUri(adminUri, database, user, password) {
  const url = new URL(adminUri);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  url.searchParams.set('authSource', database);
  return url.href;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startProcess(env) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../src/index.mjs', import.meta.url))],
    {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  child.stdout.resume();
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(`Application exited: ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${env.PORT}/healthz/`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) return { stop };
      } catch {
        /* Wait for this test-owned child to bind. */
      }
      await delay(100);
    }
    throw new Error('Application did not become ready');
  } catch (error) {
    await stop();
    throw error;
  }
}

test(
  'real MongoDB: restricted accounts, both directions, validation and process restart',
  { timeout: 45000 },
  async (context) => {
    const adminUri = process.env.MONGO_ADMIN_URI;
    if (!adminUri || !['127.0.0.1', 'localhost'].includes(new URL(adminUri).hostname)) {
      throw new Error('A local MONGO_ADMIN_URI is required; remote databases are not permitted');
    }
    const admin = createMongoClient(adminUri);
    const name = `todo_test_${randomUUID().replaceAll('-', '')}`;
    const db = admin.db(name);
    const appPassword = randomBytes(32).toString('hex');
    const reviewerPassword = randomBytes(32).toString('hex');
    let processInstance;
    const appUri = userUri(adminUri, name, 'test_app', appPassword);
    const appClient = createMongoClient(appUri);
    const reviewer = createMongoClient(userUri(adminUri, name, 'test_reviewer', reviewerPassword));
    context.after(async () => {
      await processInstance?.stop();
      await appClient.close();
      await reviewer.close();
      await db.command({ dropAllUsersFromDatabase: 1 });
      await db.command({ dropAllRolesFromDatabase: 1 });
      await db.dropDatabase();
      await admin.close();
    });
    const users = [
      { name: 'test_app', password: appPassword },
      { name: 'test_reviewer', password: reviewerPassword },
    ];
    await initializeDatabase(db, users);
    await db.createCollection('private_notes');
    await db.collection('private_notes').insertOne({ private: true });
    const independentTasks = reviewer.db(name).collection('tasks');
    const env = {
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
      AUTHOR_LOGIN: 'vasiliy_only1f',
      AUTHOR_FULL_NAME: 'Крылов Василий Анатольевич',
      API_TOKEN: randomBytes(32).toString('hex'),
      MONGO_DATABASE: name,
      MONGO_URI: appUri,
    };
    processInstance = await startProcess(env);
    const request = requester(`http://127.0.0.1:${env.PORT}`, env.API_TOKEN);
    const created = await request('/api/tasks/', {
      method: 'POST',
      body: { title: 'API to DB', runId: 'integration' },
    });
    assert.equal(created.status, 201);
    const { id } = created.data;
    let stored = await independentTasks.findOne({ id });
    assert.equal(stored.title, 'API to DB');
    assert.equal(stored.ownerLogin, env.AUTHOR_LOGIN);
    assert.ok(stored.createdAt instanceof Date);
    assert.equal(stored.createdAt.toISOString(), created.data.createdAt);
    await initializeDatabase(db, users);
    assert.deepEqual(await independentTasks.findOne({ id }), stored);

    const updated = await request(`/api/tasks/${id}/`, {
      method: 'PATCH',
      body: { title: 'API updated', done: true },
    });
    assert.equal(updated.status, 200);
    stored = await independentTasks.findOne({ id });
    assert.equal(stored.title, 'API updated');
    assert.equal(stored.done, true);
    await independentTasks.updateOne(
      { id },
      { $set: { title: 'Independent DB edit', done: false } },
    );
    assert.equal((await request(`/api/tasks/${id}/`)).data.title, 'Independent DB edit');
    assert.equal((await request('/api/tasks/?runId=integration')).data[0].done, false);

    const dbTask = {
      id: randomUUID(),
      ownerLogin: env.AUTHOR_LOGIN,
      title: 'Independent insert',
      done: false,
      runId: 'integration',
      createdAt: new Date(),
    };
    await independentTasks.insertOne(dbTask);
    assert.equal((await request(`/api/tasks/${dbTask.id}/`)).data.title, dbTask.title);
    assert.equal((await request('/api/tasks/?runId=integration')).data.length, 2);
    await processInstance.stop();
    processInstance = await startProcess(env);
    assert.equal((await request(`/api/tasks/${id}/`)).data.title, 'Independent DB edit');

    await independentTasks.insertOne({
      ...dbTask,
      _id: undefined,
      id: randomUUID(),
      ownerLogin: 'other_owner',
    });
    assert.equal((await request('/api/tasks/?runId=integration')).data.length, 2);
    await assert.rejects(
      () => independentTasks.insertOne({ ...dbTask, _id: undefined }),
      (error) => error.code === 11000,
    );
    await assert.rejects(
      () => independentTasks.updateOne({ id }, { $set: { done: 'true' } }),
      (error) => error.code === 121,
    );
    for (const client of [appClient, reviewer]) {
      await assert.rejects(
        () => client.db(name).collection('private_notes').findOne(),
        (error) => error.code === 13,
      );
      await assert.rejects(
        () => client.db('admin').collection('system.users').findOne(),
        (error) => error.code === 13,
      );
      await assert.rejects(
        () => client.db(name).collection('tasks').drop(),
        (error) => error.code === 13,
      );
      await assert.rejects(
        () => client.db(name).command({ createUser: 'forbidden', pwd: 'forbidden', roles: [] }),
        (error) => error.code === 13,
      );
    }
    await independentTasks.deleteOne({ id });
    assert.equal((await request(`/api/tasks/${id}/`)).status, 404);
    assert.equal((await request(`/api/tasks/${dbTask.id}/`, { method: 'DELETE' })).status, 204);
    assert.equal(await independentTasks.findOne({ id: dbTask.id }), null);
    assert.deepEqual((await request('/api/tasks/?runId=integration')).data, []);
  },
);

test(
  'actual unavailable MongoDB returns bounded 503 without exposing credentials',
  { timeout: 12000 },
  async () => {
    const client = createMongoClient(`mongodb://127.0.0.1:${await freePort()}/unavailable`);
    const service = createTaskService({
      repository: createMongoTaskRepository(client.db('unavailable')),
      author: { login: 'test', fullName: 'Test' },
      newId: randomUUID,
      now: () => new Date(),
    });
    const token = 'test'.repeat(10);
    const server = await serve(createApp({ service, token }));
    try {
      const start = Date.now();
      const result = await requester(server.base, token)('/api/tasks/?runId=unavailable');
      assert.equal(result.status, 503);
      assert.deepEqual(result.data, { error: 'database_unavailable' });
      assert.ok(Date.now() - start < 5000);
    } finally {
      await server.close();
      await client.close();
    }
  },
);
