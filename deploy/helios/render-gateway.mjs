import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function renderGateway(directory, prefix, port, mode = 'approved') {
  if (!['approved', 'preview'].includes(mode)) throw new Error('Invalid publication mode');
  if (!/^\/~[a-zA-Z0-9_-]+\/todo$/.test(prefix)) throw new Error('Invalid public prefix');
  if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error('Invalid backend port');
  const source = await readFile(new URL('./gateway.php', import.meta.url), 'utf8');
  const htaccess = await readFile(new URL('./public.htaccess', import.meta.url));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(directory, 'index.php'),
    `${source}\ntodoGateway('${prefix}', 'http://127.0.0.1:${Number(port)}', '${mode}');\n`,
    { mode: 0o644 },
  );
  await writeFile(resolve(directory, '.htaccess'), htaccess, { mode: 0o644 });
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  await renderGateway(process.argv[2], process.argv[3], process.argv[4], process.argv[5]);
}
