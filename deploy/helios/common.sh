#!/bin/sh

todo_fail() { printf 'TODO: %s\n' "$*" >&2; exit 1; }

todo_root() {
  root=$1
  case "$root" in /*/.node-todo-final) ;; *) todo_fail 'Expected an absolute private .node-todo-final directory' ;; esac
  case "$root" in *[!A-Za-z0-9_./-]*|*/../*|*/./*|*//*) todo_fail 'Unsafe private root' ;; esac
  test ! -L "$root" || todo_fail 'Private root must not be a symlink'
  if test -e "$root"; then
    test "$(find "$root" -prune -user "$(id -u)")" = "$root" || todo_fail 'Private root belongs to another user'
  fi
  export PATH="$root/runtime/bin:$PATH"
  export LD_LIBRARY_PATH="$root/runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
}

todo_release() {
  case "$1" in ''|*[!a-f0-9]*) todo_fail 'Release must be a full Git commit SHA' ;; esac
  test "${#1}" -eq 40 || todo_fail 'Release must be a full Git commit SHA'
}

todo_lock() {
  test -d "$root/run" || todo_fail 'Run prepare first'
  test ! -L "$root/run/lifecycle.guard" || todo_fail 'Invalid lifecycle guard'
  exec 8>> "$root/run/lifecycle.guard"
  lockf -s -t 10 8 || todo_fail 'Another lifecycle operation is active'
}

# Only a matching UID and complete command are eligible for signalling.
todo_pid() {
  name=$1
  process_id=''
  test ! -L "$root/run/$name.pid" || return 2
  test -f "$root/run/$name.pid" || return 1
  process_id=$(cat "$root/run/$name.pid") || return 2
  case "$process_id" in ''|*[!0-9]*) return 2 ;; esac
  test "$process_id" -gt 1 || return 2
  process_info=$(ps -ww -p "$process_id" -o uid= -o command=) || {
    test "$?" -eq 1 && test -z "$process_info" || return 2
  }
  test -n "$process_info" || return 1
  read -r process_uid process_command <<EOF
$process_info
EOF
  test "$process_uid" = "$(id -u)" || return 2
  case "$name:$process_command" in
    node-supervisor:daemon:\ todo-final-node\[*\]\ \(daemon\)|mongo-supervisor:daemon:\ todo-final-mongo\[*\]\ \(daemon\)) ;;
    "node:$root/runtime/bin/node --env-file=$root/config/app.env $root/releases/"*"/src/index.mjs") ;;
    "node:/bin/sh $root/current/deploy/helios/run.sh $root node") ;;
    "mongo:$root/runtime/bin/mongod --config $root/config/mongod.json") ;;
    "mongo:/bin/sh $root/current/deploy/helios/run.sh $root mongo") ;;
    *) return 2 ;;
  esac
}

todo_absent() {
  if todo_pid "$1"; then todo_fail "$1 is already running"; else
    result=$?
    test "$result" -eq 1 || todo_fail "$1 has an ambiguous PID; inspect it manually"
  fi
}
