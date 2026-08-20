#!/usr/bin/env bash
# verify.sh — the Team Concierge scenario's claims, executed.
# The demo IS the test: run it against a LIVE Flair instance.
#
# Environment:
#   FLAIR_URL              required — the instance under test
#                          (non-localhost also needs FLAIR_ALLOW_REMOTE_URL=1,
#                          the connector's remote-URL opt-in)
#
#   Identities — one of:
#     (a) auto-provision (throwaway verify identities via the ops API):
#         FLAIR_OPS_URL  FLAIR_ADMIN_USER  FLAIR_ADMIN_PASS
#     (b) pre-provisioned keys (e.g. the real concierge + a teammate's key):
#         CONCIERGE_AGENT_ID  CONCIERGE_KEYFILE
#         READER_AGENT_ID     READER_KEYFILE
#
#   REQUIRE_DISTILL=1      make the execute-distill assertion (S4b) a hard
#                          failure when the instance has no generative
#                          backend, instead of a loudly-reported SKIP
#   VERIFY_KEEP_ROWS=1     keep the rows the run created (debugging)
#   VERIFY_SETTLE_BUDGET_S indexing settle budget per assertion (default 30)
#
# What it asserts (each negative has an in-script positive control; each
# assertion documents its mutation check inline in verify_impl.py):
#   S1  record_decision row is persistent+shared, carries adk:concierge:<user>,
#       and a DIFFERENT agent identity retrieves it over REST
#   S2  record_personal row is standard+private and the other identity can
#       neither search it nor GET it by id (404)
#   S3  per-user tag scope through the Concierge, both directions
#   S4  scope:"tagged" reflection gathers only that user's rows; a manual
#       execute distill stages MemoryCandidate rows whose scopeTag ==
#       adk:concierge:<user> exactly
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${PYTHON:-python3}"

if ! "$PYTHON" -c "import adk_flair, httpx, cryptography" 2>/dev/null; then
  echo "verify.sh: missing Python deps — install the example first:" >&2
  echo "  pip install -e ." >&2
  exit 2
fi

exec "$PYTHON" "$SCRIPT_DIR/verify_impl.py"
