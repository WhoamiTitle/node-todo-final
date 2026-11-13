import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const source = fileURLToPath(new URL('../../deploy/helios/', import.meta.url));
const revision = 'c'.repeat(40);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'todo-recovery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, '.node-todo-final');
  const helpers = join(root, 'releases', revision, 'deploy/helios');
  const bin = join(directory, 'bin');
  for (const path of [
    helpers,
    bin,
    ...['run', 'logs', 'config', 'data/mongo'].map((p) => join(root, p)),
  ])
    await mkdir(path, { recursive: true });
  for (const file of ['common.sh', 'recover.sh'])
    await copyFile(join(source, file), join(helpers, file));
  await writeFile(
    join(helpers, 'service.sh'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$2" >> "$1/run/actions"
case "$2" in
  status) test -f "$1/run/ready" ;;
  start)
    test ! -f "$1/run/fail-start"
    test ! -f "$1/run/start-without-readiness" || exit 0
    touch "$1/run/ready"
    ;;
  *) exit 99 ;;
esac
`,
  );
  await symlink(join(root, 'releases', revision), join(root, 'current'));
  for (const [file, data] of Object.entries({
    'deployed-release': `${revision}\n`,
    'publication-mode': 'preview\n',
    [`releases/${revision}/.installed`]: 'fixture\n',
    'config/db.initialized': 'fixture\n',
    'config/autorecovery.allowed': 'fixture permission\n',
    'config/app.env': 'must-not-change-config\n',
    'data/mongo/data': 'must-not-change-data\n',
  }))
    await writeFile(join(root, file), data);
  // Non-FreeBSD fixtures exercise decisions, not lockf's kernel semantics.
  if (process.platform !== 'freebsd') {
    await writeFile(
      join(bin, 'lockf'),
      `#!/bin/sh
test "$*" = '-s -t 1 9' || exit 99
test ! -f '${root}/run/lock-error' || exit 73
test ! -f '${root}/run/lock-busy' || exit 75
exit 0
`,
      { mode: 0o755 },
    );
    const common = await readFile(join(helpers, 'common.sh'), 'utf8');
    await writeFile(join(helpers, 'common.sh'), `${common}\nPATH='${bin}':$PATH\n`);
  }
  const recover = (command = 'todo-recover') =>
    run('sh', [join(helpers, 'recover.sh'), root], {
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
      timeout: 15000,
    });
  const actions = async () =>
    readFile(join(root, 'run/actions'), 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return '';
      throw e;
    });
  const unchanged = async () => {
    assert.equal(await readlink(join(root, 'current')), join(root, 'releases', revision));
    assert.equal(await readFile(join(root, 'publication-mode'), 'utf8'), 'preview\n');
    assert.equal(await readFile(join(root, 'config/app.env'), 'utf8'), 'must-not-change-config\n');
    assert.equal(await readFile(join(root, 'data/mongo/data'), 'utf8'), 'must-not-change-data\n');
    await assert.rejects(stat(join(root, 'config/db-access-approved')), { code: 'ENOENT' });
  };
  return { root, recover, actions, unchanged };
}

test('recovery rejects arbitrary SSH commands, shell and subsystem requests', async (t) => {
  const f = await fixture(t);
  for (const command of [
    '',
    'sh',
    'todo-recover; id',
    'todo-recover extra',
    'internal-sftp',
    'scp -t /tmp',
  ])
    await assert.rejects(f.recover(command), /Only todo-recover is allowed/);
  assert.equal(await f.actions(), '');
  await f.unchanged();
});

test('recovery requires a separate administrative opt-in and honors maintenance', async (t) => {
  const f = await fixture(t);
  const allowed = join(f.root, 'config/autorecovery.allowed');
  await rm(allowed);
  assert.match((await f.recover()).stdout, /TODO_RECOVERY_RESULT=disabled/);
  await writeFile(allowed, 'fixture permission');
  await writeFile(join(f.root, 'config/autorecovery.paused'), 'maintenance');
  assert.match((await f.recover()).stdout, /TODO_RECOVERY_RESULT=paused/);
  assert.equal(await f.actions(), '');
  await f.unchanged();
});

test('a healthy service is checked without a start or last-start timestamp', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'run/ready'), 'ready');
  assert.match((await f.recover()).stdout, /TODO_RECOVERY_RESULT=healthy/);
  assert.equal(await f.actions(), 'status\n');
  await assert.rejects(stat(join(f.root, 'run/recovery.last-start')), { code: 'ENOENT' });
  await f.unchanged();
});

test('recovery starts only the active release and preserves data, configuration and mode', async (t) => {
  const f = await fixture(t);
  assert.match((await f.recover()).stdout, /TODO_RECOVERY_RESULT=started/);
  assert.equal(await f.actions(), 'status\nstart\nstatus\n');
  assert.match(
    await readFile(join(f.root, 'logs/recovery.log'), 'utf8'),
    /start release=.* mode=preview\n.* ready\n/,
  );
  assert.match((await f.recover()).stdout, /TODO_RECOVERY_RESULT=healthy/);
  assert.equal((await f.actions()).split('\n').filter((x) => x === 'start').length, 1);
  await f.unchanged();
});

test('a failed start or missing readiness is reported and is not retried during cooldown', async (t) => {
  for (const flag of ['fail-start', 'start-without-readiness']) {
    await t.test(flag, async (t) => {
      const f = await fixture(t);
      await writeFile(join(f.root, `run/${flag}`), 'fixture');
      await assert.rejects(f.recover(), /Service start failed|not ready after start/);
      assert.match((await f.recover()).stdout, /TODO_RECOVERY_RESULT=cooldown/);
      assert.equal((await f.actions()).split('\n').filter((x) => x === 'start').length, 1);
      await f.unchanged();
    });
  }
});

test('corrupt timestamps, symlinked control files and mismatched releases fail closed', async (t) => {
  for (const scenario of [
    'timestamp',
    'future-timestamp',
    'symlink',
    'metadata',
    'mode',
    'not-initialized',
  ]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      if (scenario === 'timestamp')
        await writeFile(join(f.root, 'run/recovery.last-start'), 'not-an-epoch');
      if (scenario === 'future-timestamp')
        await writeFile(join(f.root, 'run/recovery.last-start'), '9999999999');
      if (scenario === 'symlink')
        await symlink(join(f.root, 'config/app.env'), join(f.root, 'logs/recovery.log'));
      if (scenario === 'metadata')
        await writeFile(join(f.root, 'deployed-release'), `${'d'.repeat(40)}\n`);
      if (scenario === 'mode') await writeFile(join(f.root, 'publication-mode'), 'unknown\n');
      if (scenario === 'not-initialized') await rm(join(f.root, 'config/db.initialized'));
      await assert.rejects(f.recover());
      assert(!(await f.actions()).split('\n').includes('start'));
      assert.equal(
        await readFile(join(f.root, 'data/mongo/data'), 'utf8'),
        'must-not-change-data\n',
      );
      assert.equal(
        await readFile(join(f.root, 'config/app.env'), 'utf8'),
        'must-not-change-config\n',
      );
    });
  }
});

test(
  'lock contention defers, whereas a broken lock causes an error',
  { skip: process.platform === 'freebsd' },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.root, 'run/lock-busy'), 'fixture');
    assert.match((await f.recover()).stdout, /TODO_RECOVERY_RESULT=busy/);
    await rm(join(f.root, 'run/lock-busy'));
    await writeFile(join(f.root, 'run/lock-error'), 'fixture');
    await assert.rejects(f.recover(), /Could not acquire the deployment lock/);
    assert.equal(await f.actions(), '');
    await f.unchanged();
  },
);

test(
  'real FreeBSD deployment lock excludes recovery until released',
  { skip: process.platform !== 'freebsd' },
  async (t) => {
    const f = await fixture(t);
    const holder = spawn(
      'sh',
      [
        '-c',
        'exec 9>> "$1"; lockf -s -t 1 9 || exit; printf "locked\\n"; read -r stop',
        'fixture',
        join(f.root, 'run/deployment.guard'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const closed = once(holder, 'close');
    try {
      assert.equal((await once(holder.stdout, 'data'))[0].toString(), 'locked\n');
      assert.match((await f.recover()).stdout, /TODO_RECOVERY_RESULT=busy/);
      assert.equal(await f.actions(), '');
    } finally {
      holder.stdin.end('stop\n');
      await closed;
    }
    assert.match((await f.recover()).stdout, /TODO_RECOVERY_RESULT=started/);
    await f.unchanged();
  },
);
