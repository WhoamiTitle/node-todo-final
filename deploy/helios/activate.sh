#!/bin/sh
set -eu
umask 077
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
# shellcheck source=deploy/helios/common.sh
. "$here/common.sh"
test "$#" -ge 4 && test "$#" -le 5 || todo_fail 'Usage: activate.sh PRIVATE_ROOT COMMIT PUBLIC_PATH HTTPS_URL [approved|preview|rollback]'
todo_root "$1"
release=$2
public=$3
base=$4
mode=${5:-approved}
case "$mode" in approved|preview|rollback) ;; *) todo_fail 'Invalid publication mode' ;; esac
todo_release "$release"
target_here=$(CDPATH='' cd -- "$root/releases/$release/deploy/helios" && pwd -P)
test "$here" = "$target_here" || todo_fail 'Run the target release activation script'
case "$public" in /*/public_html/todo) ;; *) todo_fail 'Expected public_html/todo' ;; esac
case "$public" in *[!A-Za-z0-9_./-]*|*/../*|*/./*|*//*) todo_fail 'Unsafe public path' ;; esac
case "$base" in https://se.ifmo.ru/~*/todo/) ;; *) todo_fail 'Expected the Helios HTTPS TODO root' ;; esac
test -f "$root/config/db.initialized" || todo_fail 'Initialize MongoDB explicitly before deploying'
test -f "$root/releases/$release/.installed" || todo_fail 'Release is not installed'
test ! -L "$public" || todo_fail 'Public directory must not be a symlink'
if test -d "$public"; then
  test "$(find "$public" -prune -user "$(id -u)")" = "$public" || todo_fail 'Public directory belongs to another user'
  test -f "$public/.todo-managed" || todo_fail 'Refusing to overwrite an unmanaged public directory'
fi
exec 9>> "$root/run/deployment.guard"
lockf -s -t 10 9 || todo_fail 'Another deployment is active'
metadata_files='previous-release deployed-release publication-mode'
for file in $metadata_files; do
  path="$root/$file"
  if test -L "$path" || { test -e "$path" && ! test -f "$path"; }; then
    todo_fail "Expected regular release metadata: $file"
  fi
done
previous_mode=approved
if test -e "$root/publication-mode"; then
  previous_mode=$(cat "$root/publication-mode")
  case "$previous_mode" in approved|preview) ;; *) todo_fail 'Invalid saved publication mode' ;; esac
fi
if test "$mode" = rollback; then mode=$previous_mode; fi
if test "$mode" = approved; then
  test -f "$root/config/db-access-approved" || todo_fail 'Agree independent DB access before publishing'
fi
previous=''
if test -L "$root/current"; then
  previous=$(readlink "$root/current")
  previous=${previous##*/}
  todo_release "$previous"
  test -f "$root/releases/$previous/.installed" || todo_fail 'Previous release is invalid'
elif test -e "$root/current"; then todo_fail 'Current must be a symlink'; fi
operation="$root/run/activation-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
mkdir -m 700 "$operation"
for file in $metadata_files; do
  if test -f "$root/$file"; then cp -p "$root/$file" "$operation/old-$file"; fi
done
printf '%s\n' "$previous" > "$operation/new-previous-release"
printf '%s\n' "$release" > "$operation/new-deployed-release"
printf '%s\n' "$mode" > "$operation/new-publication-mode"
published=0
changed=0
committed=0

restore() {
  result=$?
  trap - EXIT HUP INT TERM
  if test "$changed" -eq 1 && test "$committed" -eq 0; then
    printf '%s\n' 'Activation failed; restoring application code without rolling back data.' >&2
    if ! sh "$root/current/deploy/helios/service.sh" "$root" stop-node; then
      todo_fail 'Rollback blocked: new application could not be stopped safely'
    fi
    if test -n "$previous"; then
      "$root/runtime/bin/node" "$here/switch-release.mjs" "$root" "$previous" || todo_fail 'Could not restore previous release pointer'
      if test "$published" -eq 1; then
        cp "$operation/index.php" "$public/index.php.next"
        chmod 644 "$public/index.php.next"
        mv -f "$public/index.php.next" "$public/index.php"
        cp "$operation/htaccess" "$public/.htaccess.next"
        chmod 644 "$public/.htaccess.next"
        mv -f "$public/.htaccess.next" "$public/.htaccess"
        printf '%s\n' "$previous" > "$public/.todo-managed"
      fi
    else
      sh "$root/current/deploy/helios/service.sh" "$root" stop || todo_fail 'First release services did not stop'
      rm "$root/current"
      if test "$published" -eq 1; then
        rm -f "$public/index.php" "$public/.htaccess" "$public/.todo-managed"
        rmdir "$public" || true
      fi
    fi
    # A missing staged file means its rename completed. Undo only those replacements.
    for file in $metadata_files; do
      if test -e "$operation/new-$file"; then continue; fi
      if test -f "$operation/old-$file"; then
        mv -f "$operation/old-$file" "$root/$file" || todo_fail "Could not restore $file"
      else
        rm -f "$root/$file" || todo_fail "Could not remove uncommitted $file"
      fi
    done
    if test -n "$previous"; then
      sh "$root/current/deploy/helios/service.sh" "$root" start || todo_fail 'Previous release did not recover'
      "$root/runtime/bin/node" --env-file="$root/config/app.env" "$root/current/deploy/helios/contracts.mjs" "$base" "$previous_mode" \
        || todo_fail 'Previous public contracts failed after rollback'
    fi
    printf '%s\n' 'Previous state restored; failed release retained for inspection.' >&2
  fi
  exit "$result"
}
trap restore EXIT
trap 'exit 130' HUP INT TERM

if test -n "$previous"; then
  test -f "$public/index.php" && test -f "$public/.htaccess" || todo_fail 'Public gateway is incomplete'
  cp "$public/index.php" "$operation/index.php"
  cp "$public/.htaccess" "$operation/htaccess"
  sh "$root/current/deploy/helios/service.sh" "$root" stop-node
fi
changed=1
"$root/runtime/bin/node" "$here/switch-release.mjs" "$root" "$release"
sh "$root/current/deploy/helios/service.sh" "$root" start
port=$("$root/runtime/bin/node" --env-file="$root/config/app.env" -e 'process.stdout.write(process.env.PORT)')
"$root/runtime/bin/node" --env-file="$root/config/app.env" "$root/current/deploy/helios/contracts.mjs" "http://127.0.0.1:$port/"
prefix=${base#https://se.ifmo.ru}
prefix=${prefix%/}
"$root/runtime/bin/node" "$root/current/deploy/helios/render-gateway.mjs" "$operation/public" "$prefix" "$port" "$mode"
php -l "$operation/public/index.php"
mkdir -p "$public"
chmod 755 "$public"
published=1
cp "$operation/public/.htaccess" "$public/.htaccess.next"
chmod 644 "$public/.htaccess.next"
mv -f "$public/.htaccess.next" "$public/.htaccess"
cp "$operation/public/index.php" "$public/index.php.next"
chmod 644 "$public/index.php.next"
mv -f "$public/index.php.next" "$public/index.php"
printf '%s\n' "$release" > "$public/.todo-managed"
chmod 600 "$public/.todo-managed"
"$root/runtime/bin/node" --env-file="$root/config/app.env" "$root/current/deploy/helios/contracts.mjs" "$base" "$mode"
for file in $metadata_files; do
  mv -f "$operation/new-$file" "$root/$file"
done
committed=1
printf 'Published TODO commit %s at %s (mode: %s)\n' "$release" "$base" "$mode"
if test "$mode" = preview; then printf '%s\n' 'Preview only: independent teacher DB access remains unapproved.'; fi
