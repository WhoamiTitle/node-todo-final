export function readConfig(env) {
  const required = (name) => {
    if (!env[name]?.trim()) throw new Error(`Missing ${name}`);
    return env[name];
  };
  const token = required('API_TOKEN');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
    throw new Error('API_TOKEN must contain 32-256 URL-safe characters');
  const port = Number(env.PORT || '30356');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const database = required('MONGO_DATABASE');
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(database)) throw new Error('Invalid MONGO_DATABASE');
  return {
    host: env.HOST || '127.0.0.1',
    port,
    token,
    author: {
      login: required('AUTHOR_LOGIN').trim(),
      fullName: required('AUTHOR_FULL_NAME').trim(),
    },
    mongoUri: required('MONGO_URI'),
    database,
  };
}
