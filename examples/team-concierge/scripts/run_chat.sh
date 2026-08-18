#!/usr/bin/env bash
# Team Concierge — interactive runner.
#
#   scripts/run_chat.sh          # adk web (browser dev UI)
#   scripts/run_chat.sh run      # adk run (terminal chat)
#
# Required environment (see README):
#   FLAIR_URL       e.g. http://localhost:19926
#   FLAIR_AGENT_ID  the concierge's Flair agent identity (e.g. "concierge")
#   FLAIR_KEYFILE   path to that identity's Ed25519 keyfile
#   GOOGLE_API_KEY  (or GEMINI_API_KEY) for the default Gemini model;
#                   override the model with ADK_MODEL.
set -euo pipefail

EXAMPLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

: "${FLAIR_URL:?Set FLAIR_URL (e.g. http://localhost:19926)}"
: "${FLAIR_AGENT_ID:?Set FLAIR_AGENT_ID (provision with: flair agent add concierge)}"
: "${FLAIR_KEYFILE:?Set FLAIR_KEYFILE (e.g. ~/.flair/keys/concierge.key)}"

# Derive the flair:// memory URI from FLAIR_URL (host:port only — identity
# and keyfile always come from the env, never the URI).
HOSTPORT="${FLAIR_URL#*://}"
HOSTPORT="${HOSTPORT%%/*}"
MEMORY_URI="flair://${HOSTPORT}"

MODE="${1:-web}"
cd "$EXAMPLE_DIR"

case "$MODE" in
  web)
    # agents dir = this example dir; ADK loads services.py from it, which
    # registers the flair:// scheme, then discovers the `concierge` package.
    exec adk web --memory_service_uri="$MEMORY_URI" "$EXAMPLE_DIR"
    ;;
  run)
    exec adk run --memory_service_uri="$MEMORY_URI" "$EXAMPLE_DIR/concierge"
    ;;
  *)
    echo "usage: $0 [web|run]" >&2
    exit 2
    ;;
esac
