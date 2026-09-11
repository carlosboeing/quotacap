#!/usr/bin/env bash
# install.sh — download the quotacap binary (and pty sidecar) from GitHub Releases,
# register the background login service, and open the dashboard. One step, no flags needed.
#
# Usage:  curl -fsSL https://raw.githubusercontent.com/carlosboeing/quotacap/main/install.sh | sh
#         install.sh [--bin-dir <dir>] [--version <v>] [--no-service] [--no-open]

set -euo pipefail

BIN_DIR="${QUOTACAP_BIN_DIR:-$HOME/.local/bin}"
VERSION="${QUOTACAP_VERSION:-latest}"
NO_SERVICE=0
NO_OPEN=0

while (( $# )); do
  case "$1" in
    --bin-dir) BIN_DIR="${2:?--bin-dir needs a path}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --no-open) NO_OPEN=1; shift ;;
    --yes|-y) shift ;;
    --help|-h)
      echo "usage: install.sh [--bin-dir <dir>] [--version <v>] [--no-service] [--no-open]"
      echo "  --no-service  skip background service registration (foreground only)"
      echo "  --no-open     skip opening the dashboard browser"
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
TARBALL="${NAME}.tar.gz"
if [[ -n "${QUOTACAP_BASE_URL:-}" ]]; then
  BASE_URL="$QUOTACAP_BASE_URL"
elif [[ "$VERSION" == "latest" ]]; then
  BASE_URL="https://github.com/carlosboeing/quotacap/releases/latest/download"
else
  [[ "$VERSION" != v* ]] && VERSION="v$VERSION"
  BASE_URL="https://github.com/carlosboeing/quotacap/releases/download/${VERSION}"
fi
SUMS_URL="${BASE_URL}/SHA256SUMS"
TARGET="$BIN_DIR/quotacap"

if [[ -e "$TARGET" ]]; then
  echo "upgrading existing install at $TARGET"
fi

mkdir -p "$BIN_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TMP_SUMS="$TMP_DIR/SHA256SUMS"
echo "downloading $SUMS_URL"
curl -fsSL "$SUMS_URL" -o "$TMP_SUMS"

verify_checksum() {
  local file="$1"
  local name="$2"
  local expected
  expected="$(tr -d '\r' < "$TMP_SUMS" | awk -v name="$name" '$2 == name || $2 == "*"name { print $1; exit }' | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$expected" ]]; then
    echo "error  $name not found in SHA256SUMS" >&2
    return 1
  fi
  local actual
  case "$SHA_CMD" in
    sha256sum) actual="$(sha256sum "$file" | awk '{print $1}')" ;;
    shasum)    actual="$(shasum -a 256 "$file" | awk '{print $1}')" ;;
    openssl)   actual="$(openssl dgst -sha256 "$file" | awk '{print $NF}')" ;;
  esac
  actual="$(echo "$actual" | tr '[:upper:]' '[:lower:]')"
  if [[ "$actual" != "$expected" ]]; then
    echo "error  checksum mismatch for $name" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    return 1
  fi
  echo "verified checksum: $actual"
  return 0
}

# Prefer tarball with pty sidecar (new releases); fallback to bare binary for old releases
TARBALL_URL="${BASE_URL}/${TARBALL}"
TMP_TARBALL="$TMP_DIR/$TARBALL"
echo "downloading $TARBALL_URL (with pty sidecar)"
if curl -fsSL "$TARBALL_URL" -o "$TMP_TARBALL" 2>/dev/null; then
  verify_checksum "$TMP_TARBALL" "$TARBALL"
  echo "extracting $TARBALL"
  tar -xzf "$TMP_TARBALL" -C "$TMP_DIR"
  # Tarball contains: quotacap and pty/node-pty/
  if [[ ! -f "$TMP_DIR/quotacap" ]]; then
    echo "error  tarball did not contain quotacap binary" >&2
    exit 1
  fi
  chmod +x "$TMP_DIR/quotacap"
  mv "$TMP_DIR/quotacap" "$TARGET"
  # Install pty sidecar alongside binary and in XDG share for homedir fallback
  if [[ -d "$TMP_DIR/pty" ]]; then
    # Alongside binary
    rm -rf "$BIN_DIR/pty"
    cp -R "$TMP_DIR/pty" "$BIN_DIR/pty"
    chmod +x "$BIN_DIR/pty/node-pty/prebuilds/"*/spawn-helper 2>/dev/null || true
    # XDG share
    SHARE_DIR="$HOME/.local/share/quotacap"
    mkdir -p "$SHARE_DIR"
    rm -rf "$SHARE_DIR/pty"
    cp -R "$TMP_DIR/pty" "$SHARE_DIR/pty"
    chmod +x "$SHARE_DIR/pty/node-pty/prebuilds/"*/spawn-helper 2>/dev/null || true
    echo "installed pty sidecar to $BIN_DIR/pty and $SHARE_DIR/pty"
  fi
else
  # Fallback: single binary (pre-sidecar releases)
  URL="${BASE_URL}/${NAME}"
  TMP_BIN="$TMP_DIR/$NAME"
  echo "downloading $URL"
  curl -fsSL "$URL" -o "$TMP_BIN"
  verify_checksum "$TMP_BIN" "$NAME"
  chmod +x "$TMP_BIN"
  mv "$TMP_BIN" "$TARGET"
fi

if [[ ! -x "$TARGET" ]]; then
  echo "error  $TARGET was installed but is not executable." >&2
  exit 1
fi

echo "installed $TARGET"

# dashboard_url prints the daemon endpoint, resolved from the installed config.
dashboard_url() {
  local url
  url="$("$TARGET" service status 2>/dev/null | grep -o 'http://127\.0\.0\.1:[0-9]*' | head -1 || true)"
  if [[ -z "$url" ]]; then url="http://127.0.0.1:8787"; fi
  echo "$url"
}

# Step 1: provision config (idempotent; warn-only on failure).
if ! "$TARGET" init --quiet; then
  echo "warning  config provisioning failed; continuing (commands provision lazily)" >&2
fi

# Step 2: register the login background service (idempotent).
SERVICE_OK=0
if [[ "$NO_SERVICE" == "1" ]]; then
  echo "skipping background service registration (--no-service)"
elif ! "$TARGET" service install; then
  echo "warning  service install failed; run 'quotacap daemon' in the foreground instead" >&2
else
  SERVICE_OK=1
fi

# Step 3: wait up to 15s for daemon readiness.
READY=0
if [[ "$SERVICE_OK" == "1" ]]; then
  echo "waiting for daemon readiness (up to 15s)"
  for ((i = 0; i < 15; i++)); do
    if "$TARGET" service status 2>/dev/null | grep -q "^Readiness: ready"; then READY=1; break; fi
    sleep 1
  done
  if [[ "$READY" != "1" ]]; then
    echo "warning  service not ready within 15s; continuing" >&2
  fi
fi

# Step 4: open the dashboard (only against a ready daemon, so it can never hang).
OPENED=0
DASHBOARD_URL="$(dashboard_url)"
if [[ "$NO_OPEN" == "1" ]]; then
  echo "skipping dashboard open (--no-open)"
elif [[ "$READY" == "1" ]]; then
  if "$TARGET" web; then OPENED=1; fi
else
  echo "Dashboard: $DASHBOARD_URL"
  echo "Run 'quotacap web' to open the dashboard once the service is ready."
fi

# Step 5: PATH check plus shadow warning.
if command -v quotacap >/dev/null 2>&1; then
  EXISTING="$(command -v quotacap)"
  if [[ "$EXISTING" != "$TARGET" ]]; then
    echo "warning  $EXISTING shadows this install ($TARGET); remove one of them to avoid version confusion" >&2
  fi
else
  echo "$BIN_DIR is not on your PATH. Add this to your shell profile:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi

# Linux linger hint: without it the user service dies on logout.
if [[ "$OS" == "linux" && "$NO_SERVICE" != "1" && "$SERVICE_OK" == "1" ]] && command -v loginctl >/dev/null 2>&1; then
  LINGER_USER="${USER:-$(id -un)}"
  LINGER_STATE="$(loginctl show-user "$LINGER_USER" -p Linger 2>/dev/null || true)"
  if [[ "$LINGER_STATE" != *"yes"* ]]; then
    echo "hint  run 'loginctl enable-linger $LINGER_USER' to keep the service running after logout"
  fi
fi

# Summary.
INSTALLED_VERSION="$("$TARGET" version 2>/dev/null || echo "$VERSION")"
if [[ "$SERVICE_OK" == "1" && "$READY" == "1" && "$OPENED" == "1" ]]; then
  echo "✓ QuotaCap v${INSTALLED_VERSION} installed and running in background"
  echo "✓ Dashboard opened at ${DASHBOARD_URL}"
elif [[ "$SERVICE_OK" == "1" && "$READY" == "1" && "$NO_OPEN" == "1" ]]; then
  echo "✓ QuotaCap v${INSTALLED_VERSION} installed and running in background"
  echo "- Dashboard ready at ${DASHBOARD_URL} (skipped open: --no-open)"
elif [[ "$NO_SERVICE" == "1" ]]; then
  echo "- QuotaCap v${INSTALLED_VERSION} installed (no background service; foreground only)"
  echo "  Dashboard: ${DASHBOARD_URL} (run 'quotacap web' to open it)"
else
  echo "! QuotaCap v${INSTALLED_VERSION} installed but the background service is not running"
  if [[ "$READY" == "1" ]]; then
    echo "  Dashboard ready at ${DASHBOARD_URL}"
  else
    echo "  Dashboard: ${DASHBOARD_URL} (run 'quotacap web' once the service is ready)"
  fi
fi
echo ""
echo "Useful commands:"
echo "  quotacap status    View current quota table"
echo "  quotacap advise    Show next-provider recommendation"
echo "  quotacap update    Check for and apply updates"
echo "  quotacap web       Re-open dashboard"
