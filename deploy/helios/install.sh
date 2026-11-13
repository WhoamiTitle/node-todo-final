#!/bin/sh
# Sent over verified SSH; all arguments are validated before filesystem changes.
set -eu
umask 077
test "$#" -eq 7 || exit 2
root=$1
release=$2
action=$3
public=$4
base=$5
upload_name=$6
cache=$7
case "$root" in /*/.node-todo-final) ;; *) exit 2 ;; esac
case "$root" in *[!A-Za-z0-9_./-]*|*/../*|*/./*|*//*) exit 2 ;; esac
case "$release" in ''|*[!a-f0-9]*) exit 2 ;; esac
test "${#release}" -eq 40 || exit 2
case "$upload_name" in "$release".*.tar) ;; *) exit 2 ;; esac
case "$upload_name" in *[!a-f0-9.rt-]*) exit 2 ;; esac
case "$cache" in -|/*) ;; *) exit 2 ;; esac
case "$cache" in *[!A-Za-z0-9_./-]*|*/../*|*/./*|*//*) exit 2 ;; esac
case "$action" in prepare|init-db|deploy|preview) ;; *) exit 2 ;; esac
test ! -L "$root" && test "$(find "$root" -prune -user "$(id -u)")" = "$root" || exit 2
test "$(uname -s)" = FreeBSD || { printf '%s\n' 'Deployment requires FreeBSD' >&2; exit 1; }
mkdir -p "$root/run" "$root/releases" "$root/logs" "$root/data"
exec 9>> "$root/run/install.guard"
lockf -s -t 10 9 || exit 75
directory="$root/releases/$release"
if ! test -f "$directory/.installed"; then
  test ! -e "$directory" || { printf '%s\n' 'Incomplete release exists; inspect it manually' >&2; exit 1; }
  mkdir -m 700 "$directory"
  tar -xf "$root/incoming/$upload_name" -C "$directory" --no-same-owner
  test "$(cat "$directory/REVISION")" = "$release"
  if test "$action" = prepare; then sh "$directory/deploy/helios/prepare-runtime.sh" "$root" "$cache"; fi
  test -f "$root/runtime/.prepared" || { printf '%s\n' 'Run prepare first' >&2; exit 1; }
  export PATH="$root/runtime/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin"
  export LD_LIBRARY_PATH="$root/runtime/lib"
  cd "$directory"
  "$root/runtime/bin/node" "$root/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts --no-audit --no-fund
  touch "$directory/.installed"
fi
rm -f "$root/incoming/$upload_name"
export PATH="$root/runtime/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin"
export LD_LIBRARY_PATH="$root/runtime/lib"
case "$action" in
  prepare)
    if ! test -e "$root/config"; then "$root/runtime/bin/node" "$directory/deploy/helios/configure.mjs" "$root"; fi
    for file in app.env database.env reviewer.env mongod.json; do test -f "$root/config/$file"; done
    printf '%s\n' 'Prepared private runtime and configuration. No service published or DB modified.'
    ;;
  init-db)
    test ! -e "$root/config/db.initialized" || { printf '%s\n' 'Already initialized; no data changed'; exit 0; }
    # shellcheck source=deploy/helios/common.sh
    . "$directory/deploy/helios/common.sh"
    todo_lock
    for candidate in node-supervisor node mongo-supervisor mongo; do todo_absent "$candidate"; done
    "$root/runtime/bin/node" "$directory/deploy/helios/bootstrap-db.mjs" "$root"
    ;;
  deploy|preview)
    exec 9>&-
    mode=approved
    if test "$action" = preview; then mode=preview; fi
    sh "$directory/deploy/helios/activate.sh" "$root" "$release" "$public" "$base" "$mode"
    ;;
esac
