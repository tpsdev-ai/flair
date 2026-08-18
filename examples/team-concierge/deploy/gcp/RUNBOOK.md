# Team Concierge on Vertex AI Agent Engine — operator runbook

Ten minutes from a GCP project to the [Team Concierge](../../README.md)
running on **Vertex AI Agent Engine** (Google's managed ADK runtime — the
current docs call it *Agent Runtime* on the *Gemini Enterprise Agent
Platform*; the API resource is still `reasoningEngines`), with **Gemini** as
the model and **memory on your self-hosted Flair Fabric hub** via
[adk-flair](https://pypi.org/project/adk-flair/) ≥ 0.44.13.

The shape, in one paragraph: `deploy.sh` wraps `adk deploy agent_engine`
around the unchanged [`../../concierge`](../../concierge) agent folder.
Agent Engine builds a container that runs ADK's API server with
`--memory_service_uri=flair://<your-hub>:443`; a boot shim
([`runtime/services.py`](runtime/services.py), staged via
`--extra_packages`) registers the `flair://` scheme and turns the Ed25519
key — delivered by Agent Engine from **Secret Manager** as an env var — into
the keyfile adk-flair reads. The key is **minted in Cloud Shell** against
your hub and never transits a laptop.

Everything here is environment-and-file based: no credential ever appears
inline in a command, and nothing in this runbook prints key material.

## 1. Prerequisites (~2 min)

- A GCP project with **billing enabled**, and permissions to enable APIs,
  create secrets, and deploy Vertex AI resources (Owner on a scratch project
  is the simple case).
- A reachable **Flair Fabric hub** and its **admin password** — the
  [Fabric quickstart](../../../../docs/quickstart-fabric.md) gets you from
  zero to `https://<cluster>.<org>.harperfabric.com`.
- Everything below runs in **Cloud Shell** (which is the point: the identity
  key is born in the cloud environment). `gcloud` is already authenticated
  there.

```bash
export PROJECT_ID=<your-project-id>
export FLAIR_URL=https://<cluster>.<org>.harperfabric.com
gcloud config set project "$PROJECT_ID"
gcloud services enable aiplatform.googleapis.com \
  secretmanager.googleapis.com cloudresourcemanager.googleapis.com
```

## 2. Cloud Shell tooling (~2 min)

```bash
# The flair CLI needs Node 22+ (Cloud Shell ships nvm if the default is older):
node --version || nvm install 22
npm i -g @tpsdev-ai/flair

# The deploy CLI and the SDK it drives. google-adk does NOT depend on the
# vertexai SDK — `adk deploy agent_engine` imports it lazily and fails
# without it, so install both:
pip install --user "google-adk~=2.7" "google-cloud-aiplatform[agent_engines,adk]"

# This repo, for the example + deploy package:
git clone https://github.com/tpsdev-ai/flair.git
cd flair/examples/team-concierge/deploy/gcp
```

## 3. Mint the concierge's identity — in Cloud Shell (~1 min)

The agent gets **its own** Flair identity (`concierge-gcp`), never a shared
or admin key. Minting here means the private key exists only in this Cloud
Shell session and, after step 4, in Secret Manager.

```bash
# Admin password into an owner-only file — typed at a hidden prompt, so it
# never lands in shell history or `ps`:
umask 077 && mkdir -p ~/.flair
IFS= read -rs -p "Fabric admin password: " _p && printf '%s\n' "$_p" > ~/.flair/fabric-admin-pass && unset _p; echo

# Register the identity against the hub. Fabric's ops API is port 9925 on
# the SAME hostname (not the local "data port - 1" default):
flair agent add concierge-gcp \
  --target "$FLAIR_URL" \
  --ops-target "$FLAIR_URL:9925" \
  --admin-pass-file ~/.flair/fabric-admin-pass
```

Expected: `Keypair written: ~/.flair/keys/concierge-gcp.key` and a
registration confirmation. The hub stores only the public key.

## 4. Key → Secret Manager (~1 min)

The keyfile is single-line base64 (PKCS8 Ed25519), so it survives
env-var transport verbatim. Store the file, never echo it:

```bash
gcloud secrets create concierge-gcp-flair-key \
  --data-file="$HOME/.flair/keys/concierge-gcp.key"

# Agent Engine resolves secret references as its service agent; grant it
# accessor on this one secret (not project-wide):
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
gcloud secrets add-iam-policy-binding concierge-gcp-flair-key \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-aiplatform.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

If the binding fails because the service agent does not exist yet (fresh
project), create it and retry:

```bash
gcloud beta services identity create --service=aiplatform.googleapis.com --project="$PROJECT_ID"
```

## 5. Deploy (~3 min)

```bash
PROJECT_ID="$PROJECT_ID" FLAIR_URL="$FLAIR_URL" ./deploy.sh
```

Defaults (override via env): `REGION=us-central1`,
`FLAIR_AGENT_ID=concierge-gcp`, `FLAIR_KEY_SECRET=concierge-gcp-flair-key`,
`GEMINI_MODEL=gemini-2.5-flash` (delivered to the agent as `ADK_MODEL` — the
model knob the concierge already reads; any current Gemini id works, see
[model + region constraints](#model--region-constraints)).

The script renders the Agent Engine config (`env_vars` including the
Secret Manager reference), derives the `flair://<host>:443` memory URI from
`FLAIR_URL`, and runs `adk deploy agent_engine`. **Note the
`projects/.../locations/.../reasoningEngines/<id>` resource name it prints**
— the verify step and teardown both take it.

To update an existing instance instead of creating a new one:
`AGENT_ENGINE_ID=<id> ./deploy.sh`.

## 6. Verify — the demo is the test (~2 min)

Record a decision through the deployed agent, then prove it landed on the
hub **readable by a different identity** — that crossing of the identity
wall is the product claim.

```bash
export RESOURCE=projects/<p>/locations/<r>/reasoningEngines/<id>   # from step 5

# 6a. Chat: record a team decision (use your real handle as --user; it
#     becomes the adk:concierge:<user> scope on the hub):
python3 chat.py --resource "$RESOURCE" --user <your-handle> \
  "We decided to adopt the fastify adapter because it halves p99."
```

Expected: the concierge confirms it recorded a team decision
(persistent + shared).

```bash
# 6b. Cross-identity read: mint a second, throwaway identity and search as it.
flair agent add verify-reader \
  --target "$FLAIR_URL" --ops-target "$FLAIR_URL:9925" \
  --admin-pass-file ~/.flair/fabric-admin-pass

flair memory search "fastify adapter" --agent verify-reader --target "$FLAIR_URL"
```

Expected: the decision row comes back — `visibility: "shared"`, content
matching what you told the concierge — returned to an identity that did not
write it. The hub stamps attribution server-side: the row belongs to
`concierge-gcp` (the agent identity), scoped by the `adk:concierge:<user>`
tag you chatted under.

```bash
# 6c. Shared org context in bootstrap:
flair bootstrap --agent verify-reader --target "$FLAIR_URL"
```

Expected: the cold-start context includes the shared decision — this is what
every teammate's agent sees on boot without anyone re-typing anything.

Once verified, the Cloud Shell copy of the concierge key is redundant
(Secret Manager holds it now):

```bash
rm -f ~/.flair/keys/concierge-gcp.key
```

## Honest failure modes

**401s from the hub (identity not registered).** If step 3 was skipped, ran
against a different hub than `FLAIR_URL`, or the secret holds a stale key
(e.g. re-minted after upload), every memory op gets 401. Symptoms: chat
works but recording fails; the instance's Cloud Logging shows adk-flair
request errors. Fix: re-run step 3 against the right hub (`flair agent add`
refuses an existing id — remove it first or pick a new id + secret), push
the current keyfile as a **new secret version**
(`gcloud secrets versions add concierge-gcp-flair-key --data-file=...`), and
redeploy with `AGENT_ENGINE_ID=<id>` so the runtime picks it up.

**Container fails at boot — key path.** `runtime/services.py` raises
`RuntimeError: Neither FLAIR_KEYFILE nor FLAIR_ED25519_KEY is set` (visible
in Cloud Logging) when the secret reference didn't reach the runtime:
the secret id in the config doesn't exist, the service agent lacks
`secretmanager.secretAccessor` (step 4), or a stray `.env` file in the agent
folder replaced the deploy config's `env_vars` (deploy.sh refuses to deploy
in that case — don't bypass it). A malformed key fails one line later, in
FlairMemoryService's constructor, naming `FLAIR_KEYFILE`.

**`FLAIR_URL ... is not a localhost address`.** adk-flair requires the
explicit remote opt-in `FLAIR_ALLOW_REMOTE_URL=1`; deploy.sh always sets it.
Seeing this error means the deploy config's env didn't land — same causes as
above.

**Region.** Agent Engine is region-restricted; `us-central1` is the
documented default in the ADK deploy docs, and the supported list is on the
[locations page](https://docs.cloud.google.com/agent-builder/locations#supported-regions-agent-engine).
The Gemini model must also be available in the region you pick. Symptom of a
mismatch: create/deploy fails immediately, or the first query errors with a
model-availability message.

**Hub latency.** adk-flair uses tight sub-2s HTTP timeouts with no retry —
pick the GCP region nearest your Fabric hub, or memory ops will
intermittently time out while chat still responds.

## Model + region constraints

- **Model**: variable, not hardcoded — `GEMINI_MODEL` → runtime `ADK_MODEL`.
  Default `gemini-2.5-flash` (GA on Vertex AI, and the example's own local
  default, so cloud and laptop behave identically). Newer Gemini lines (e.g.
  Gemini 3 Flash) work by overriding the variable — check
  [Vertex AI model docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models)
  for current ids and regional availability. The runtime authenticates to
  Gemini via the project's Vertex AI path (the generated image sets
  `GOOGLE_GENAI_USE_ENTERPRISE=1` + project/region) — **no API key is
  deployed anywhere in this package**.
- **Region**: `REGION` variable, default `us-central1` (the canonical region
  in the [ADK Agent Engine deploy docs](https://adk.dev/deploy/agent-runtime/deploy/)).
  Supported list: [Agent Engine locations](https://docs.cloud.google.com/agent-builder/locations#supported-regions-agent-engine).

## Teardown — dogfood must be cleanly removable

Order: runtime first (stop the writer), then key material, then identity.

```bash
# 1. Delete the Agent Engine instance (child resources included):
python3 - <<'PYEOF'
import os, vertexai
name = os.environ["RESOURCE"]
segments = name.split("/")
client = vertexai.Client(project=segments[1], location=segments[3])
client.agent_engines.delete(name=name, force=True)
print("deleted:", name)
PYEOF

# 2. Delete the secret (all versions):
gcloud secrets delete concierge-gcp-flair-key

# 3. Revoke the identity on the hub. `flair agent remove` only speaks to a
#    LOCAL instance today (it dials 127.0.0.1's ops port), so against Fabric
#    delete the Agent row via the ops API — this revokes the public key, so
#    the identity can never authenticate again. curl prompts for the admin
#    password (kept out of argv and history):
curl -u admin "$FLAIR_URL:9925/" \
  -H "Content-Type: application/json" \
  -d '{"operation":"delete","database":"flair","table":"Agent","ids":["concierge-gcp"]}'
# Same call with "verify-reader" for the throwaway reader identity.

# 4. Cloud Shell remnants:
rm -f ~/.flair/keys/concierge-gcp.key ~/.flair/keys/concierge-gcp.key.pub \
      ~/.flair/keys/verify-reader.key ~/.flair/keys/verify-reader.key.pub \
      ~/.flair/fabric-admin-pass
```

Deliberately **not** deleted: memories the concierge recorded. Team
decisions are shared org knowledge — revoking the writer's key does not (and
should not) claw back what the team already knows. If you want a full purge,
delete the Memory rows for `agentId=concierge-gcp` through the same ops API
(mirror what `flair agent remove` does locally: `search_by_value` on
`agentId`, then `delete` by ids).
