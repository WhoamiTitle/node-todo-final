import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { TaskNotFoundError, StorageUnavailableError } from '../application/errors.mjs';
import { ValidationError } from '../domain/task.mjs';

const publicDirectory = fileURLToPath(new URL('../../public/', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest();

export function createApp({ service, token, logError = () => {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.enable('strict routing');
  app.enable('case sensitive routing');
  app.set('query parser', 'simple');
  app.use((_request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    });
    next();
  });

  const expectedToken = hash(token);
  app.use('/api', (request, response, next) => {
    // Preflight carries no bearer token; it exposes no application data.
    if (request.method === 'OPTIONS') return response.status(204).end();
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(request.get('Authorization') || '');
    if (!match || !timingSafeEqual(hash(match[1]), expectedToken)) {
      response.set('WWW-Authenticate', 'Bearer');
      return response.status(401).json({ error: 'unauthorized' });
    }
    next();
  });
  app.use(
    '/api',
    (request, _response, next) => {
      if (['POST', 'PATCH'].includes(request.method) && !request.is('application/json')) {
        throw new ValidationError('expected_json');
      }
      next();
    },
    express.json({ limit: '8kb', strict: true, inflate: false }),
  );

  app.get('/login/', (_request, response) =>
    response.type('text/plain').send(service.author().login),
  );
  app.get('/healthz/', async (_request, response) => {
    await service.check();
    response.json({ status: 'ok' });
  });
  app.get('/api/author/', (_request, response) => response.json(service.author()));
  app.post('/api/tasks/', async (request, response) =>
    response.status(201).json(await service.create(request.body)),
  );
  app.get('/api/tasks/', async (request, response) =>
    response.json(await service.list(request.query.runId)),
  );
  app.get('/api/tasks/:id/', async (request, response) =>
    response.json(await service.find(request.params.id)),
  );
  app.patch('/api/tasks/:id/', async (request, response) =>
    response.json(await service.update(request.params.id, request.body)),
  );
  app.delete('/api/tasks/:id/', async (request, response) => {
    await service.remove(request.params.id);
    response.status(204).end();
  });
  app.use('/api', (_request, response) => response.status(404).json({ error: 'route_not_found' }));
  app.use(
    express.static(publicDirectory, { dotfiles: 'deny', redirect: false, etag: false, maxAge: 0 }),
  );
  app.use((_request, response) => response.status(404).json({ error: 'route_not_found' }));
  app.use((error, _request, response, _next) => {
    if (error instanceof ValidationError)
      return response.status(400).json({ error: error.message });
    if (error instanceof TaskNotFoundError)
      return response.status(404).json({ error: error.message });
    if (
      [
        'entity.parse.failed',
        'entity.too.large',
        'encoding.unsupported',
        'charset.unsupported',
        'request.size.invalid',
      ].includes(error.type) ||
      error instanceof URIError
    ) {
      return response.status(400).json({ error: 'invalid_json_or_request' });
    }
    if (error instanceof StorageUnavailableError) {
      logError('database_unavailable', error.cause?.name || 'Error');
      return response.status(503).json({ error: 'database_unavailable' });
    }
    logError('internal_error', error.name || 'Error');
    return response.status(500).json({ error: 'internal_error' });
  });
  return app;
}
