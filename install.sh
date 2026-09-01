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

if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum"
elif command -v openssl >/dev/null 2>&1; then
  SHA_CMD="openssl"
else
  echo "error  sha256sum, shasum, or openssl is required for checksum verification" >&2
  exit 1
fi

NAME="quotacap-${OS}-${ARCH}"
if [[ -n "${QUOTACAP_BASE_URL:-}" ]]; then
  BASE_URL="$QUOTACAP_BASE_URL"
elif [[ "$VERSION" == "latest" ]]; then
  BASE_URL="https://github.com/carlosboeing/quotacap/releases/latest/download"
else
  [[ "$VERSION" != v* ]] && VERSION="v$VERSION"
  BASE_URL="https://github.com/carlosboeing/quotacap/releases/download/${VERSION}"
fi
URL="${BASE_URL}/${NAME}"
SUMS_URL="${BASE_URL}/SHA256SUMS"
TARGET="$BIN_DIR/quotacap"

if [[ -e "$TARGET" && "$ASSUME_YES" != "1" ]]; then
  echo "error  $TARGET already exists. Re-run with --yes to replace it." >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TMP_BIN="$TMP_DIR/$NAME"
TMP_SUMS="$TMP_DIR/SHA256SUMS"

echo "downloading $URL"
curl -fsSL "$URL" -o "$TMP_BIN"

echo "downloading $SUMS_URL"
curl -fsSL "$SUMS_URL" -o "$TMP_SUMS"

EXPECTED_SHA="$(tr -d '\r' < "$TMP_SUMS" | awk -v name="$NAME" '$2 == name || $2 == "*"name { print $1; exit }' | tr '[:upper:]' '[:lower:]')"
if [[ -z "$EXPECTED_SHA" ]]; then
  echo "error  $NAME not found in SHA256SUMS" >&2
  exit 1
fi

case "$SHA_CMD" in
  sha256sum) ACTUAL_SHA="$(sha256sum "$TMP_BIN" | awk '{print $1}')" ;;
  shasum)    ACTUAL_SHA="$(shasum -a 256 "$TMP_BIN" | awk '{print $1}')" ;;
  openssl)   ACTUAL_SHA="$(openssl dgst -sha256 "$TMP_BIN" | awk '{print $NF}')" ;;
esac
ACTUAL_SHA="$(echo "$ACTUAL_SHA" | tr '[:upper:]' '[:lower:]')"

if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo "error  checksum mismatch for $NAME" >&2
  echo "  expected: $EXPECTED_SHA" >&2
  echo "  actual:   $ACTUAL_SHA" >&2
  exit 1
fi

echo "verified checksum: $ACTUAL_SHA"
chmod +x "$TMP_BIN"
mv "$TMP_BIN" "$TARGET"

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