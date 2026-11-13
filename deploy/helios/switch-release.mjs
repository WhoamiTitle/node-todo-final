import { symlink, rename, readlink, lstat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const [root, release] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(release)) throw new Error('Invalid release');
const current = resolve(root, 'current');
try {
  await readlink(current);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const target = resolve(root, 'releases', release);
if (!(await lstat(target)).isDirectory()) throw new Error('Release is not a directory');
const temporary = resolve(root, `current-${randomUUID()}`);
await symlink(target, temporary);
try {
  await rename(temporary, current);
} catch (error) {
  await unlink(temporary);
  throw error;
}
