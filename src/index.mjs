import { randomUUID } from 'node:crypto';
import { readConfig } from './config.mjs';
import { createTaskService } from './application/task-service.mjs';
import { createMongoClient, createMongoTaskRepository } from './infrastructure/mongo.mjs';
import { createApp } from './presentation/app.mjs';

const config = readConfig(process.env);
const client = createMongoClient(config.mongoUri);
const service = createTaskService({
  repository: createMongoTaskRepository(client.db(config.database)),
  author: config.author,
  now: () => new Date(),
  newId: randomUUID,
});
const app = createApp({
  service,
  token: config.token,
  logError: (event, kind) => process.stderr.write(`${JSON.stringify({ event, kind })}\n`),
});
const server = app.listen(config.port, config.host, () => {
  process.stdout.write(`Listening on http://${config.host}:${config.port}/\n`);
});
server.on('error', async (error) => {
  process.stderr.write(`Listen failed: ${error.code}\n`);
  await client.close();
  process.exitCode = 1;
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 8000);
  deadline.unref();
  await new Promise((resolve) => server.close(resolve));
  await client.close();
  clearTimeout(deadline);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
