import { createApi } from './api.mjs';

const api = createApi();
const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries(
  [
    'error',
    'status',
    'sign-in',
    'workspace',
    'logout',
    'token-form',
    'token',
    'author-name',
    'author-login',
    'personal-list',
    'personal-list-name',
    'run-form',
    'run-id',
    'list-heading',
    'create-form',
    'new-title',
    'tasks',
    'empty',
    'empty-text',
    'total-count',
    'active-count',
    'done-count',
    'refresh',
    'task-template',
    'edit-dialog',
    'edit-form',
    'edit-title',
    'delete-dialog',
    'delete-form',
    'delete-title',
  ].map((id) => [id, byId(id)]),
);
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const PERSONAL_RUN_ID = 'manual';
let tasks = [];
let runId = PERSONAL_RUN_ID;
let filter = 'all';
let selectedId = null;
let busy = false;

const messages = {
  unauthorized: 'Токен не подходит или больше не действует.',
  invalid_title: 'Название должно содержать от 1 до 200 символов.',
  invalid_run_id: 'runId: от 1 до 64 латинских букв, цифр, дефисов или знаков подчёркивания.',
  task_not_found: 'Дело уже удалено. Обновите список.',
  database_unavailable: 'База данных временно недоступна. Попробуйте обновить список позже.',
  network_error: 'Не удалось связаться с сервером. Проверьте соединение.',
};

function clearErrors() {
  elements.error.hidden = true;
  document.querySelectorAll('.dialog__error').forEach((element) => {
    element.hidden = true;
  });
}

function setBusy(value) {
  busy = value;
  elements.workspace.setAttribute('aria-busy', String(value));
  document.querySelectorAll('button, input, fieldset').forEach((element) => {
    element.disabled = value;
  });
}

function signOut() {
  api.setToken('');
  tasks = [];
  elements['run-form'].reset();
  filter = 'all';
  document.querySelector('.status-filter input[value="all"]').checked = true;
  elements.tasks.replaceChildren();
  elements['author-name'].textContent = 'Автор списка';
  elements['author-login'].textContent = '';
  elements['sign-in'].hidden = false;
  elements.workspace.hidden = true;
  elements.logout.hidden = true;
  elements.token.value = '';
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  elements.token.focus();
}

async function run(action) {
  if (busy) return;
  const previousFocus = document.activeElement;
  clearErrors();
  setBusy(true);
  try {
    await action();
  } catch (error) {
    if (error.status === 401) signOut();
    const output = document.querySelector('dialog[open] .dialog__error') || elements.error;
    output.textContent = messages[error.message] || 'Запрос не выполнен. Попробуйте ещё раз.';
    output.hidden = false;
  } finally {
    setBusy(false);
    if (!elements['sign-in'].hidden) elements.token.focus();
    else if (document.activeElement === document.body && previousFocus?.isConnected)
      previousFocus.focus();
  }
}

function renderTasks() {
  const fragment = document.createDocumentFragment();
  for (const task of tasks.filter(
    (item) => filter === 'all' || item.done === (filter === 'done'),
  )) {
    const row = elements['task-template'].content.firstElementChild.cloneNode(true);
    row.dataset.id = task.id;
    row.classList.toggle('task--done', task.done);
    const checkbox = row.querySelector('.task__done');
    checkbox.checked = task.done;
    checkbox.id = `done-${task.id}`;
    checkbox.setAttribute(
      'aria-label',
      `${task.done ? 'Вернуть в работу' : 'Завершить'}: ${task.title}`,
    );
    row.querySelector('.task__title').textContent = task.title;
    const date = document.createElement('time');
    date.dateTime = task.createdAt;
    date.textContent = dateFormat.format(new Date(task.createdAt));
    row.querySelector('.task__date').append(date);
    row.querySelector('[data-action="edit"]').setAttribute('aria-label', `Изменить: ${task.title}`);
    row
      .querySelector('[data-action="delete"]')
      .setAttribute('aria-label', `Удалить: ${task.title}`);
    fragment.append(row);
  }
  elements.tasks.replaceChildren(fragment);
  elements.empty.hidden = elements.tasks.childElementCount !== 0;
  elements['empty-text'].textContent = tasks.length
    ? 'Дел с этим статусом нет'
    : 'В этом списке пока нет дел';
  elements['total-count'].textContent = String(tasks.length);
  elements['done-count'].textContent = String(tasks.filter((task) => task.done).length);
  elements['active-count'].textContent = String(tasks.filter((task) => !task.done).length);
}

async function loadTasks(nextRunId = runId) {
  const result = await api.list(nextRunId);
  tasks = result;
  runId = nextRunId;
  const personal = runId === PERSONAL_RUN_ID;
  const name = personal ? elements['personal-list-name'].textContent : runId;
  elements['personal-list'].setAttribute('aria-current', String(personal));
  elements['list-heading'].textContent = name;
  renderTasks();
  elements.status.textContent = `${name}. Дел: ${tasks.length}.`;
}

function validateTitle(input) {
  const length = [...input.value.trim()].length;
  input.setCustomValidity(length < 1 || length > 200 ? messages.invalid_title : '');
  return input.reportValidity();
}

function focusTask(id, action = 'edit') {
  const row = [...elements.tasks.children].find((element) => element.dataset.id === id);
  const target = row?.querySelector(
    action === 'done' ? '.task__done' : `[data-action="${action}"]`,
  );
  (target || elements['new-title']).focus();
}

elements['token-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    api.setToken(elements.token.value.trim());
    const author = await api.author();
    await loadTasks(PERSONAL_RUN_ID);
    elements.token.value = '';
    elements['author-name'].textContent = author.fullName;
    elements['author-login'].textContent = author.login;
    elements['sign-in'].hidden = true;
    elements.workspace.hidden = false;
    elements.logout.hidden = false;
  }).then(() => {
    if (elements['sign-in'].hidden) elements['new-title'].focus();
  });
});
elements.logout.addEventListener('click', signOut);
elements['personal-list'].addEventListener('click', () => {
  void run(() => loadTasks(PERSONAL_RUN_ID));
});
elements['run-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  void run(() => loadTasks(elements['run-id'].value));
});
elements.refresh.addEventListener('click', () => {
  void run(() => loadTasks());
});
elements['create-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  if (!validateTitle(elements['new-title'])) return;
  void run(async () => {
    await api.create(elements['new-title'].value, runId);
    elements['new-title'].value = '';
    await loadTasks();
    elements.status.textContent = 'Дело добавлено.';
  }).then(() => elements['new-title'].focus());
});
document.querySelector('.status-filter').addEventListener('change', (event) => {
  filter = event.target.value;
  renderTasks();
});
elements.tasks.addEventListener('change', (event) => {
  const checkbox = event.target.closest('.task__done');
  if (!checkbox) return;
  const id = checkbox.closest('.task').dataset.id;
  const done = checkbox.checked;
  void run(async () => {
    try {
      await api.update(id, { done });
      await loadTasks();
    } catch (error) {
      renderTasks();
      throw error;
    }
  }).then(() => focusTask(id, 'done'));
});
elements.tasks.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  selectedId = button.closest('.task').dataset.id;
  const task = tasks.find((item) => item.id === selectedId);
  clearErrors();
  if (button.dataset.action === 'edit') {
    elements['edit-title'].value = task.title;
    elements['edit-title'].setCustomValidity('');
    elements['edit-dialog'].showModal();
    elements['edit-title'].select();
  } else {
    elements['delete-title'].textContent = task.title;
    elements['delete-dialog'].showModal();
  }
});
elements['edit-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  if (!validateTitle(elements['edit-title'])) return;
  const id = selectedId;
  void run(async () => {
    await api.update(id, { title: elements['edit-title'].value });
    elements['edit-dialog'].close();
    await loadTasks();
    elements.status.textContent = 'Название сохранено.';
  }).then(() => {
    if (!elements['edit-dialog'].open) focusTask(id);
  });
});
elements['delete-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const id = selectedId;
  void run(async () => {
    await api.remove(id);
    elements['delete-dialog'].close();
    await loadTasks();
    elements.status.textContent = 'Дело удалено.';
  }).then(() => {
    if (!elements['delete-dialog'].open) elements['new-title'].focus();
  });
});
document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});
for (const input of [elements['new-title'], elements['edit-title']]) {
  input.addEventListener('input', () => input.setCustomValidity(''));
}
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
});
