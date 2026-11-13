#!/bin/sh
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
# shellcheck source=deploy/helios/common.sh
. "$here/common.sh"
test "$#" -eq 1 || todo_fail 'Usage: recover.sh PRIVATE_ROOT'
test "${SSH_ORIGINAL_COMMAND:-}" = todo-recover || todo_fail 'Only todo-recover is allowed'
todo_root "$1"

result() { printf 'TODO_RECOVERY_RESULT=%s\n' "$1"; exit 0; }
regular_or_absent() {
  if test -L "$1" || { test -e "$1" && ! test -f "$1"; }; then
    todo_fail 'Invalid recovery control file'
  fi
}
for file in config/autorecovery.allowed config/autorecovery.paused run/deployment.guard run/recovery.last-start logs/recovery.log; do
  regular_or_absent "$root/$file"
done
test -f "$root/config/autorecovery.allowed" || result disabled
test ! -f "$root/config/autorecovery.paused" || result paused
test -d "$root/run" && test -d "$root/logs" || todo_fail 'Prepare the service before recovery'

# The descriptor remains locked through status and start; daemon children close FD 9.
exec 9>> "$root/run/deployment.guard"
if lockf -s -t 1 9; then :; else
  code=$?
  test "$code" -eq 75 || todo_fail 'Could not acquire the deployment lock'
  result busy
fi
test ! -f "$root/config/autorecovery.paused" || result paused
test -f "$root/config/autorecovery.allowed" || result disabled
test -L "$root/current" || todo_fail 'No active release'
release=$(cat "$root/deployed-release")
todo_release "$release"
test "$(readlink "$root/current")" = "$root/releases/$release" || todo_fail 'Active release metadata disagrees'
test -f "$root/current/.installed" || todo_fail 'Active release is incomplete'
test -f "$root/config/db.initialized" || todo_fail 'Database must already be initialized'
mode=$(cat "$root/publication-mode")
case "$mode" in preview|approved) ;; *) todo_fail 'Invalid saved publication mode' ;; esac

service="$root/current/deploy/helios/service.sh"
if sh "$service" "$root" status >/dev/null 2>&1; then result healthy; fi
now=$(date -u '+%s')
if test -f "$root/run/recovery.last-start"; then
  last=$(cat "$root/run/recovery.last-start")
  case "$last" in ''|*[!0-9]*) todo_fail 'Invalid recovery timestamp' ;; esac
  test "${#last}" -le 10 || todo_fail 'Invalid recovery timestamp'
  test "$last" -le "$now" || todo_fail 'Recovery timestamp is in the future'
  if test "$((now - last))" -lt 300; then result cooldown; fi
fi
printf '%s\n' "$now" > "$root/run/recovery.last-start"
printf '%s start release=%s mode=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$release" "$mode" >> "$root/logs/recovery.log"
if ! sh "$service" "$root" start; then
  printf '%s start-failed\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$root/logs/recovery.log"
  todo_fail 'Service start failed; inspect private logs; no forced restart attempted'
fi
sh "$service" "$root" status >/dev/null 2>&1 || todo_fail 'Service is not ready after start'
printf '%s ready\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$root/logs/recovery.log"
result started
