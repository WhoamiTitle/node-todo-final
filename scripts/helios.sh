#!/bin/sh
set -eu
umask 077
here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
if test -f "$here/.env.helios"; then
  set -a
  # shellcheck disable=SC1091
  . "$here/.env.helios"
  set +a
fi
: "${TODO_DEPLOY_HOST:?Set TODO_DEPLOY_HOST}"
: "${TODO_DEPLOY_USER:?Set TODO_DEPLOY_USER}"
: "${TODO_SSH_KEY_PATH:?Set TODO_SSH_KEY_PATH}"
: "${TODO_KNOWN_HOSTS_PATH:?Set TODO_KNOWN_HOSTS_PATH}"
port=${TODO_DEPLOY_PORT:-2222}
cache=${TODO_PACKAGE_CACHE:--}
case "$cache" in -|/*) ;; *) exit 2 ;; esac
case "$cache" in *[!A-Za-z0-9_./-]*|*/../*|*/./*|*//*) exit 2 ;; esac
for value in "$TODO_DEPLOY_HOST" "$TODO_DEPLOY_USER"; do
  case "$value" in ''|*[!A-Za-z0-9._-]*) exit 2 ;; esac
done
case "$port" in ''|*[!0-9]*) exit 2 ;; esac
test "$port" -ge 1 && test "$port" -le 65535
root="/home/studs/$TODO_DEPLOY_USER/.node-todo-final"
public="/home/studs/$TODO_DEPLOY_USER/public_html/todo"
base="https://se.ifmo.ru/~$TODO_DEPLOY_USER/todo/"
target="$TODO_DEPLOY_USER@$TODO_DEPLOY_HOST"
ssh_todo() {
  ssh -p "$port" -i "$TODO_SSH_KEY_PATH" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$TODO_KNOWN_HOSTS_PATH" -o ConnectTimeout=15 "$target" "$@"
}
case "${1:-}" in
  prepare|init-db|deploy|preview)
    archive=$(sh "$here/scripts/package-release.sh")
    revision=${archive##*/}
    revision=${revision%.tar}
    upload_name="$revision.$(node -e 'process.stdout.write(require("node:crypto").randomUUID())').tar"
    ssh_todo sh -s -- "$root" <<'REMOTE'
set -eu
umask 077
root=$1
test ! -L "$root"
mkdir -p "$root"
test "$(find "$root" -prune -user "$(id -u)")" = "$root"
chmod 700 "$root"
mkdir -p "$root/incoming"
REMOTE
    # SCP/SFTP never receives application tokens or database configuration.
    scp -P "$port" -i "$TODO_SSH_KEY_PATH" -o IdentitiesOnly=yes -o BatchMode=yes \
      -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$TODO_KNOWN_HOSTS_PATH" \
      "$archive" "$target:$root/incoming/$upload_name"
    ssh_todo sh -s -- "$root" "$revision" "$1" "$public" "$base" "$upload_name" "$cache" < "$here/deploy/helios/install.sh"
    ;;
  start|stop|status)
    ssh_todo sh "$root/current/deploy/helios/service.sh" "$root" "$1"
    ;;
  rollback)
    revision=${2:-}
    case "$revision" in ''|*[!a-f0-9]*) exit 2 ;; esac
    test "${#revision}" -eq 40 || exit 2
    ssh_todo sh "$root/releases/$revision/deploy/helios/activate.sh" "$root" "$revision" "$public" "$base" rollback
    ;;
  *) printf '%s\n' 'Usage: helios.sh prepare|init-db|deploy|preview|start|stop|status|rollback COMMIT' >&2; exit 2 ;;
esac
