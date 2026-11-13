export class ValidationError extends Error {}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function validateId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ValidationError('invalid_uuid');
  }
  return value.toLowerCase();
}

export function validateRunId(value) {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new ValidationError('invalid_run_id');
  }
  return value;
}

function validateTitle(value) {
  if (typeof value !== 'string') throw new ValidationError('invalid_title');
  const title = value.trim();
  if ([...title].length < 1 || [...title].length > 200) {
    throw new ValidationError('invalid_title');
  }
  return title;
}

function validateFields(value, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('invalid_body');
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) {
    throw new ValidationError('invalid_fields');
  }
}

export function validateCreation(value) {
  validateFields(value, ['title', 'runId']);
  return { title: validateTitle(value.title), runId: validateRunId(value.runId) };
}

export function validateChanges(value) {
  validateFields(value, ['title', 'done']);
  const changes = {};
  if (Object.hasOwn(value, 'title')) changes.title = validateTitle(value.title);
  if (Object.hasOwn(value, 'done')) {
    if (typeof value.done !== 'boolean') throw new ValidationError('invalid_done');
    changes.done = value.done;
  }
  return changes;
}
