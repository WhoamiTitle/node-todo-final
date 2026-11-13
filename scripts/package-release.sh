#!/bin/sh
set -eu
umask 077
here=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
repository=$(git -C "$here" rev-parse --show-toplevel)
repository=$(CDPATH='' cd -- "$repository" && pwd -P)
test "$here" = "$repository" || { printf '%s\n' 'Expected the standalone TODO repository root' >&2; exit 1; }
test -z "$(git -C "$repository" status --porcelain)" || {
  printf '%s\n' 'Commit reviewed TODO changes before building a deployable release.' >&2; exit 1;
}
revision=$(git -C "$repository" rev-parse HEAD)
output="$here/.local/releases"
mkdir -p "$output"
stage=$(mktemp -d "$output/stage.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
# Only tracked source enters the release; ignored secrets and local node_modules cannot enter it.
git -C "$repository" archive --format=tar --output="$stage/source.tar" HEAD \
  package.json package-lock.json .env.example src public scripts/init-db.mjs deploy/helios
mkdir "$stage/app"
tar -xf "$stage/source.tar" -C "$stage/app"
node "$here/scripts/assets.mjs" "$stage/app/public/icons"
printf '%s\n' "$revision" > "$stage/app/REVISION"
tar -cf "$stage/release.tar" -C "$stage/app" .
mv "$stage/release.tar" "$output/$revision.tar"
printf '%s\n' "$output/$revision.tar"
