import { readConfig } from '../../src/config.mjs';
import { createMongoClient, createMongoTaskRepository } from '../../src/infrastructure/mongo.mjs';

const config = readConfig(process.env);
try {
  if (process.argv[2] === 'db') {
    const client = createMongoClient(config.mongoUri);
    try {
      await createMongoTaskRepository(client.db(config.database)).check();
    } finally {
      await client.close();
    }
  } else {
    const response = await fetch(`http://127.0.0.1:${config.port}/healthz/`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (await response.json()).status !== 'ok') throw new Error('not_ready');
  }
} catch {
  process.stderr.write('Readiness failed; inspect private service logs.\n');
  process.exitCode = 1;
}
