import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('every pinned FreeBSD archive has one SHA256 fingerprint', async () => {
  const archives = (
    await readFile(new URL('../../deploy/helios/freebsd-packages.txt', import.meta.url), 'utf8')
  )
    .trim()
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((path) => {
      assert.match(path, /^All\/Hashed\/[^/\s]+\.pkg$/);
      return path.split('/').at(-1);
    });
  const pins = (
    await readFile(new URL('../../deploy/helios/freebsd-packages.sha256', import.meta.url), 'utf8')
  )
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^[a-f0-9]{64}\s+([^/\s]+\.pkg)$/.exec(line);
      assert.ok(match, `Invalid SHA256 pin: ${line}`);
      return match[1];
    });
  assert.ok(archives.length > 0, 'Empty FreeBSD package manifest');
  assert.equal(new Set(archives).size, archives.length, 'Duplicate FreeBSD archive');
  assert.deepEqual(pins.sort(), archives.sort(), 'Expected exactly one pin per archive');
});
