import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { createTaskService } from '../../src/application/task-service.mjs';
import { createApp } from '../../src/presentation/app.mjs';
import { memoryRepository } from '../helpers/memory-repository.mjs';
import { requester, serve } from '../helpers/http.mjs';
import { renderGateway } from '../../deploy/helios/render-gateway.mjs';

const token = 'test_only_'.repeat(5);
const author = { login: 'vasiliy_only1f', fullName: 'Test Author' };
const prefix = '/~tester/todo';
let backend, php, directory, request, base;
before(async () => {
  backend = await serve(
    createApp({
      token,
      service: createTaskService({
        repository: memoryRepository(),
        author,
        newId: randomUUID,
        now: () => new Date(),
      }),
    }),
  );
  directory = await mkdtemp(join(tmpdir(), 'todo-gateway-'));
  await renderGateway(directory, prefix, new URL(backend.base).port, 'preview');
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  php = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', directory, join(directory, 'index.php')], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let failure;
  php.on('error', (error) => {
    failure = error;
  });
  php.stderr.resume();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (failure) throw failure;
    if (php.exitCode !== null) throw new Error('PHP gateway exited');
    try {
      const response = await fetch(`${base}${prefix}/login/`, { signal: AbortSignal.timeout(300) });
      if (response.ok) {
        request = requester(`${base}${prefix}`, token);
        return;
      }
    } catch {
      /* The test-owned PHP process is still starting. */
    }
    await delay(100);
  }
  throw new Error('PHP gateway did not start');
});
after(async () => {
  if (php?.exitCode === null) {
    const exited = new Promise((resolve) => php.once('exit', resolve));
    php.kill('SIGTERM');
    await exited;
  }
  await backend?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('PHP gateway preserves subpath, bearer, JSON and complete CRUD', async () => {
  assert.equal((await request('/login/', { auth: null })).text, author.login);
  assert.deepEqual((await request('/api/author/')).data, author);
  assert.equal((await request('/api/author/', { auth: null })).status, 401);
  const created = await request('/api/tasks/', {
    method: 'POST',
    body: { title: 'Via PHP', runId: 'gateway' },
  });
  assert.equal(created.status, 201);
  const path = `/api/tasks/${created.data.id}/`;
  const updated = await request(path, { method: 'PATCH', body: { done: true, title: 'Changed' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.done, true);
  assert.equal((await request('/api/tasks/?runId=gateway')).data[0].title, 'Changed');
  const removed = await request(path, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal(removed.text, '');
  assert.equal((await request(path)).status, 404);
  assert.deepEqual((await request('/api/tasks/?runId=gateway')).data, []);
});

test('PHP gateway serves assets and keeps errors and CORS intact', async () => {
  assert.match((await request('/', { auth: null })).text, /<html/);
  const asset = await request('/app.mjs', { auth: null });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  for (const rawBody of ['{', 'x'.repeat(9000)]) {
    const response = await request('/api/tasks/', { method: 'POST', rawBody });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  }
  const preflight = await request('/api/tasks/', { method: 'OPTIONS', auth: null });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PATCH/);
  assert.equal((await request('/login')).status, 404);
  assert.equal((await request('/login/', { method: 'HEAD' })).text, '');
  assert.equal((await request('/login/', { method: 'PUT' })).status, 405);
  assert.equal((await request('/.env')).status, 404);
});

test('preview headers cover pages, assets, auth errors, preflight and redirects', async () => {
  for (const path of ['/', '/app.mjs', '/login/', '/api/author/', '/.env']) {
    const response = await request(path, { auth: null });
    assert.equal(response.headers.get('x-todo-mode'), 'preview');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  const preflight = await request('/api/tasks/', { method: 'OPTIONS', auth: null });
  assert.equal(preflight.headers.get('x-todo-mode'), 'preview');
  assert.equal(preflight.headers.get('x-robots-tag'), 'noindex, nofollow');
  const redirect = await requester(base, token)(prefix);
  assert.equal(redirect.headers.get('x-todo-mode'), 'preview');
  assert.equal(redirect.headers.get('x-robots-tag'), 'noindex, nofollow');
  const spoof = await fetch(`${base}${prefix}/?mode=approved`, {
    headers: { 'X-Todo-Mode': 'approved' },
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(spoof.headers.get('x-todo-mode'), 'preview');
  await spoof.text();
});

test('approved gateway has an explicit mode and does not send preview indexing headers', async () => {
  try {
    await renderGateway(directory, prefix, new URL(backend.base).port);
    const response = await request('/', { auth: null });
    assert.equal(response.headers.get('x-todo-mode'), 'approved');
    assert.equal(response.headers.has('x-robots-tag'), false);
  } finally {
    await renderGateway(directory, prefix, new URL(backend.base).port, 'preview');
  }
});

test('PHP gateway does not proxy outside its prefix or decode path separators', async () => {
  assert.equal((await requester(base, token)('/api/author/')).status, 404);
  assert.equal((await request('/api%2ftasks/')).status, 400);
  const redirect = await requester(base, token)(`${prefix}?x=1`);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), `${prefix}/?x=1`);
});

test('gateway generator rejects nonlocal or injectable settings', async () => {
  await assert.rejects(renderGateway(directory, '/todo\nmalicious', 3000));
  await assert.rejects(renderGateway(directory, prefix, '3000/evil'));
  await assert.rejects(renderGateway(directory, prefix, 3000, 'unknown'));
});

test('unavailable upstream returns sanitized JSON and CORS', async () => {
  await backend.close();
  backend = null;
  const response = await request('/healthz/', { auth: null });
  assert.equal(response.status, 502);
  assert.deepEqual(response.data, { error: 'backend_unavailable' });
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.has('x-powered-by'), false);
  assert.equal(response.headers.get('x-todo-mode'), 'preview');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
});
