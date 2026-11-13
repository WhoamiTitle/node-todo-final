export class TaskNotFoundError extends Error {
  constructor() {
    super('task_not_found');
  }
}

export class StorageUnavailableError extends Error {
  constructor(cause) {
    super('database_unavailable', { cause });
  }
}
