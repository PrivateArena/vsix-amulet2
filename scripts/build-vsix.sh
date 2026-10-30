#!/usr/bin/env bash
#
# Build the extension VSIX in one shot: typecheck -> unit tests -> production
# bundle -> vsce package. Packaging tools come from node_modules and vsce is
# fetched on demand, so pnpm does not have to be on PATH.
#
# Usage: scripts/build-vsix.sh [-f|--fast] [-i|--install] [-h|--help]
#   -f, --fast     skip typecheck + tests (bundle and package only)
#   -i, --install  install the result into the local VS Code after packaging
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT=$PWD
BIN=$ROOT/node_modules/.bin

usage() {
  cat <<'EOF'
Build the extension VSIX in one shot:
  typecheck -> unit tests -> production bundle -> vsce package

Usage: scripts/build-vsix.sh [-f|--fast] [-i|--install] [-h|--help]
  -f, --fast     skip typecheck + tests (bundle and package only)
  -i, --install  install the result into the local VS Code after packaging

Works without pnpm: it uses node_modules/.bin for tsc/vitest and falls back to
`npx @vscode/vsce` when vsce is not installed.
EOF
}

FAST=0
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    -f | --fast) FAST=1 ;;
    -i | --install) INSTALL=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'build-vsix: unknown argument %s\n\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() {
  printf '\n\033[1;31mbuild-vsix: %s\033[0m\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || die "node is not on PATH"
[[ -d $ROOT/node_modules ]] ||
  die "node_modules is missing — install dependencies first (pnpm install)"

NODE=${NODE:-node}
VERSION=$("$NODE" -p "require('./package.json').version")
NAME=$("$NODE" -p "require('./package.json').name")
ARTIFACT="$ROOT/$NAME-$VERSION.vsix"

[[ -x $BIN/tsc ]] ||
  die "dev dependencies are missing (no $BIN/tsc) — run pnpm install"

if ((FAST)); then
  step "fast build — typecheck and tests skipped"
else
  step "typecheck"
  "$BIN/tsc" --noEmit

  step "unit tests"
  "$BIN/vitest" run
fi

step "production bundle"
"$NODE" esbuild.mjs --production

step "package v$VERSION"
# Prefer an installed vsce (local node_modules, then PATH) before paying the
# npx download; @vscode/vsce is the current package name for vsce.
if [[ -x $BIN/vsce ]]; then
  "$BIN/vsce" package --no-dependencies --out "$NAME-$VERSION.vsix"
elif command -v vsce >/dev/null 2>&1; then
  vsce package --no-dependencies --out "$NAME-$VERSION.vsix"
else
  npx --yes @vscode/vsce package --no-dependencies --out "$NAME-$VERSION.vsix"
fi

[[ -f $ARTIFACT ]] || die "vsce reported success but $ARTIFACT is missing"

SIZE=$(du -h "$ARTIFACT" | cut -f1)
printf '\n\033[1;32m%s\033[0m  (%s)\n' "$ARTIFACT" "$SIZE"

if ((INSTALL)); then
  step "install into VS Code"
  EDITOR=${EDITOR:-code}
  command -v "$EDITOR" >/dev/null 2>&1 ||
    die "$EDITOR CLI not found — install it or pass EDITOR=/path/to/code"
  "$EDITOR" --install-extension "$ARTIFACT" --force
fi
