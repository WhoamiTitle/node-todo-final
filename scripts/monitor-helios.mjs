import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const attempts = 3;
const intervalMs = 10000;
const remoteResults = new Set(['healthy', 'started', 'paused', 'busy', 'cooldown', 'disabled']);

export function monitorConfig(env) {
  const user = env.TODO_DEPLOY_USER;
  const host = env.TODO_DEPLOY_HOST || 'helios.cs.ifmo.ru';
  const port = env.TODO_DEPLOY_PORT || '2222';
  const mode = env.TODO_RECOVERY_MODE || 'check';
  if (!/^s\d+$/.test(user || '') || host !== 'helios.cs.ifmo.ru')
    throw new Error('invalid_helios_target');
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('invalid_ssh_port');
  if (!['check', 'recover'].includes(mode)) throw new Error('invalid_monitor_mode');
  return { user, host, port, mode, url: `https://se.ifmo.ru/~${user}/todo/healthz/` };
}

export async function probeHealth(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { healthy: false, reason: `http_${response.status}` };
    if (!response.headers.get('content-type')?.includes('application/json'))
      return { healthy: false, reason: 'not_json' };
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4096) return { healthy: false, reason: 'body_too_large' };
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body?.status === 'ok'
      ? { healthy: true, reason: 'ok' }
      : { healthy: false, reason: 'not_ready' };
  } catch {
    return { healthy: false, reason: 'request_or_body_failed' };
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

export async function recoverOverSsh(env, run = execute) {
  const { user, host, port } = monitorConfig(env);
  const key = env.TODO_RECOVERY_SSH_PRIVATE_KEY;
  const knownHosts = env.HELIOS_KNOWN_HOSTS;
  if (!key?.trim() || !knownHosts?.trim()) throw new Error('missing_recovery_ssh_secrets');
  const directory = await mkdtemp(join(tmpdir(), 'todo-recovery-ssh-'));
  try {
    await chmod(directory, 0o700);
    const keyPath = join(directory, 'key');
    const hostsPath = join(directory, 'known_hosts');
    await writeFile(keyPath, `${key.trim()}\n`, { mode: 0o600 });
    await writeFile(hostsPath, `${knownHosts.trim()}\n`, { mode: 0o600 });
    let stdout;
    try {
      ({ stdout } = await run(
        'ssh',
        [
          '-F',
          '/dev/null',
          '-T',
          '-p',
          port,
          '-i',
          keyPath,
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          'GlobalKnownHostsFile=/dev/null',
          '-o',
          `UserKnownHostsFile=${hostsPath}`,
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'ConnectTimeout=15',
          '-o',
          'ServerAliveInterval=10',
          '-o',
          'ServerAliveCountMax=3',
          `${user}@${host}`,
          'todo-recover',
        ],
        {
          timeout: 180000,
          maxBuffer: 65536,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C' },
        },
      ));
    } catch {
      throw new Error('ssh_recovery_failed_check_private_server_logs');
    }
    const results = stdout
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('TODO_RECOVERY_RESULT='));
    const result = results[0]?.slice('TODO_RECOVERY_RESULT='.length);
    if (results.length !== 1 || !remoteResults.has(result))
      throw new Error('invalid_recovery_response');
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function monitor({
  url,
  mode = 'check',
  enabled = false,
  probe = probeHealth,
  recover,
  wait = delay,
  log = () => {},
}) {
  async function check(phase) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await probe(url);
      log(`${phase} ${attempt}/${attempts}: ${result.reason}`);
      if (result.healthy) return true;
      if (attempt < attempts) await wait(intervalMs);
    }
    return false;
  }
  if (await check('Health')) return 'healthy';
  if (mode === 'check') throw new Error('https_health_failed_check_only');
  if (!enabled) throw new Error('recovery_disabled_set_repository_variable_after_agreement');
  const result = await recover();
  if (result === 'disabled') throw new Error('recovery_not_allowed_on_server');
  if (['paused', 'busy', 'cooldown'].includes(result)) return result;
  if (!['healthy', 'started'].includes(result)) throw new Error('invalid_recovery_response');
  if (!(await check('After recovery'))) throw new Error('https_still_unhealthy_after_recovery');
  return result === 'started' ? 'recovered' : 'healthy_after_local_check';
}

async function main() {
  let result = 'failed';
  try {
    const config = monitorConfig(process.env);
    result = await monitor({
      ...config,
      enabled: process.env.TODO_RECOVERY_ENABLED === 'true',
      recover: () => recoverOverSsh(process.env),
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(`TODO monitor result: ${result}\n`);
    if (['paused', 'busy', 'cooldown'].includes(result))
      process.stdout.write('::notice::Recovery deferred; HTTPS health has not been confirmed.\n');
  } catch (error) {
    process.stderr.write(`TODO monitor failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `## TODO availability\n\nResult: \`${result}\`\n\n` +
          'Only the existing release may be started; no deploy or database initialization is performed.\n',
      );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
