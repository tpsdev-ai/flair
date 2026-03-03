#!/usr/bin/env bash
# install-launchd.sh — Harper launchd agent management
# Usage: ./scripts/install-launchd.sh install|uninstall|status|restart
set -euo pipefail

LABEL="ai.tpsdev.flair"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PLIST_TEMPLATE="$(cd "$(dirname "$0")" && pwd)/${LABEL}.plist"
FLAIR_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARPER_DATA_DIR="$HOME/.harper/flair"
LOG_DIR="$HOME/.tps/logs"
ACTION="${1:-status}"

_substitute_plist() {
  local node_path
  node_path="$(which node)"
  sed \
    -e "s|FLAIR_DIR|$FLAIR_DIR|g" \
    -e "s|HOME_DIR|$HOME|g" \
    -e "s|ADMIN_TOKEN_PLACEHOLDER|${ADMIN_TOKEN}|g" \
    -e "s|/opt/homebrew/bin/node|$node_path|g" \
    "$PLIST_TEMPLATE"
}

_is_loaded() {
  launchctl list "$LABEL" &>/dev/null
}

_install() {
  echo "→ Creating directories..."
  mkdir -p "$HARPER_DATA_DIR" "$LOG_DIR"

  # Generate admin token if not present
  local SECRETS_DIR="$HOME/.tps/secrets/flair"
  local TOKEN_PATH="$SECRETS_DIR/harper-admin-token"
  mkdir -p "$SECRETS_DIR"
  if [[ ! -f "$TOKEN_PATH" ]]; then
    openssl rand -base64 32 > "$TOKEN_PATH"
    chmod 600 "$TOKEN_PATH"
    echo "→ Generated admin token at $TOKEN_PATH"
  else
    echo "→ Using existing admin token at $TOKEN_PATH"
  fi
  export ADMIN_TOKEN
  ADMIN_TOKEN="$(cat "$TOKEN_PATH")"

  echo "→ Writing plist to $PLIST_DST"
  _substitute_plist > "$PLIST_DST"
  chmod 644 "$PLIST_DST"

  if _is_loaded; then
    echo "→ Unloading existing service..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
  fi

  echo "→ Loading launchd agent..."
  launchctl load "$PLIST_DST"

  echo "✅ Harper installed and started"
  echo "   Data:  $HARPER_DATA_DIR"
  echo "   Logs:  $LOG_DIR/harper.log"
  sleep 5
  _status
}

_uninstall() {
  if _is_loaded; then
    echo "→ Unloading..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
  fi
  if [[ -f "$PLIST_DST" ]]; then
    rm "$PLIST_DST"
    echo "✅ Harper uninstalled"
  else
    echo "Nothing to uninstall"
  fi
}

_status() {
  if ! [[ -f "$PLIST_DST" ]]; then
    echo "Harper: NOT INSTALLED"
    echo "  Run: $0 install"
    return
  fi
  if ! _is_loaded; then
    echo "Harper: INSTALLED but NOT RUNNING"
    echo "  Run: $0 restart"
    return
  fi
  local pid
  pid=$(launchctl list "$LABEL" 2>/dev/null | grep '"PID"' | grep -o '[0-9]*' | head -1 || echo "")
  if curl -sf -o /dev/null --max-time 3 http://127.0.0.1:9925/health 2>/dev/null; then
    echo "Harper: ✅ RUNNING (PID: ${pid:-?})"
  else
    echo "Harper: ⚠️  LOADED but not responding (PID: ${pid:-?})"
  fi
  echo "  API:   http://127.0.0.1:9925"
  echo "  Flair: http://127.0.0.1:9926"
  echo "  Data:  $HARPER_DATA_DIR"
  echo "  Logs:  $LOG_DIR/harper.log"
}

_restart() {
  if ! [[ -f "$PLIST_DST" ]]; then
    echo "❌ Not installed. Run: $0 install"
    exit 1
  fi
  if _is_loaded; then
    # kickstart -k kills the current instance and starts a fresh one
    launchctl kickstart -k "user/$(id -u)/$LABEL"
    echo "✅ Harper restarted"
  else
    launchctl load "$PLIST_DST"
    echo "✅ Harper started"
  fi
}

case "$ACTION" in
  install)   _install   ;;
  uninstall) _uninstall ;;
  status)    _status    ;;
  restart)   _restart   ;;
  *)
    echo "Usage: $0 install|uninstall|status|restart"
    exit 1
    ;;
esac
