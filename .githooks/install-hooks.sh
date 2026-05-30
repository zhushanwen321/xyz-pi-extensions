#!/bin/bash
# install-hooks.sh — symlink .githooks/* → .bare/hooks/
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_SRC="$REPO_ROOT/.githooks"
HOOKS_DST="$REPO_ROOT/.bare/hooks"

if [ ! -d "$HOOKS_DST" ]; then
  echo "[install-hooks] .bare/hooks/ not found, skipping"
  exit 0
fi

for f in "$HOOKS_SRC"/*; do
  name="$(basename "$f")"
  [[ "$name" == .* ]] && continue
  dst="$HOOKS_DST/$name"
  if [ -e "$dst" ] && ([ ! -L "$dst" ] || [ "$(readlink "$dst")" != "$f" ]); then
    rm "$dst"
  fi
  if [ ! -e "$dst" ]; then
    ln -s "$f" "$dst"
    echo "[install-hooks] $name"
  fi
done
