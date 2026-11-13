#!/bin/sh
set -eu
umask 077
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=deploy/helios/common.sh
. "$here/common.sh"
test "$#" -eq 2 || todo_fail 'Usage: run.sh PRIVATE_ROOT node|mongo'
todo_root "$1"
case "$2" in
  node)
    cd -P "$root/current"
    exec "$root/runtime/bin/node" --env-file="$root/config/app.env" "$PWD/src/index.mjs"
    ;;
  mongo) exec "$root/runtime/bin/mongod" --config "$root/config/mongod.json" ;;
  *) todo_fail 'Unknown service' ;;
esac
