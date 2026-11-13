#!/bin/sh
set -eu
umask 077
test "$(uname -s)" = FreeBSD
: "${TODO_TEST_RUNTIME:?Set a read-only compatible runtime path}"
source=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
temporary=$(mktemp -d "$HOME/.todo-freebsd-XXXXXX")
root="$temporary/.node-todo-final"
export LD_LIBRARY_PATH="$TODO_TEST_RUNTIME/lib"
export PATH="$TODO_TEST_RUNTIME/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin"
node "$source/tests/helpers/freebsd-fixture.mjs" setup "$root" "$TODO_TEST_RUNTIME"
service() { sh "$source/deploy/helios/service.sh" "$root" "$1"; }
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if service stop && service assert-stopped; then
    if test "$result" -eq 0; then rm -rf "$temporary";
    else printf 'Stopped test; inspect fixture: %s\n' "$root" >&2; fi
  else
    printf 'Inspect test processes before cleanup: %s\n' "$root" >&2
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
node "$source/deploy/helios/bootstrap-db.mjs" "$root"
service start
node_pid=$(cat "$root/run/node.pid")
mongo_pid=$(cat "$root/run/mongo.pid")
node_supervisor=$(cat "$root/run/node-supervisor.pid")
service start
test "$(cat "$root/run/node.pid")" = "$node_pid"
test "$(cat "$root/run/mongo.pid")" = "$mongo_pid"
test "$(cat "$root/run/node-supervisor.pid")" = "$node_supervisor"
node "$source/tests/helpers/freebsd-fixture.mjs" insert "$root"
# Verify identity before signalling only this freshly created test's children.
# shellcheck source=deploy/helios/common.sh
. "$source/deploy/helios/common.sh"
for kind in node mongo; do
  todo_pid "$kind" || todo_fail 'Test child identity mismatch'
  old_pid=$process_id
  kill -TERM "$old_pid"
  remaining=30
  while test "$remaining" -gt 0; do
    if todo_pid "$kind" && test "$process_id" != "$old_pid"; then break; fi
    sleep 1
    remaining=$((remaining - 1))
  done
  test "$remaining" -gt 0
  service start
done
service stop
service assert-stopped
service start
node "$source/tests/helpers/freebsd-fixture.mjs" verify "$root"
port=$(node --env-file="$root/config/app.env" -e 'process.stdout.write(process.env.PORT)')
node --env-file="$root/config/app.env" "$source/deploy/helios/contracts.mjs" "http://127.0.0.1:$port/"
service stop
service assert-stopped
printf '%s\n' invalid > "$root/run/node-supervisor.pid"
if service start; then rm "$root/run/node-supervisor.pid"; exit 1; fi
rm "$root/run/node-supervisor.pid"
printf '%s\n' 'FreeBSD smoke passed: authenticated CRUD, idempotent start, both supervisors, persistence after restart, graceful stop, corrupt PID refusal.'
