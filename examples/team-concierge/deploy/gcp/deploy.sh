#!/usr/bin/env bash
# Team Concierge -> Vertex AI Agent Engine (Agent Runtime) deploy.
#
# Wraps `adk deploy agent_engine` (google-adk >= 2.7) around the UNCHANGED
# ../../concierge agent folder. The folder name is load-bearing: it becomes
# the ADK app_name in the image, which keeps the connector's compound tag
# adk:concierge:<user> identical to local runs. Do not point this script at a
# renamed copy.
#
# Required environment:
#   PROJECT_ID        GCP project id
#   FLAIR_URL         Fabric hub origin, e.g. https://<cluster>.<org>.harperfabric.com
# Optional (defaults shown):
#   REGION=us-central1                     Agent Engine region (see RUNBOOK)
#   FLAIR_AGENT_ID=concierge-gcp           Flair identity minted in Cloud Shell
#   FLAIR_KEY_SECRET=concierge-gcp-flair-key   Secret Manager secret id
#   FLAIR_KEY_SECRET_VERSION=latest
#   GEMINI_MODEL=gemini-2.5-flash          becomes ADK_MODEL in the runtime
#   DISPLAY_NAME="Team Concierge"
#   AGENT_ENGINE_ID=                       set to UPDATE an existing instance
#
# No secret material passes through this script. The Ed25519 key reaches the
# runtime as a Secret Manager reference resolved by Agent Engine itself.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/../../concierge" && pwd)"

fail() { echo "deploy.sh: $1" >&2; exit 1; }

: "${PROJECT_ID:?Set PROJECT_ID (gcloud config get-value project shows the active one)}"
: "${FLAIR_URL:?Set FLAIR_URL (e.g. https://<cluster>.<org>.harperfabric.com)}"
REGION="${REGION:-us-central1}"
FLAIR_AGENT_ID="${FLAIR_AGENT_ID:-concierge-gcp}"
FLAIR_KEY_SECRET="${FLAIR_KEY_SECRET:-concierge-gcp-flair-key}"
FLAIR_KEY_SECRET_VERSION="${FLAIR_KEY_SECRET_VERSION:-latest}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"
DISPLAY_NAME="${DISPLAY_NAME:-Team Concierge}"
AGENT_ENGINE_ID="${AGENT_ENGINE_ID:-}"

# ── Preflight: tools ─────────────────────────────────────────────────────────
command -v adk >/dev/null 2>&1 \
  || fail "adk CLI not found. pip install \"google-adk~=2.7\" first (RUNBOOK step 2)."
python3 - <<'PYEOF' || exit 1
import sys
try:
    from google.adk import version
except ImportError:
    sys.exit("deploy.sh: google-adk is not importable from python3.")
from packaging.version import parse
if parse(version.__version__) < parse("2.7"):
    sys.exit(
        "deploy.sh: google-adk %s found, but this deploy path was verified "
        "against >= 2.7 (agent_engine config-file + extra_packages semantics). "
        "pip install -U 'google-adk~=2.7'." % version.__version__
    )
try:
    import vertexai  # noqa: F401
except ImportError:
    sys.exit(
        "deploy.sh: the vertexai SDK is missing. `adk deploy agent_engine` "
        "imports it lazily and google-adk does NOT depend on it. "
        "pip install 'google-cloud-aiplatform[agent_engines,adk]'."
    )
PYEOF

# ── Preflight: agent folder ──────────────────────────────────────────────────
[ -f "$AGENT_DIR/agent.py" ] || fail "agent folder not found at $AGENT_DIR"
[ -f "$AGENT_DIR/requirements.txt" ] \
  || fail "missing $AGENT_DIR/requirements.txt — the image installs agent deps from it; without it adk generates one WITHOUT adk-flair and the container cannot boot."
# A .env in the agent folder would REPLACE the env_vars from the deploy config
# (google-adk cli_deploy.py reads agent-folder .env in preference), and dotenv
# cannot express a Secret Manager reference — so the key delivery would
# silently vanish. Refuse.
[ ! -f "$AGENT_DIR/.env" ] \
  || fail "$AGENT_DIR/.env exists. It would override the deploy config's env_vars (including the Secret Manager key reference). Remove it before deploying."

# ── FLAIR_URL -> flair:// memory URI ─────────────────────────────────────────
# adk-flair's flair:// factory defaults the port to 19926 and uses https for
# any non-localhost host. A Fabric origin serves on 443, so the port must be
# explicit in the URI or the runtime would dial https://<host>:19926.
case "$FLAIR_URL" in
  https://*) : ;;
  http://localhost*|http://127.0.0.1*)
    fail "FLAIR_URL is a localhost address — the Agent Engine runtime cannot reach your machine. Point it at the Fabric hub (https://...)." ;;
  *) fail "FLAIR_URL must be https:// for a remote hub (got: $FLAIR_URL). The flair:// scheme always dials https for non-localhost hosts, so an http:// origin cannot work." ;;
esac
HOSTPORT="${FLAIR_URL#*://}"
HOSTPORT="${HOSTPORT%%/*}"
case "$HOSTPORT" in
  *:*) : ;;
  *) HOSTPORT="$HOSTPORT:443" ;;
esac
MEMORY_URI="flair://$HOSTPORT"

# ── Render the Agent Engine config (env_vars incl. Secret Manager ref) ───────
CONFIG_FILE="$(mktemp -d)/agent_engine_config.json"
export _AE_FLAIR_URL="$FLAIR_URL" _AE_AGENT_ID="$FLAIR_AGENT_ID" \
       _AE_MODEL="$GEMINI_MODEL" _AE_SECRET="$FLAIR_KEY_SECRET" \
       _AE_SECRET_VERSION="$FLAIR_KEY_SECRET_VERSION" _AE_OUT="$CONFIG_FILE"
python3 - <<'PYEOF'
import json, os
config = {
    "env_vars": {
        # Plain values -> deployment_spec.env; the dict value ->
        # deployment_spec.secret_env (SecretRef), resolved by Agent Engine and
        # exposed to the container as the FLAIR_ED25519_KEY env var. See
        # runtime/services.py for the env->keyfile step.
        "FLAIR_URL": os.environ["_AE_FLAIR_URL"],
        "FLAIR_AGENT_ID": os.environ["_AE_AGENT_ID"],
        "FLAIR_ALLOW_REMOTE_URL": "1",  # adk-flair's explicit remote opt-in
        "ADK_MODEL": os.environ["_AE_MODEL"],  # the agent's model knob
        "FLAIR_ED25519_KEY": {
            "secret": os.environ["_AE_SECRET"],
            "version": os.environ["_AE_SECRET_VERSION"],
        },
    }
}
with open(os.environ["_AE_OUT"], "w") as f:
    json.dump(config, f, indent=2)
PYEOF
unset _AE_FLAIR_URL _AE_AGENT_ID _AE_MODEL _AE_SECRET _AE_SECRET_VERSION _AE_OUT

echo "Deploying $AGENT_DIR"
echo "  project=$PROJECT_ID region=$REGION model=$GEMINI_MODEL"
echo "  memory:  $MEMORY_URI (identity: $FLAIR_AGENT_ID, key: Secret Manager/$FLAIR_KEY_SECRET)"
[ -n "$AGENT_ENGINE_ID" ] && echo "  updating existing instance: $AGENT_ENGINE_ID"

# ── Deploy ───────────────────────────────────────────────────────────────────
# --extra_packages stages runtime/services.py at /app/services.py; the ADK api
# server imports it at boot (before memory-service resolution), which writes
# the keyfile and registers the flair:// scheme.
set -- \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --display_name "$DISPLAY_NAME" \
  --description "Team Concierge — ADK agent, memory on self-hosted Flair" \
  --agent_engine_config_file "$CONFIG_FILE" \
  --extra_packages "$SCRIPT_DIR/runtime/services.py" \
  --memory_service_uri "$MEMORY_URI"
[ -n "$AGENT_ENGINE_ID" ] && set -- "$@" --agent_engine_id "$AGENT_ENGINE_ID"

adk deploy agent_engine "$@" "$AGENT_DIR"

echo
echo "Note the reasoningEngines resource name printed above — chat.py and the"
echo "teardown both take it. Verify next: RUNBOOK.md section 6."
