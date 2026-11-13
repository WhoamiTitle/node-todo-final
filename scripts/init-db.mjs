import { createMongoClient } from '../src/infrastructure/mongo.mjs';
import { initializeDatabase } from '../src/infrastructure/schema.mjs';

const required = (name) => {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
};
const database = required('MONGO_DATABASE');
if (!/^[a-zA-Z0-9_-]{1,63}$/.test(database) || ['admin', 'local', 'config'].includes(database)) {
  throw new Error('Refusing to initialize a system or invalid database');
}
const users = ['APP', 'REVIEWER'].map((kind) => ({
  name: required(`MONGO_${kind}_USER`),
  password: required(`MONGO_${kind}_PASSWORD`),
}));
if (users[0].name === users[1].name || users.some(({ password }) => password.length < 32)) {
  throw new Error('Use separate users and passwords of at least 32 characters');
}
const client = createMongoClient(required('MONGO_ADMIN_URI'));
try {
  await initializeDatabase(client.db(database), users);
  process.stdout.write('Tasks collection, indexes and two restricted accounts initialized.\n');
} finally {
  await client.close();
}
