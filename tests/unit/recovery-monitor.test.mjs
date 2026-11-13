import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  monitorConfig,
  probeHealth,
  monitor,
  recoverOverSsh,
} from '../../scripts/monitor-helios.mjs';

const healthy = { healthy: true, reason: 'ok' };
const down = { healthy: false, reason: 'http_502' };
const env = {
  TODO_DEPLOY_USER: 's507353',
  TODO_RECOVERY_MODE: 'recover',
  TODO_RECOVERY_SSH_PRIVATE_KEY: 'fixture-not-a-real-private-key',
  HELIOS_KNOWN_HOSTS: 'fixture-known-host',
};
const url = monitorConfig(env).url;

test('monitor targets only the configured Helios TODO health endpoint', () => {
  assert.equal(url, 'https://se.ifmo.ru/~s507353/todo/healthz/');
  for (const overrides of [
    { TODO_DEPLOY_USER: 's1;id' },
    { TODO_DEPLOY_USER: '' },
    { TODO_DEPLOY_USER: '../other' },
    { TODO_DEPLOY_HOST: 'other.example' },
    { TODO_DEPLOY_PORT: '0' },
    { TODO_DEPLOY_PORT: '65536' },
    { TODO_DEPLOY_PORT: '22 -o ProxyCommand=id' },
    { TODO_RECOVERY_MODE: 'deploy' },
  ])
    assert.throws(() => monitorConfig({ ...env, ...overrides }));
});

test('health requires HTTP 200 with small JSON containing status ok, never a redirect', async () => {
  const responses = [
    [Response.json({ status: 'ok' }), 'ok'],
    [Response.json({ status: 'error' }), 'not_ready'],
    [Response.json(null), 'not_ready'],
    [Response.json({ status: 'ok' }, { status: 503 }), 'http_503'],
    [new Response('gateway error', { status: 502 }), 'http_502'],
    [new Response('<html>login</html>'), 'not_json'],
    [new Response('', { status: 302 }), 'http_302'],
    [
      new Response('not-json', { headers: { 'Content-Type': 'application/json' } }),
      'request_or_body_failed',
    ],
    [Response.json({ status: 'ok', data: 'x'.repeat(5000) }), 'body_too_large'],
  ];
  for (const [response, reason] of responses) {
    const result = await probeHealth(url, {
      fetchImpl: async (target, options) => {
        assert.equal(target, url);
        assert.equal(options.redirect, 'error');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.headers.Authorization, undefined);
        assert(options.signal instanceof AbortSignal);
        return response;
      },
    });
    assert.deepEqual(result, { healthy: reason === 'ok', reason });
  }
});

test('health probe bounds a real stalled HTTP response and closes its connection', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const started = Date.now();
  const result = await probeHealth(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 100 });
  assert.equal(result.healthy, false);
  assert(Date.now() - started < 2000);
});

test('one healthy probe or a transient failure never invokes SSH', async () => {
  for (const sequence of [[healthy], [down, healthy], [down, down, healthy]]) {
    let probes = 0;
    const waits = [];
    const result = await monitor({
      url,
      mode: 'recover',
      enabled: true,
      probe: async () => sequence[probes++],
      recover: async () => assert.fail('Unexpected SSH command'),
      wait: async (ms) => waits.push(ms),
    });
    assert.equal(result, 'healthy');
    assert.equal(probes, sequence.length);
    assert.deepEqual(waits, Array(sequence.length - 1).fill(10000));
  }
});

test('check-only mode and the disabled switch fail on outage without SSH', async () => {
  for (const [mode, enabled, message] of [
    ['check', true, 'https_health_failed_check_only'],
    ['recover', false, 'recovery_disabled'],
  ]) {
    let probes = 0;
    await assert.rejects(
      monitor({
        url,
        mode,
        enabled,
        probe: async () => {
          probes += 1;
          return down;
        },
        recover: async () => assert.fail('Unexpected SSH command'),
        wait: async () => {},
      }),
      new RegExp(message),
    );
    assert.equal(probes, 3);
  }
});

test('confirmed outage starts once and requires subsequent public health success', async () => {
  let probes = 0,
    starts = 0;
  const sequence = [down, down, down, down, healthy];
  const result = await monitor({
    url,
    mode: 'recover',
    enabled: true,
    probe: async () => sequence[probes++],
    recover: async () => {
      starts += 1;
      return 'started';
    },
    wait: async () => {},
  });
  assert.equal(result, 'recovered');
  assert.equal(starts, 1);
  assert.equal(probes, 5);
});

test('maintenance, deployment lock and cooldown defer without claiming recovered health', async () => {
  for (const state of ['paused', 'busy', 'cooldown']) {
    let probes = 0;
    assert.equal(
      await monitor({
        url,
        mode: 'recover',
        enabled: true,
        probe: async () => {
          probes += 1;
          return down;
        },
        recover: async () => state,
        wait: async () => {},
      }),
      state,
    );
    assert.equal(probes, 3);
  }
});

test('server refusal and remaining public outage fail without a repeated start', async () => {
  for (const [state, message, expectedProbes] of [
    ['disabled', 'not_allowed_on_server', 3],
    ['started', 'https_still_unhealthy', 6],
    ['healthy', 'https_still_unhealthy', 6],
    ['unexpected', 'invalid_recovery_response', 3],
  ]) {
    let probes = 0,
      starts = 0;
    await assert.rejects(
      monitor({
        url,
        mode: 'recover',
        enabled: true,
        probe: async () => {
          probes += 1;
          return down;
        },
        recover: async () => {
          starts += 1;
          return state;
        },
        wait: async () => {},
      }),
      new RegExp(message),
    );
    assert.equal(starts, 1);
    assert.equal(probes, expectedProbes);
  }
});

test('SSH uses private temporary files, verified host keys and a fixed command, then removes keys', async () => {
  let directory;
  const result = await recoverOverSsh(env, async (command, args, options) => {
    assert.equal(command, 'ssh');
    assert.equal(args.at(-1), 'todo-recover');
    assert.equal(args.at(-2), 's507353@helios.cs.ifmo.ru');
    assert(args.includes('BatchMode=yes'));
    assert(args.includes('StrictHostKeyChecking=yes'));
    assert(args.includes('GlobalKnownHostsFile=/dev/null'));
    assert(args.includes('ClearAllForwardings=yes'));
    const key = args[args.indexOf('-i') + 1];
    directory = dirname(key);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(key)).mode & 0o777, 0o600);
    assert.equal((await stat(`${directory}/known_hosts`)).mode & 0o777, 0o600);
    assert.equal(await readFile(key, 'utf8'), `${env.TODO_RECOVERY_SSH_PRIVATE_KEY}\n`);
    assert.equal(options.timeout, 180000);
    assert.equal(options.maxBuffer, 65536);
    assert.equal(options.env.TODO_RECOVERY_SSH_PRIVATE_KEY, undefined);
    assert.equal(options.env.HELIOS_KNOWN_HOSTS, undefined);
    return { stdout: 'Service log\nTODO_RECOVERY_RESULT=started\n' };
  });
  assert.equal(result, 'started');
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('SSH failures and malformed output are sanitized and temporary credentials are removed', async () => {
  for (const scenario of ['ssh-error', 'missing', 'duplicate', 'unknown']) {
    let directory;
    await assert.rejects(
      recoverOverSsh(env, async (_command, args) => {
        directory = dirname(args[args.indexOf('-i') + 1]);
        if (scenario === 'ssh-error') throw new Error(env.TODO_RECOVERY_SSH_PRIVATE_KEY);
        return {
          stdout: {
            missing: '',
            duplicate: 'TODO_RECOVERY_RESULT=started\nTODO_RECOVERY_RESULT=healthy',
            unknown: 'TODO_RECOVERY_RESULT=deploy',
          }[scenario],
        };
      }),
      (error) => {
        assert(!error.message.includes(env.TODO_RECOVERY_SSH_PRIVATE_KEY));
        return /ssh_recovery_failed|invalid_recovery_response/.test(error.message);
      },
    );
    await assert.rejects(access(directory), { code: 'ENOENT' });
  }
  await assert.rejects(
    recoverOverSsh({ ...env, HELIOS_KNOWN_HOSTS: '' }),
    /missing_recovery_ssh_secrets/,
  );
});
