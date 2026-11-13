const validator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['id', 'ownerLogin', 'title', 'done', 'runId', 'createdAt'],
    additionalProperties: false,
    properties: {
      _id: { bsonType: 'objectId' },
      id: {
        bsonType: 'string',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      },
      ownerLogin: { bsonType: 'string', minLength: 1 },
      title: { bsonType: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
      done: { bsonType: 'bool' },
      runId: { bsonType: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
      createdAt: { bsonType: 'date' },
    },
  },
};

export async function initializeDatabase(database, users) {
  const exists = await database.listCollections({ name: 'tasks' }).hasNext();
  if (exists) {
    await database.command({
      collMod: 'tasks',
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await database.createCollection('tasks', {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
  await database
    .collection('tasks')
    .createIndex({ id: 1 }, { unique: true, name: 'task_id_unique' });
  await database
    .collection('tasks')
    .createIndex({ ownerLogin: 1, runId: 1, createdAt: 1, id: 1 }, { name: 'author_run_created' });

  const privileges = [
    {
      resource: { db: database.databaseName, collection: 'tasks' },
      actions: ['find', 'insert', 'update', 'remove'],
    },
  ];
  const role = 'tasksCrud';
  const roleInfo = await database.command({ rolesInfo: role });
  await database.command(
    roleInfo.roles.length
      ? { updateRole: role, privileges, roles: [] }
      : { createRole: role, privileges, roles: [] },
  );
  for (const { name, password } of users) {
    const userInfo = await database.command({ usersInfo: name });
    const options = { pwd: password, roles: [{ role, db: database.databaseName }] };
    await database.command(
      userInfo.users.length ? { updateUser: name, ...options } : { createUser: name, ...options },
    );
  }
}
