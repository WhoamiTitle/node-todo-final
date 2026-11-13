import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, copyFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const source = fileURLToPath(new URL('../../', import.meta.url));

test('release comes from a clean committed tree and excludes secrets/dependencies', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'todo-package-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const app = repository;
  for (const subdir of ['src', 'public', 'deploy/helios', 'scripts', 'node_modules']) {
    await mkdir(join(app, subdir), { recursive: true });
  }
  for (const file of ['package-release.sh', 'assets.mjs'])
    await copyFile(join(source, 'scripts', file), join(app, 'scripts', file));
  for (const [file, data] of Object.entries({
    'package.json': '{"name":"release-fixture"}',
    'package-lock.json': '{}',
    '.env.example': 'API_TOKEN=\n',
    'src/index.mjs': 'export const example = true;\n',
    'public/index.html': '<!doctype html>',
    'deploy/helios/example.sh': '#!/bin/sh\n',
    'scripts/init-db.mjs': '// fixture\n',
    '.gitignore': '.env\nnode_modules/\n.local/\npublic/icons/\n',
  }))
    await writeFile(join(app, file), data);
  await symlink(
    join(source, 'node_modules/lucide-static'),
    join(app, 'node_modules/lucide-static'),
  );
  await writeFile(join(app, '.env'), 'SENSITIVE_DO_NOT_PACKAGE');
  await writeFile(join(app, 'public/.env'), 'SENSITIVE_DO_NOT_PACKAGE');
  const git = (...args) =>
    run(
      'git',
      [
        '-c',
        'init.defaultBranch=main',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Deployment Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { cwd: repository },
    );
  await git('init');
  await git('add', '.');
  await git('commit', '-m', 'test fixture');
  const packageScript = join(app, 'scripts/package-release.sh');
  const result = await run('sh', [packageScript], { cwd: repository });
  const archive = result.stdout.trim();
  const listing = (await run('tar', ['-tf', archive])).stdout;
  assert.match(listing, /REVISION/);
  assert.match(listing, /public\/icons\/plus.svg/);
  assert.doesNotMatch(listing, /node_modules|\/\.env\n|data\/|\.git\//);
  assert.match(listing, /\.env.example/);
  const extracted = join(repository, '.local/extracted');
  await mkdir(extracted, { recursive: true });
  await run('tar', ['-xf', archive, '-C', extracted]);
  assert.equal(
    (await readFile(join(extracted, 'REVISION'), 'utf8')).trim(),
    (await git('rev-parse', 'HEAD')).stdout.trim(),
  );
  await writeFile(join(app, 'src/index.mjs'), 'changed after commit');
  await assert.rejects(run('sh', [packageScript]), /Commit reviewed TODO changes/);
  await writeFile(join(app, 'src/index.mjs'), 'export const example = true;\n');
  await writeFile(join(app, 'README.md'), 'unreviewed documentation');
  await assert.rejects(run('sh', [packageScript]), /Commit reviewed TODO changes/);
});

test('release refuses a TODO directory nested inside another repository', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'todo-nested-package-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const scripts = join(repository, 'node-todo-final/scripts');
  await mkdir(scripts, { recursive: true });
  const script = join(scripts, 'package-release.sh');
  await copyFile(join(source, 'scripts/package-release.sh'), script);
  await run('git', ['init', '--initial-branch=main'], { cwd: repository });
  await assert.rejects(
    run('sh', [script], { cwd: repository }),
    /Expected the standalone TODO repository root/,
  );
});
