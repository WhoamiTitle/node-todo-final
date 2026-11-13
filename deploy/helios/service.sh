#!/bin/sh
set -eu
umask 077
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=deploy/helios/common.sh
. "$here/common.sh"
test "$#" -eq 2 || todo_fail 'Usage: service.sh PRIVATE_ROOT start|stop|start-node|stop-node|status|assert-stopped'
todo_root "$1"
action=$2
case "$action" in start|stop|start-node|stop-node|status|assert-stopped) ;; *) todo_fail 'Unknown action' ;; esac

stop_one() {
  supervisor=$1
  child=$2
  # Check both identities before sending any signals.
  for candidate in "$supervisor" "$child"; do
    if todo_pid "$candidate"; then :; else
      result=$?
      test "$result" -eq 1 || todo_fail "$candidate identity is ambiguous; refusing to stop"
    fi
  done
  if todo_pid "$supervisor"; then kill -TERM "$process_id";
  elif todo_pid "$child"; then kill -TERM "$process_id"; fi
  remaining=35
  while test "$remaining" -gt 0; do
    waiting=0
    for candidate in "$supervisor" "$child"; do
      if todo_pid "$candidate"; then waiting=1; else
        result=$?
        test "$result" -eq 1 || todo_fail "$candidate identity changed during stop"
      fi
    done
    test "$waiting" -eq 1 || return 0
    sleep 1
    remaining=$((remaining - 1))
  done
  todo_fail "$child did not stop in 35s; no SIGKILL or database shutdown attempted"
}

check_ready() {
  "$root/runtime/bin/node" --env-file="$root/config/app.env" "$root/current/deploy/helios/check.mjs" "$1"
}

wait_ready() {
  remaining=10
  until check_ready "$1"; do
    remaining=$((remaining - 1))
    test "$remaining" -gt 0 || todo_fail "$1 is not ready; inspect $root/logs"
    sleep 1
  done
}

start_one() {
  kind=$1
  if todo_pid "$kind-supervisor"; then
    printf '%s supervisor already running\n' "$kind"
    return
  else
    result=$?
    test "$result" -eq 1 || todo_fail "$kind supervisor identity is ambiguous"
  fi
  todo_absent "$kind"
  # Child processes must not inherit deployment or lifecycle locks.
  daemon -f -R 5 -t "todo-final-$kind" \
    -P "$root/run/$kind-supervisor.pid" -p "$root/run/$kind.pid" -o "$root/logs/$kind-supervisor.log" \
    /bin/sh "$root/current/deploy/helios/run.sh" "$root" "$kind" 8>&- 9>&-
}

if test "$action" = status; then
  healthy=1
  if test -f "$root/publication-mode"; then
    printf 'publication mode: %s\n' "$(cat "$root/publication-mode")"
  fi
  if test -f "$root/config/db-access-approved"; then
    printf '%s\n' 'DB access agreement: recorded (teacher connection requires a separate test)'
  else
    printf '%s\n' 'DB access agreement: not recorded'
  fi
  for candidate in node-supervisor node mongo-supervisor mongo; do
    if todo_pid "$candidate"; then printf '%s: running (PID %s)\n' "$candidate" "$process_id";
    else printf '%s: absent or identity unverified (%s)\n' "$candidate" "$?"; healthy=0; fi
  done
  for check in db http; do
    if check_ready "$check"; then printf '%s: ready\n' "$check"; else healthy=0; fi
  done
  test "$healthy" -eq 1
  exit
fi
todo_lock
case "$action" in
  assert-stopped) for candidate in node-supervisor node mongo-supervisor mongo; do todo_absent "$candidate"; done ;;
  stop) stop_one node-supervisor node; stop_one mongo-supervisor mongo ;;
  stop-node) stop_one node-supervisor node ;;
  start|start-node)
    for candidate in node-supervisor node mongo-supervisor mongo; do
      if todo_pid "$candidate"; then :; else
        result=$?
        test "$result" -eq 1 || todo_fail "$candidate identity is ambiguous; inspect it before starting"
      fi
    done
    test -f "$root/config/db.initialized" || todo_fail 'Initialize the database explicitly first'
    test -f "$root/current/src/index.mjs" || todo_fail 'No current release'
    if test "$action" = start; then start_one mongo; fi
    wait_ready db
    start_one node
    wait_ready http
    ;;
esac
