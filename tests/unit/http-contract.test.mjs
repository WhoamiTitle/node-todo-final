import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTaskService } from '../../src/application/task-service.mjs';
import { MongoNetworkError } from 'mongodb';
import { createMongoTaskRepository } from '../../src/infrastructure/mongo.mjs';
import { createApp } from '../../src/presentation/app.mjs';
import { memoryRepository } from '../helpers/memory-repository.mjs';
import { requester, serve } from '../helpers/http.mjs';

const token = 'test_only_'.repeat(5);
const repository = memoryRepository();
const author = { login: 'vasiliy_only1f', fullName: 'Крылов Василий Анатольевич' };
let server;
let request;
before(async () => {
  const service = createTaskService({
    repository,
    author,
    newId: randomUUID,
    now: () => new Date(),
  });
  server = await serve(createApp({ service, token }));
  request = requester(server.base, token);
});
after(async () => {
  await server?.close();
});

test('public login is exact text, author requires bearer, private responses cannot be cached', async () => {
  const login = await request('/login/', { auth: null });
  assert.equal(login.status, 200);
  assert.equal(login.text, author.login);
  assert.match(login.headers.get('content-type'), /^text\/plain/);
  for (const path of [
    '/api/author/',
    '/api/tasks/?runId=x',
    `/api/tasks/${randomUUID()}/`,
    '/api/unknown/',
  ]) {
    for (const auth of [null, 'wrong', token.slice(1), 'wrong_'.repeat(10)]) {
      const result = await request(path, { auth });
      assert.equal(result.status, 401);
      assert.deepEqual(result.data, { error: 'unauthorized' });
      assert.match(result.headers.get('content-type'), /^application\/json/);
    }
  }
  const response = await request('/api/author/');
  assert.deepEqual(response.data, author);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.has('x-powered-by'), false);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
});

test('all mutation endpoints authenticate before parsing or touching storage', async () => {
  for (const [method, path] of [
    ['POST', '/api/tasks/'],
    ['PATCH', `/api/tasks/${randomUUID()}/`],
    ['DELETE', `/api/tasks/${randomUUID()}/`],
  ]) {
    assert.equal((await request(path, { method, rawBody: '{', auth: null })).status, 401);
  }
});

test('CRUD contract, server assigned fields, 404, 204 and empty list', async () => {
  const runId = randomUUID();
  const created = await request('/api/tasks/', {
    method: 'POST',
    body: { title: '  Test  ', runId },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(
    Object.keys(created.data).sort(),
    ['id', 'ownerLogin', 'title', 'done', 'runId', 'createdAt'].sort(),
  );
  assert.equal(created.data.title, 'Test');
  assert.equal(created.data.ownerLogin, author.login);
  assert.equal(created.data.done, false);
  assert.match(created.data.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const path = `/api/tasks/${created.data.id}/`;
  assert.deepEqual((await request(path)).data, created.data);
  assert.deepEqual((await request(`/api/tasks/?runId=${runId}`)).data, [created.data]);
  const updated = await request(path, { method: 'PATCH', body: { title: ' New ', done: true } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.title, 'New');
  assert.equal(updated.data.done, true);
  assert.equal(updated.data.createdAt, created.data.createdAt);
  const deleted = await request(path, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, '');
  for (const options of [{}, { method: 'PATCH', body: { done: false } }, { method: 'DELETE' }]) {
    assert.equal((await request(path, options)).status, 404);
  }
  assert.deepEqual((await request(`/api/tasks/?runId=${runId}`)).data, []);
});

const invalidPosts = [
  null,
  [],
  'text',
  2,
  true,
  {},
  { title: 'a' },
  { runId: 'run' },
  { title: '', runId: 'run' },
  { title: ' \n\t ', runId: 'run' },
  { title: 1, runId: 'run' },
  { title: ['x'], runId: 'run' },
  { title: 'a'.repeat(201), runId: 'run' },
  { title: 'a', runId: '' },
  { title: 'a', runId: 'x'.repeat(65) },
  { title: 'a', runId: 3 },
  { title: 'a', runId: ['x'] },
  { title: 'a', runId: ' x ' },
  { title: 'a', runId: 'кириллица' },
  { title: 'a', runId: 'run', done: false },
  ...['id', 'ownerLogin', 'createdAt', 'extra', '__proto__'].map((key) => ({
    title: 'a',
    runId: 'run',
    [key]: 'bad',
  })),
];
for (const [index, body] of invalidPosts.entries()) {
  test(`invalid POST body ${index + 1} returns JSON 400`, async () => {
    const result = await request('/api/tasks/', { method: 'POST', body });
    assert.equal(result.status, 400);
    assert.equal(typeof result.data.error, 'string');
  });
}

test('PATCH validates nonempty strict fields and boolean', async () => {
  const { data } = await request('/api/tasks/', {
    method: 'POST',
    body: { title: 'test', runId: 'patch' },
  });
  for (const body of [
    null,
    [],
    {},
    { title: '' },
    { title: 1 },
    { done: 'true' },
    { done: 1 },
    { done: null },
    { runId: 'new' },
    { title: 'a', ownerLogin: 'other' },
  ]) {
    assert.equal((await request(`/api/tasks/${data.id}/`, { method: 'PATCH', body })).status, 400);
  }
  assert.equal(
    (await request(`/api/tasks/${data.id}/`, { method: 'PATCH', body: { done: false } })).status,
    200,
  );
});

test('Unicode title length counts code points and runId boundaries work', async () => {
  for (const title of ['я'.repeat(200), '😀'.repeat(200)]) {
    assert.equal(
      (await request('/api/tasks/', { method: 'POST', body: { title, runId: 'A_0-'.repeat(16) } }))
        .status,
      201,
    );
  }
  assert.equal(
    (
      await request('/api/tasks/', {
        method: 'POST',
        body: { title: '😀'.repeat(201), runId: 'x' },
      })
    ).status,
    400,
  );
});

test('invalid query, UUID, JSON, media type and oversized body return 400', async () => {
  for (const path of [
    '/api/tasks/',
    '/api/tasks/?runId=',
    '/api/tasks/?runId=a&runId=b',
    '/api/tasks/?runId%5B%24ne%5D=a',
  ]) {
    assert.equal((await request(path)).status, 400);
  }
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    assert.equal(
      (
        await request('/api/tasks/not-a-uuid/', {
          method,
          ...(method === 'PATCH' ? { body: { done: true } } : {}),
        })
      ).status,
      400,
    );
  }
  for (const rawBody of ['{', '', '{"title":"x","runId":"run",}', 'x'.repeat(9000)]) {
    assert.equal((await request('/api/tasks/', { method: 'POST', rawBody })).status, 400);
  }
  assert.equal(
    (
      await request('/api/tasks/', {
        method: 'POST',
        rawBody: 'title=x',
        contentType: 'text/plain',
      })
    ).status,
    400,
  );
});

test('published paths are case sensitive and require a trailing slash', async () => {
  for (const path of [
    '/login',
    '/LOGIN/',
    '/api/author',
    '/api/tasks?runId=a',
    `/api/tasks/${randomUUID()}`,
  ]) {
    assert.equal((await request(path)).status, 404);
  }
  const preflight = await request('/api/tasks/', { method: 'OPTIONS', auth: null });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
});

test('MongoDB failures return 503, document mapping failures return 500; both are sanitized', async () => {
  const unavailable = () => {
    throw new MongoNetworkError('sensitive connection string');
  };
  const broken = createMongoTaskRepository({
    collection: () => ({
      find: unavailable,
      findOne: async ({ id }) => (id ? { createdAt: 'not a BSON date' } : unavailable()),
    }),
  });
  const service = createTaskService({
    repository: broken,
    author,
    newId: randomUUID,
    now: () => new Date(),
  });
  const failureServer = await serve(createApp({ service, token }));
  try {
    const get = requester(failureServer.base, token);
    for (const [path, status, error] of [
      ['/api/tasks/?runId=x', 503, 'database_unavailable'],
      ['/healthz/', 503, 'database_unavailable'],
      [`/api/tasks/${randomUUID()}/`, 500, 'internal_error'],
    ]) {
      const result = await get(path);
      assert.equal(result.status, status);
      assert.deepEqual(result.data, { error });
    }
  } finally {
    await failureServer.close();
  }
});
