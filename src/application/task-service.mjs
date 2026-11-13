import { validateChanges, validateCreation, validateId, validateRunId } from '../domain/task.mjs';
import { TaskNotFoundError } from './errors.mjs';

/**
 * repository implements insert(task), list(owner, runId), find(owner, id),
 * update(owner, id, changes), remove(owner, id), check().
 * Tasks at this boundary contain only API fields; createdAt is an ISO string.
 */
export function createTaskService({ repository, author, newId, now }) {
  const identity = Object.freeze({ login: author.login, fullName: author.fullName });
  const requireTask = (task) => {
    if (!task) throw new TaskNotFoundError();
    return task;
  };

  return {
    author: () => ({ ...identity }),
    async create(body) {
      const input = validateCreation(body);
      const task = {
        id: newId(),
        ownerLogin: identity.login,
        title: input.title,
        done: false,
        runId: input.runId,
        createdAt: now().toISOString(),
      };
      await repository.insert(task);
      return task;
    },
    list: (runId) => repository.list(identity.login, validateRunId(runId)),
    async find(id) {
      return requireTask(await repository.find(identity.login, validateId(id)));
    },
    async update(id, body) {
      const taskId = validateId(id);
      const changes = validateChanges(body);
      return requireTask(await repository.update(identity.login, taskId, changes));
    },
    async remove(id) {
      requireTask(await repository.remove(identity.login, validateId(id)));
    },
    check: () => repository.check(),
  };
}
