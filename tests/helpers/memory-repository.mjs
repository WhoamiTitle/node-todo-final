export function memoryRepository() {
  const records = new Map();
  const own = (owner, id) => (records.get(id)?.ownerLogin === owner ? records.get(id) : null);
  return {
    records,
    async insert(task) {
      records.set(task.id, structuredClone(task));
    },
    async list(owner, runId) {
      return [...records.values()].filter(
        (task) => task.ownerLogin === owner && task.runId === runId,
      );
    },
    async find(owner, id) {
      return own(owner, id);
    },
    async update(owner, id, changes) {
      const task = own(owner, id);
      if (!task) return null;
      Object.assign(task, changes);
      return task;
    },
    async remove(owner, id) {
      return own(owner, id) ? records.delete(id) : false;
    },
    async check() {},
  };
}
