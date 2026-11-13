# Автовосстановление TODO через GitHub Actions

## Перенос в отдельный репозиторий

Workflow адаптирован для `WhoamiTitle/node-todo-final`; скрипт запускается из корня проекта.
Не задавать `TODO_RECOVERY_ENABLED=true` в новом репозитории до отдельного переключения.
Действующее расписание в портфолио пока сохраняется. Настройки environments, variables и secrets
нужно подготовить отдельно; GitHub не переносит их вместе с YAML.
Проверка и переключение выполняются по [плану миграции](standalone-migration.md).
Ниже сохранены требования механизма и история его проверок до переноса.

На 12.11.2026 (Asia/Yakutsk) подготовлены workflow и проверки. Само наличие YAML не включает
автовосстановление: нужны публикация helper, отдельный ключ, настройки GitHub и разрешение на Helios.
Разрешение преподавателя на DB-туннель и разрешение администрации на постоянный автозапуск — разные вещи.
Если остановки в 05:00 МСК являются намеренной политикой сервера, сначала согласовать этот механизм.

## Что выполняется

Workflow **Recover TODO on Helios** находится в `.github/workflows/todo-recovery.yml`.
По расписанию он проверяет публичный `/todo/healthz/` в минуты 7, 17, 27, 37, 47 и 57 каждого часа.
Проверка требует HTTP 200 и маленький JSON с `status=ok`; redirect, HTML, timeout и 502 не считаются успехом.
Три проверки с интервалом 10 секунд подтверждают отказ. Если хотя бы одна успешна, SSH не используется.
Каждый запрос ограничен 8 секундами и 4096 байтами ответа.

При подтверждённом отказе режим `recover` вызывает по SSH только фиксированную команду `todo-recover`.
На сервере она проверяет разрешение, паузу, согласованность активного релиза и состояние сервисов.
Под общей с deploy/rollback блокировкой `deployment.guard` выполняется только существующий `service.sh start`.
MongoDB поднимается перед Node.js; проверка PID и lifecycle-lock остаются ответственностью service helper.
Живые, но неготовые процессы принудительно не завершаются. Повреждённые PID требуют ручной диагностики.

Восстановление не меняет `current`, gateway, режим `preview`/`approved`, DB-доступ, секреты или данные;
не запускает установку, миграции, `init-db`, откат или контрактный CRUD. Одна попытка запуска на обращение,
пауза между попытками минимум 5 минут. В приватном `logs/recovery.log` записываются время и результат запуска.
После SSH workflow заново проверяет публичный HTTPS; локальная готовность не заменяет эту проверку.

Состояния `paused`, `busy`, `cooldown` означают отложенную попытку, **не подтверждение доступности**.
Отсутствие разрешения, отказ SSH, неуспешный запуск или остающийся недоступным HTTPS завершают job ошибкой.
Результат виден в Actions Summary. Для уведомлений о неуспехе включить уведомления Actions в GitHub;
отправка в Moodle или сторонний чат этим workflow не выполняется.

У GitHub Actions возможны задержки и пропуски scheduled jobs; это не SLA восстановления за 10 минут.
Расписание запускает код только из default branch. Для этого репозитория default branch должна быть `main`.
Это до 144 запусков в сутки. В private-репозитории проверить доступные минуты Actions и лимит расходов;
при необходимости уменьшить частоту. Автоматическая покупка услуг не нужна.
Для строгой доступности нужен согласованный системный сервис или монитор на постоянно работающем сервере.

## 1. Опубликовать проверенные helper

Сначала проверить изменения, отдельно сделать commit/push в `main`. Перед push учесть другие локальные
коммиты, ещё не отправленные в GitHub. Workflow не требует `npm ci` на каждом запуске: используется только Node.js 24.

Из чистого commit опубликовать новую версию TODO обычным способом. Для текущего preview:

```bash
cd /Users/vasiliy/Documents/node-todo-final-standalone
npm run helios:preview
npm run helios:status
```

Параметры SSH должны быть заданы в `.env.helios` или окружении, как в [инструкции деплоя](helios-deployment.md).
На Helios должен существовать `~/.node-todo-final/current/deploy/helios/recover.sh`.
Если откатиться на старый релиз без этого файла, восстановление откажет, а не установит helper самостоятельно.
Наличие `config/db-access-approved` для восстановления preview не требуется и автоматически не создаётся.

## 2. Подготовить отдельный ограниченный SSH-ключ

На своём компьютере создать новую пару. Не перезаписывать существующие ключи:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/helios_todo_recovery_ed25519 -C todo-recovery-github-actions -N ''
```

Это ключ без passphrase для неинтерактивного runner, поэтому его возможности обязательно ограничить
на сервере. В GitHub передаётся только этот приватный ключ, не основной deploy-ключ и не пароль Helios.

На Helios добавить **отдельную строку** в `~/.ssh/authorized_keys`, подставив публичную часть новой пары.
Существующие строки не заменять. Пути ниже относятся только к аккаунту `s507353`:

```text
restrict,command="/bin/sh /home/studs/s507353/.node-todo-final/current/deploy/helios/recover.sh /home/studs/s507353/.node-todo-final" ssh-ed25519 AAAA_PUBLIC_KEY todo-recovery-github-actions
```

`restrict` запрещает PTY, forwarding, agent/X11 forwarding и пользовательский sshrc.
Forced command принимает только `SSH_ORIGINAL_COMMAND=todo-recover`, отвергая остальные команды и SFTP.
Нельзя добавлять `port-forwarding`: для восстановления никакой туннель не нужен.
Проверить права `700` у `~/.ssh` и `600` у `authorized_keys`, не менять владельца или чужие ключи.

До включения разрешения первый тест новой пары безопасно возвращает `TODO_RECOVERY_RESULT=disabled`:

```bash
ssh -T -p 2222 -i ~/.ssh/helios_todo_recovery_ed25519 \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  s507353@helios.cs.ifmo.ru todo-recover
```

С той же парой запрос `id` и запрос без команды должны завершаться отказом, не выдавать shell.
SFTP и произвольные команды должны быть отвергнуты; `-L`/`-R` также должны быть недоступны.
Проверка shell-helper в fixture не заменяет этот реальный тест конфигурации OpenSSH.

## 3. Настроить GitHub

В **WhoamiTitle/node-todo-final**, не в прежнем репозитории портфолио:

Для Environment и environment secrets в private-репозитории GitHub требует Pro, Team или Enterprise.
Если раздел недоступен на текущем тарифе, не открывать репозиторий и не покупать услуги ради этой инструкции:
сначала отдельно адаптировать workflow под repository secrets/variables. Наличие старого environment после
смены visibility не подтверждает доступность его секретов. [Ограничения GitHub](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

1. `Settings → Secrets and variables → Actions → Variables`: создать **Repository variable**
   `TODO_RECOVERY_ENABLED=false`. Именно repository variable: она проверяется до загрузки environment.
2. `Settings → Environments`: создать отдельный environment **helios-todo-recovery**.
3. Разрешить только ветку `main`. Для автоматического запуска не должно быть обязательного ручного
   подтверждения environment; если оно требуется, job будет ждать человека, а не восстанавливать сервис.
   Workflow использует `deployment: false`: secrets и ограничения environment сохраняются, но каждая
   проверка не засоряет историю deployments. Custom deployment protection apps для этого environment не включать.
4. В environment добавить переменные:

| Variable           | Значение            |
| ------------------ | ------------------- |
| `TODO_DEPLOY_USER` | `s507353`           |
| `TODO_DEPLOY_HOST` | `helios.cs.ifmo.ru` |
| `TODO_DEPLOY_PORT` | `2222`              |

5. В этом же environment добавить **Secrets**:

| Secret                          | Содержимое                                                     |
| ------------------------------- | -------------------------------------------------------------- |
| `TODO_RECOVERY_SSH_PRIVATE_KEY` | Полный новый ограниченный приватный ключ с BEGIN/END           |
| `HELIOS_KNOWN_HOSTS`            | Проверенные host keys Helios для порта 2222, не приватный ключ |

Для Mac приватный ключ можно передать в буфер без вывода в терминал:

```bash
pbcopy < ~/.ssh/helios_todo_recovery_ed25519
```

Для known_hosts использовать уже проверенные записи, например найти их командой:

```bash
ssh-keygen -F '[helios.cs.ifmo.ru]:2222' -f ~/.ssh/known_hosts
```

Fingerprint сервера сверить с доверенным источником. Не доверять автоматически свежему `ssh-keyscan`.
API-токен, MongoDB URI/пароли и данные преподавателя в GitHub не нужны. Приватные значения не сохранять
в Variables, исходниках, README, артефактах и форумах. Временные файлы ключа на runner имеют права 600
и удаляются после команды; весь runner также одноразовый. Прерванный job не означает завершения уже
начавшегося серверного старта: перед новой попыткой проверить состояние, а не повторять его вслепую.

## 4. Проверить и включить

Сначала `Actions → Recover TODO on Helios → Run workflow`, ветка `main`, режим **check**.
Этот режим доступен при выключенной автоматике и никогда не вызывает SSH. При недоступном HTTPS он
завершается ошибкой, не восстанавливает сервис. Зелёная проверка здорового сайта не подтверждает ключ.

После разрешения автозапуска администрацией на Helios **под своей обычной учётной записью** создать:

```bash
touch ~/.node-todo-final/config/autorecovery.allowed
chmod 600 ~/.node-todo-final/config/autorecovery.allowed
```

Проверить ограниченным ключом `todo-recover` на здоровом стенде: результат должен быть `healthy`.
Ничего не останавливать в рабочей БД ради первого теста. Полный сценарий остановки и восстановления
сначала проверять на отдельном fixture, затем в согласованное окно проверки.

Только в согласованное окно переключения сначала выключить recovery в портфолио, затем заменить
**Repository variable** `TODO_RECOVERY_ENABLED` нового репозитория на `true`.
Не оставлять две включённые автоматики: одноимённые GitHub concurrency groups не синхронизируют разные репозитории.
Ручной режим **recover** и расписание получают право вызвать ограниченную команду при подтверждённом сбое.
Независимая очередь `helios-node-todo-recovery` не отменяет ожидающий deploy. Серверная блокировка общая:
если идёт локальный/CI deploy или rollback, восстановление откладывается до следующего запуска.

## Обслуживание и отключение

Перед намеренной остановкой на Helios сначала поставить паузу, затем выполнить штатный stop:

```bash
root="$HOME/.node-todo-final"
touch "$root/config/autorecovery.paused"
sh "$root/current/deploy/helios/service.sh" "$root" stop
```

Вернуть сервис вручную и убрать паузу **после** успешного старта:

```bash
sh "$root/current/deploy/helios/service.sh" "$root" start
rm "$root/config/autorecovery.paused"
```

Для полного отключения поставить `TODO_RECOVERY_ENABLED=false` и убрать
`~/.node-todo-final/config/autorecovery.allowed`. Чтобы отозвать ключ, удалить только его строку
`todo-recovery-github-actions` из authorized_keys и соответствующий GitHub secret.
Workflow ничего не меняет в регистрации Moodle или преподавательском DB-доступе.

## Проверки

```bash
npm run check
npm run test:deployment
```

Unit-тесты проверяют подтверждение отказа, check-only/disabled, ограничения HTTP, единственную SSH-попытку,
повторную HTTPS-проверку, разрешённую команду, host-key checking и удаление ключей в успехе и ошибке.
Shell-fixtures проверяют разрешение, паузу, cooldown, метаданные и сохранность данных.
На FreeBSD тот же deployment-test дополнительно проверяет настоящую конкуренцию по `lockf` на временном
fixture; он не останавливает рабочие процессы TODO или LTI. Эти проверки не означают, что workflow уже
запускался в GitHub или что реальный ограниченный ключ установлен на сервере.

Проверено 12.11.2026: 45 unit/HTTP-тестов, 40 успешных deployment-проверок на macOS
(FreeBSD-only тест пропущен), actionlint 1.7.12 и ShellCheck. На Helios отдельно прошли 15 fixture-проверок,
включая настоящий `lockf`; пропущен только тест с имитацией lockf для других ОС. Временный стенд удалён.
Публичный HTTPS также проверен новым CLI в режиме `check`: `healthy`, без SSH и без изменения процессов.

Источники: [GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[FreeBSD lockf](https://man.freebsd.org/cgi/man.cgi?query=lockf&sektion=1&manpath=FreeBSD+14.3-RELEASE),
[OpenSSH authorized_keys](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT).
