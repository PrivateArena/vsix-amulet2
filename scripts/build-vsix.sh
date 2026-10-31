#!/usr/bin/env bash
#
# Build the extension VSIX in one shot: typecheck -> unit tests -> production
# bundle -> vsce package. Packaging tools come from node_modules and vsce is
# fetched on demand, so pnpm does not have to be on PATH.
#
# The artifact goes to /tmp/amulet/ by default so the repo root stays clean;
# --notmp writes it into <repo>/vsix/ instead.
#
# Usage: scripts/build-vsix.sh [-f|--fast] [-i|--install] [-b|--bump] [--notmp] [-h|--help]
#   -f, --fast     skip typecheck + tests (bundle and package only)
#   -i, --install  install the result into the local VS Code after packaging
#   -b, --bump     increment package.json's patch version first (off by default)
#       --notmp    package into <repo>/vsix/ instead of /tmp/amulet/
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT=$PWD
BIN=$ROOT/node_modules/.bin

usage() {
  cat <<'EOF'
Build the extension VSIX in one shot:
  typecheck -> unit tests -> production bundle -> vsce package

Usage: scripts/build-vsix.sh [-f|--fast] [-i|--install] [-b|--bump] [--notmp] [-h|--help]
  -f, --fast     skip typecheck + tests (bundle and package only)
  -i, --install  install the result into the local VS Code after packaging
  -b, --bump     increment the patch version in package.json before packaging
                 (the version is left untouched without this flag)
      --notmp    write the .vsix to <repo>/vsix/ instead of /tmp/amulet/

Works without pnpm: it uses node_modules/.bin for tsc/vitest and falls back to
`npx @vscode/vsce` when vsce is not installed.
EOF
}

FAST=0
INSTALL=0
BUMP=0
USE_TMP=1
for arg in "$@"; do
  case "$arg" in
    -f | --fast) FAST=1 ;;
    -i | --install) INSTALL=1 ;;
    -b | --bump) BUMP=1 ;;
    --notmp) USE_TMP=0 ;;
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

# Rewrite only the "version" line so the rest of package.json (tabs, key order,
# comments-adjacent formatting) stays byte-for-byte identical.
bump_version() {
  "$NODE" -e '
    const fs = require("node:fs");
    const file = "package.json";
    const source = fs.readFileSync(file, "utf8");
    const current = JSON.parse(source).version;
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
    if (!match) {
      console.error(`build-vsix: cannot bump non-semver version "${current}"`);
      process.exit(1);
    }
    const next = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
    const token = `"version": ${JSON.stringify(current)}`;
    if (!source.includes(token)) {
      console.error(`build-vsix: could not locate ${token} in ${file}`);
      process.exit(1);
    }
    fs.writeFileSync(file, source.replace(token, `"version": ${JSON.stringify(next)}`));
    process.stdout.write(next);
  '
}

command -v node >/dev/null 2>&1 || die "node is not on PATH"
[[ -d $ROOT/node_modules ]] ||
  die "node_modules is missing — install dependencies first (pnpm install)"

NODE=${NODE:-node}
VERSION=$("$NODE" -p "require('./package.json').version")
NAME=$("$NODE" -p "require('./package.json').name")

if ((BUMP)); then
  step "bump patch version"
  BUMPED=$(bump_version) || die "version bump failed"
  printf 'package.json: %s -> %s\n' "$VERSION" "$BUMPED"
  VERSION=$BUMPED
fi

if ((USE_TMP)); then
  OUT_DIR=/tmp/amulet
else
  OUT_DIR=$ROOT/vsix
fi
mkdir -p "$OUT_DIR"
ARTIFACT="$OUT_DIR/$NAME-$VERSION.vsix"

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

step "package v$VERSION -> $OUT_DIR"
# Prefer an installed vsce (local node_modules, then PATH) before paying the
# npx download; @vscode/vsce is the current package name for vsce.
if [[ -x $BIN/vsce ]]; then
  "$BIN/vsce" package --no-dependencies --out "$ARTIFACT"
elif command -v vsce >/dev/null 2>&1; then
  vsce package --no-dependencies --out "$ARTIFACT"
else
  npx --yes @vscode/vsce package --no-dependencies --out "$ARTIFACT"
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
