import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { renderGateway } from '../../deploy/helios/render-gateway.mjs';

const run = promisify(execFile);
const docker = (...args) => run('docker', args, { maxBuffer: 4 * 1024 * 1024 });
const name = `todo-apache-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), 'todo-apache-'));
const child = join(directory, '~tester/todo');
let started = false;
let built = false;
try {
  await renderGateway(child, '/~tester/todo', 30356, 'preview');
  for (const path of [directory, join(directory, '~tester'), child]) await chmod(path, 0o755);
  await copyFile(
    new URL('../fixtures/portfolio.htaccess', import.meta.url),
    join(directory, '.htaccess'),
  );
  await writeFile(
    join(directory, 'index.php'),
    '<?php http_response_code(404); echo "portfolio fallback";',
  );
  const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
  await docker('build', '--file', join(fixtures, 'Apache.Dockerfile'), '--tag', name, fixtures);
  built = true;
  await docker(
    'run',
    '--detach',
    '--name',
    name,
    '--publish',
    '127.0.0.1::80',
    '--volume',
    `${directory}:/var/www/html:ro`,
    name,
  );
  started = true;
  const port = (await docker('port', name, '80/tcp')).stdout.trim().split(':').at(-1);
  const base = `http://127.0.0.1:${port}/~tester/todo/`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(new URL('api/author/', base), {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for this test-owned Apache. */
    }
    await delay(250);
  }
  assert.equal(ready, true, 'Apache did not route through the child gateway');
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const response = await fetch(new URL('api/tasks/?runId=apache', base), {
      method,
      headers: {
        Authorization: 'Bearer disposable-apache-test',
        'Content-Type': 'application/json',
      },
      ...(['POST', 'PATCH'].includes(method) ? { body: '{"title":"test"}' } : {}),
      redirect: 'error',
    });
    assert.equal(response.status, ['DELETE', 'OPTIONS'].includes(method) ? 204 : 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('x-todo-mode'), 'preview');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    if (!['DELETE', 'OPTIONS', 'HEAD'].includes(method)) {
      const result = await response.json();
      assert.equal(result.method, method);
      assert.equal(result.authorization, 'Bearer disposable-apache-test');
      assert.equal(result.uri, '/api/tasks/?runId=apache');
      if (['POST', 'PATCH'].includes(method)) assert.equal(result.body, '{"title":"test"}');
    } else assert.equal(await response.text(), '');
  }
  process.stdout.write(
    'Apache parent/child rewrite, Authorization, methods, JSON and 204 contracts passed.\n',
  );
} catch (error) {
  if (started) process.stderr.write((await docker('logs', name)).stderr);
  throw error;
} finally {
  if (started) {
    await docker('stop', '--time', '10', name);
    await docker('rm', name);
  }
  if (built) await docker('image', 'rm', name);
  await rm(directory, { recursive: true, force: true });
}
