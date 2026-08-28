#!/usr/bin/env bash
# install.sh — download the quotacap binary from GitHub Releases onto your PATH.
#
# Usage:  curl -fsSL https://raw.githubusercontent.com/carlosboeing/quotacap/main/install.sh | sh
#         install.sh [--bin-dir <dir>] [--version <v>] [--yes]

set -euo pipefail

BIN_DIR="${QUOTACAP_BIN_DIR:-$HOME/.local/bin}"
VERSION="${QUOTACAP_VERSION:-latest}"
ASSUME_YES=0

while (( $# )); do
  case "$1" in
    --bin-dir) BIN_DIR="${2:?--bin-dir needs a path}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --help|-h)
      echo "usage: install.sh [--bin-dir <dir>] [--version <v>] [--yes]"
      exit 0 ;;
    *) echo "error  unknown option: $1" >&2; exit 1 ;;
  esac
done

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) echo "error  unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "error  unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "error  curl is required" >&2
  exit 1
fi

NAME="quotacap-${OS}-${ARCH}"
URL="https://github.com/carlosboeing/quotacap/releases/${VERSION}/download/${NAME}"
TARGET="$BIN_DIR/quotacap"

if [[ -e "$TARGET" && "$ASSUME_YES" != "1" ]]; then
  echo "error  $TARGET already exists. Re-run with --yes to replace it." >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "downloading $URL"
curl -fsSL "$URL" -o "$TMP"
chmod +x "$TMP"
mv "$TMP" "$TARGET"

if [[ ! -x "$TARGET" ]]; then
  echo "error  $TARGET was installed but is not executable." >&2
  exit 1
fi

echo "installed $TARGET"
if ! command -v quotacap >/dev/null 2>&1; then
  echo "$BIN_DIR is not on your PATH. Add this to your shell profile:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi
echo "try: quotacap init"