import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTaskService } from '../../src/application/task-service.mjs';
import { memoryRepository } from '../helpers/memory-repository.mjs';

test('server owns identity, id, date and initial completion', async () => {
  const repository = memoryRepository();
  const id = randomUUID();
  const date = new Date('2026-11-10T00:00:00.000Z');
  const author = { login: 'student', fullName: 'Test Student' };
  const service = createTaskService({ repository, author, newId: () => id, now: () => date });
  author.login = 'changed';
  const task = await service.create({ title: '  One task  ', runId: 'manual' });
  assert.deepEqual(task, {
    id,
    ownerLogin: 'student',
    title: 'One task',
    done: false,
    runId: 'manual',
    createdAt: date.toISOString(),
  });
  assert.deepEqual(await service.list('manual'), [task]);
  assert.equal((await service.update(id, { done: true })).done, true);
  assert.equal((await service.update(id, { title: 'Renamed' })).title, 'Renamed');
  await service.remove(id);
  await assert.rejects(() => service.find(id), /task_not_found/);
});

test('every operation is scoped to configured owner', async () => {
  const repository = memoryRepository();
  const id = randomUUID();
  repository.records.set(id, {
    id,
    ownerLogin: 'someone_else',
    runId: 'manual',
    title: 'Other',
    done: false,
  });
  const service = createTaskService({
    repository,
    author: { login: 'student' },
    newId: randomUUID,
    now: () => new Date(),
  });
  assert.deepEqual(await service.list('manual'), []);
  await assert.rejects(() => service.find(id), /task_not_found/);
  await assert.rejects(() => service.update(id, { title: 'Changed' }), /task_not_found/);
  await assert.rejects(() => service.remove(id), /task_not_found/);
  assert.equal(repository.records.get(id).title, 'Other');
});
