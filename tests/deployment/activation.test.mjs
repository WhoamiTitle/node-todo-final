import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  symlink,
  readlink,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const first = 'a'.repeat(40),
  second = 'b'.repeat(40);
const source = fileURLToPath(new URL('../../deploy/helios/', import.meta.url));

function restored(error) {
  assert.match(error.stderr, /Previous state restored/);
  return true;
}

async function fixture(t, failure = '') {
  const directory = await mkdtemp(join(tmpdir(), 'todo-activate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, '.node-todo-final');
  const publicPath = join(directory, 'public_html/todo');
  const bin = join(directory, 'bin');
  for (const path of [
    bin,
    publicPath,
    ...['run', 'config', 'logs', 'runtime/bin', 'data/mongo'].map((p) => join(root, p)),
  ]) {
    await mkdir(path, { recursive: true });
  }
  await symlink(process.execPath, join(root, 'runtime/bin/node'));
  // This fixture checks activation/rollback flow, not FreeBSD lockf semantics or daemon behaviour.
  await writeFile(join(bin, 'lockf'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (failure === 'metadata') {
    await writeFile(
      join(bin, 'mv'),
      `#!/bin/sh
for dest do :; done
if test "$dest" = '${root}/publication-mode' && test "$(readlink '${root}/current')" = '${root}/releases/${second}'; then exit 74; fi
exec /bin/mv "$@"\n`,
      { mode: 0o755 },
    );
  }
  await writeFile(join(root, 'config/app.env'), 'PORT=30356\n');
  await writeFile(join(root, 'config/db.initialized'), 'fixture\n');
  await writeFile(join(root, 'config/db-access-approved'), 'fixture\n');
  await writeFile(join(root, 'data/mongo/data'), 'must-survive\n');
  await writeFile(join(publicPath, 'index.php'), '<?php echo "previous";\n');
  await writeFile(join(publicPath, '.htaccess'), '# previous\n');
  await writeFile(join(publicPath, '.todo-managed'), `${first}\n`);
  for (const release of [first, second]) {
    const helpers = join(root, 'releases', release, 'deploy/helios');
    await mkdir(helpers, { recursive: true });
    for (const file of [
      'activate.sh',
      'common.sh',
      'switch-release.mjs',
      'render-gateway.mjs',
      'gateway.php',
      'public.htaccess',
    ]) {
      await copyFile(join(source, file), join(helpers, file));
    }
    await writeFile(join(root, 'releases', release, '.installed'), 'fixture');
    await writeFile(
      join(helpers, 'service.sh'),
      `#!/bin/sh\nprintf '%s\\n' "$2" >> "$1/run/actions"\nexit 0\n`,
    );
    const fail = release === second ? failure : '';
    await writeFile(
      join(helpers, 'contracts.mjs'),
      `const fail = ${JSON.stringify(fail)}; if (fail === 'local' || (fail === 'public' && process.argv[2].startsWith('https:'))) process.exit(1);\n`,
    );
  }
  await symlink(join(root, 'releases', first), join(root, 'current'));
  const activate = (release, mode) =>
    run(
      'sh',
      [
        join(root, 'releases', release, 'deploy/helios/activate.sh'),
        root,
        release,
        publicPath,
        'https://se.ifmo.ru/~tester/todo/',
        ...(mode === undefined ? [] : [mode]),
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
  return { root, publicPath, activate };
}

test('activation and explicit rollback change code/gateway, never database/configuration', async (t) => {
  const { root, publicPath, activate } = await fixture(t);
  await activate(second);
  assert.equal(await readlink(join(root, 'current')), join(root, 'releases', second));
  assert.equal((await readFile(join(publicPath, '.todo-managed'), 'utf8')).trim(), second);
  assert.equal((await readFile(join(root, 'previous-release'), 'utf8')).trim(), first);
  assert.equal(await readFile(join(root, 'publication-mode'), 'utf8'), 'approved\n');
  assert.match(
    await readFile(join(publicPath, 'index.php'), 'utf8'),
    /todoGateway\('\/~tester\/todo'/,
  );
  await activate(first, 'rollback');
  assert.equal(await readlink(join(root, 'current')), join(root, 'releases', first));
  assert.equal(await readFile(join(root, 'deployed-release'), 'utf8'), `${first}\n`);
  assert.equal(await readFile(join(root, 'previous-release'), 'utf8'), `${second}\n`);
  assert.equal(await readFile(join(root, 'data/mongo/data'), 'utf8'), 'must-survive\n');
  assert.equal(await readFile(join(root, 'config/app.env'), 'utf8'), 'PORT=30356\n');
});

for (const stage of ['local', 'public']) {
  test(`failed ${stage} contracts restore old code and gateway without data rollback`, async (t) => {
    const { root, publicPath, activate } = await fixture(t, stage);
    await assert.rejects(activate(second), restored);
    assert.equal(await readlink(join(root, 'current')), join(root, 'releases', first));
    assert.equal(await readFile(join(publicPath, 'index.php'), 'utf8'), '<?php echo "previous";\n');
    assert.equal((await readFile(join(publicPath, '.todo-managed'), 'utf8')).trim(), first);
    assert.equal(await readFile(join(root, 'data/mongo/data'), 'utf8'), 'must-survive\n');
    if (stage === 'public')
      assert.equal((await stat(join(publicPath, 'index.php'))).mode & 0o777, 0o644);
  });
}

test('publication requires DB access agreement and refuses unmanaged public directories', async (t) => {
  const { root, publicPath, activate } = await fixture(t);
  await rm(join(root, 'config/db-access-approved'));
  await assert.rejects(activate(second), /Agree independent DB access/);
  await writeFile(join(root, 'config/db-access-approved'), 'fixture');
  await rm(join(publicPath, '.todo-managed'));
  await assert.rejects(activate(second), /unmanaged public directory/);
  await assert.rejects(activate(second, 'preview'), /unmanaged public directory/);
  assert.equal(await readlink(join(root, 'current')), join(root, 'releases', first));
});

test('first preview publishes without claiming DB agreement; approved deployment stays gated', async (t) => {
  const { root, publicPath, activate } = await fixture(t);
  await rm(join(root, 'config/db-access-approved'));
  await rm(join(root, 'current'));
  await rm(publicPath, { recursive: true });
  await activate(second, 'preview');
  assert.equal(await readFile(join(root, 'publication-mode'), 'utf8'), 'preview\n');
  assert.match(await readFile(join(publicPath, 'index.php'), 'utf8'), /, 'preview'\);/);
  await assert.rejects(stat(join(root, 'config/db-access-approved')), { code: 'ENOENT' });
  await assert.rejects(activate(first), /Agree independent DB access/);
  await activate(first, 'rollback');
  assert.equal(await readlink(join(root, 'current')), join(root, 'releases', first));
  assert.equal(await readFile(join(root, 'publication-mode'), 'utf8'), 'preview\n');
  assert.match(await readFile(join(publicPath, 'index.php'), 'utf8'), /, 'preview'\);/);
  assert.equal(await readFile(join(root, 'data/mongo/data'), 'utf8'), 'must-survive\n');
  assert.equal(await readFile(join(root, 'config/app.env'), 'utf8'), 'PORT=30356\n');
  await assert.rejects(stat(join(root, 'config/db-access-approved')), { code: 'ENOENT' });
});

test('promotion requires recorded agreement and changes the published mode only on success', async (t) => {
  const { root, publicPath, activate } = await fixture(t);
  await rm(join(root, 'config/db-access-approved'));
  await activate(first, 'preview');
  await assert.rejects(activate(second), /Agree independent DB access/);
  await writeFile(join(root, 'config/db-access-approved'), 'fixture agreement\n');
  await activate(second);
  assert.equal(await readFile(join(root, 'publication-mode'), 'utf8'), 'approved\n');
  assert.match(await readFile(join(publicPath, 'index.php'), 'utf8'), /, 'approved'\);/);
  assert.equal(
    await readFile(join(root, 'config/db-access-approved'), 'utf8'),
    'fixture agreement\n',
  );
});

for (const stage of ['local', 'public', 'metadata']) {
  test(`failed ${stage} preview update and promotion restore the previous preview`, async (t) => {
    const { root, publicPath, activate } = await fixture(t, stage);
    await rm(join(root, 'config/db-access-approved'));
    await rm(join(root, 'current'));
    await rm(publicPath, { recursive: true });
    await activate(first, 'preview');
    const gateway = await readFile(join(publicPath, 'index.php'), 'utf8');
    await assert.rejects(activate(second, 'preview'), restored);
    assert.equal(await readFile(join(root, 'publication-mode'), 'utf8'), 'preview\n');
    assert.equal(await readFile(join(publicPath, 'index.php'), 'utf8'), gateway);
    await writeFile(join(root, 'config/db-access-approved'), 'fixture agreement\n');
    await assert.rejects(activate(second), restored);
    assert.equal(await readFile(join(root, 'publication-mode'), 'utf8'), 'preview\n');
    assert.equal(await readFile(join(root, 'deployed-release'), 'utf8'), `${first}\n`);
    assert.equal(await readFile(join(root, 'previous-release'), 'utf8'), '\n');
    assert.equal(await readFile(join(publicPath, 'index.php'), 'utf8'), gateway);
    assert.equal(await readlink(join(root, 'current')), join(root, 'releases', first));
    assert.equal(await readFile(join(root, 'data/mongo/data'), 'utf8'), 'must-survive\n');
  });

  test(`failed first ${stage} preview leaves no public gateway or agreement`, async (t) => {
    const { root, publicPath, activate } = await fixture(t, stage);
    await rm(join(root, 'config/db-access-approved'));
    await rm(join(root, 'current'));
    await rm(publicPath, { recursive: true });
    await assert.rejects(activate(second, 'preview'), restored);
    for (const path of [
      publicPath,
      join(root, 'publication-mode'),
      join(root, 'deployed-release'),
      join(root, 'previous-release'),
      join(root, 'config/db-access-approved'),
    ]) {
      await assert.rejects(stat(path), { code: 'ENOENT' });
    }
    await assert.rejects(readlink(join(root, 'current')), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, 'data/mongo/data'), 'utf8'), 'must-survive\n');
    assert.match(await readFile(join(root, 'run/actions'), 'utf8'), /stop-node\nstop\n$/);
  });
}

test('invalid requested or saved publication modes fail before switching code', async (t) => {
  const { root, activate } = await fixture(t);
  await assert.rejects(activate(second, 'anything'), /Invalid publication mode/);
  await writeFile(join(root, 'publication-mode'), 'corrupt\n');
  await assert.rejects(activate(second, 'rollback'), /Invalid saved publication mode/);
  assert.equal(await readlink(join(root, 'current')), join(root, 'releases', first));
  await assert.rejects(stat(join(root, 'run/actions')), { code: 'ENOENT' });
});
