#!/bin/sh
set -eu
umask 077
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=deploy/helios/common.sh
. "$here/common.sh"
todo_root "$1"
cache=${2:--}
test "$(uname -s)" = FreeBSD && test "$(uname -m)" = amd64 || todo_fail 'Runtime requires FreeBSD amd64'
case "$(uname -r)" in 14.*) ;; *) todo_fail 'Review package ABI for this FreeBSD version first' ;; esac
if test -d "$root/runtime"; then
  test -f "$root/runtime/.prepared" || todo_fail 'Runtime is incomplete; inspect manually'
else
  stage="$root/runtime.next"
  test ! -e "$stage" || todo_fail 'Partial runtime exists; inspect manually'
  mkdir -m 700 "$stage"
  mkdir -p "$root/packages"
  while IFS= read -r package; do
    case "$package" in ''|'#'*) continue ;; All/Hashed/*.pkg) ;; *) todo_fail 'Invalid package manifest' ;; esac
    archive="$root/packages/${package##*/}"
    if ! test -f "$archive"; then
      if test "$cache" != '-' && test -f "$cache/${package##*/}"; then
        cp "$cache/${package##*/}" "$archive.partial"
      else
        curl --proto '=https' --proto-redir '=https' --location --tlsv1.2 --fail --silent --show-error --max-time 180 \
          "https://pkg.FreeBSD.org/FreeBSD:14:amd64/latest/$package" -o "$archive.partial" \
          || todo_fail 'Pinned archive is unavailable; supply the reviewed TODO_PACKAGE_CACHE, do not silently upgrade binaries'
      fi
      mv "$archive.partial" "$archive"
    fi
    expected=$(awk -v file="${package##*/}" '$2 == file { print $1 }' "$here/freebsd-packages.sha256")
    test "${#expected}" -eq 64 || todo_fail 'Missing or ambiguous SHA256 pin'
    test "$(sha256 -q "$archive")" = "$expected" || todo_fail "Package checksum mismatch: ${package##*/}"
    tar -xf "$archive" -C "$stage" --strip-components 3 --include '/usr/local/*' --no-same-owner
    sha256 "$archive" >> "$stage/package-checksums.txt"
  done < "$here/freebsd-packages.txt"
  LD_LIBRARY_PATH="$stage/lib" "$stage/bin/node" --version
  LD_LIBRARY_PATH="$stage/lib" "$stage/bin/mongod" --version
  touch "$stage/.prepared"
  mv "$stage" "$root/runtime"
fi
"$root/runtime/bin/node" --version
"$root/runtime/bin/mongod" --version
