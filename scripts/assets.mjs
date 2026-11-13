import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = new URL('../node_modules/lucide-static/', import.meta.url);
const target = process.argv[2]
  ? pathToFileURL(`${resolve(process.argv[2])}/`)
  : new URL('../public/icons/', import.meta.url);
await mkdir(target, { recursive: true });
for (const name of [
  'clipboard-list',
  'notebook-pen',
  'arrow-right',
  'plus',
  'pencil',
  'trash-2',
  'refresh-cw',
  'log-out',
  'check',
  'x',
  'key-round',
  'list-checks',
]) {
  await copyFile(new URL(`icons/${name}.svg`, source), new URL(`${name}.svg`, target));
}
await copyFile(new URL('LICENSE', source), new URL('LICENSE', target));
