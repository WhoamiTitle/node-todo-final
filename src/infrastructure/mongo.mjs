import { MongoClient, MongoError } from 'mongodb';
import { StorageUnavailableError } from '../application/errors.mjs';

export function createMongoClient(uri) {
  return new MongoClient(uri, {
    appName: 'node-todo-final',
    maxPoolSize: 5,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 2000,
    connectTimeoutMS: 2000,
    socketTimeoutMS: 3000,
    waitQueueTimeoutMS: 2000,
    retryWrites: false,
    writeConcern: { w: 1, journal: true },
  });
}

function toTask(document) {
  if (!document) return null;
  return {
    id: document.id,
    ownerLogin: document.ownerLogin,
    title: document.title,
    done: document.done,
    runId: document.runId,
    createdAt: document.createdAt.toISOString(),
  };
}

export function createMongoTaskRepository(database) {
  const tasks = database.collection('tasks');
  async function execute(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MongoError) throw new StorageUnavailableError(error);
      throw error;
    }
  }
  return {
    insert: (task) =>
      execute(() => tasks.insertOne({ ...task, createdAt: new Date(task.createdAt) })),
    list: async (ownerLogin, runId) => {
      const documents = await execute(() =>
        tasks.find({ ownerLogin, runId }).sort({ createdAt: 1, id: 1 }).toArray(),
      );
      return documents.map(toTask);
    },
    find: async (ownerLogin, id) => toTask(await execute(() => tasks.findOne({ ownerLogin, id }))),
    update: async (ownerLogin, id, changes) =>
      toTask(
        await execute(() =>
          tasks.findOneAndUpdate(
            { ownerLogin, id },
            { $set: changes },
            { returnDocument: 'after', includeResultMetadata: false },
          ),
        ),
      ),
    remove: async (ownerLogin, id) =>
      (await execute(() => tasks.deleteOne({ ownerLogin, id }))).deletedCount === 1,
    check: () => execute(() => tasks.findOne({}, { projection: { _id: 1 } })),
  };
}
