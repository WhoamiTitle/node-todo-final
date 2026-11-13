import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../../src/config.mjs';

const config = readConfig(process.env);
const base = new URL(process.argv[2]);
const mode = process.argv[3];
if (mode !== undefined && !['approved', 'preview'].includes(mode))
  throw new Error('Invalid expected publication mode');
if (!base.pathname.endsWith('/') || base.search || base.hash || base.username || base.password)
  throw new Error('Expected an application root ending in /');
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1'))
  throw new Error('Only HTTPS or a loopback HTTP check is allowed');
const runId = `deploy_${randomUUID()}`;
let createdId;
let lastRequest = 'initialization';
let lastStatus;
async function request(path, method = 'GET', body, authenticated = true) {
  lastRequest = `${method} ${path || '/'}`;
  lastStatus = undefined;
  const response = await fetch(new URL(path, base), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  lastStatus = response.status;
  return response;
}
function checkPublication(response) {
  if (mode !== undefined) {
    assert.equal(response.headers.get('x-todo-mode'), mode);
    assert.equal(
      response.headers.get('x-robots-tag'),
      mode === 'preview' ? 'noindex, nofollow' : null,
    );
  }
}
try {
  const health = await request('healthz/', 'GET', undefined, false);
  checkPublication(health);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  const login = await request('login/', 'GET', undefined, false);
  assert.equal(login.status, 200);
  assert.equal(await login.text(), config.author.login);
  const unauthenticated = await request('api/author/', 'GET', undefined, false);
  checkPublication(unauthenticated);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), '*');
  const author = await request('api/author/');
  assert.deepEqual(await author.json(), config.author);
  const preflight = await request('api/tasks/', 'OPTIONS', undefined, false);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/i);
  const page = await request('', 'GET', undefined, false);
  checkPublication(page);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  const module = await request('app.mjs', 'GET', undefined, false);
  checkPublication(module);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
  const created = await request('api/tasks/', 'POST', {
    title: 'Deployment contract check',
    runId,
  });
  assert.equal(created.status, 201);
  const task = await created.json();
  createdId = task.id;
  assert.match(createdId, /^[0-9a-f-]{36}$/);
  assert.equal(task.ownerLogin, config.author.login);
  const updated = await request(`api/tasks/${createdId}/`, 'PATCH', { done: true });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).done, true);
  const listed = await request(`api/tasks/?runId=${runId}`);
  assert.equal((await listed.json())[0].id, createdId);
  const removed = await request(`api/tasks/${createdId}/`, 'DELETE');
  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), '');
  assert.equal((await request(`api/tasks/${createdId}/`)).status, 404);
  createdId = undefined;
  process.stdout.write('HTTP contracts passed (including authenticated CRUD).\n');
} catch {
  process.stderr.write(
    `HTTP contracts failed at ${lastRequest} (status: ${lastStatus ?? 'no response'}). Inspect private service and gateway logs.\n`,
  );
  process.exitCode = 1;
} finally {
  if (createdId) {
    try {
      await request(`api/tasks/${createdId}/`, 'DELETE');
    } catch {
      process.stderr.write(`Could not clean up test run ${runId}; inspect it manually.\n`);
    }
  }
}
