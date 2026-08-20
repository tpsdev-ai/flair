# Team Concierge — an ADK agent that commits team knowledge to Flair

A front-office agent for a team: talk to it about ideas, decisions, PR
context, constraints. It writes the durable knowledge into your Flair
instance, where **every other agent on the team retrieves it through their own
Flair paths** — Claude Code over MCP, OpenClaw, the CLI — with no transcript
copy-paste. Built on [Google ADK](https://google.github.io/adk-docs/) with
[adk-flair](../../packages/adk-flair) as the memory backend.

## The identity and visibility model, stated plainly

**One app identity, per-user tag scope for writes; teammates read with their
own identities.** The Concierge is one ADK app (`concierge`) → one Flair agent
identity (its own Ed25519 key, provisioned like any team agent). Users are
scoped by the connector's compound tag `adk:concierge:<user>`. Nothing reads
"as the concierge" except the concierge.

Every write-site sets `visibility` **explicitly** — no write relies on the
server's durability-keyed default:

| content class | durability | visibility | who can read |
|---|---|---|---|
| Team decisions, constraints, spec/PR context (`record_decision`) | `persistent` | `shared` (explicit) | whole org — the point of the tool |
| Personal user context/preferences (`record_personal`) | `standard` | `private` (explicit) | concierge identity only, tag-scoped per user |
| Session episodes (raw turns, written by the after-agent callback) | `standard` | `private` (explicit) | distillation pipeline only |

The write surface is **shape-enforced**: the model can only call
`record_decision` / `record_personal`, whose durability+visibility are fixed
inside the helpers — never parameters. The per-user tag derives from the
authenticated ADK session's `user_id`, never from model output. The agent's
tool list is the allowlist: memory ops only (two write helpers + read-only
`load_memory`/`preload_memory`) — no soul writes, no workspace writes, no org
events, no raw memory writes with caller-chosen flags. Server-side gates
(attribution stamping, durability/visibility validation, the private-row read
scope) remain the real boundary; the allowlist narrows the LLM surface on top.

### The limitation, honestly

> The compound tag `adk:concierge:<user>` is an application-level filter, not
> an authz wall. There is no cryptographic isolation between users of the same
> app, and **any holder of the Concierge's key can read every user's
> "private" rows** — private means owner-only, and the single concierge
> identity is the owner of all of them. A bug in the agent (wrong tag on a
> write, missing tag on a search) could expose one user's context to another.
> This is acceptable for a single-trust-domain internal team tool because the
> application code is under team control. For true per-user cryptographic
> isolation, use per-user agent identities — out of scope for this example
> (see "Not this example" below).

## 5-minute quickstart

Prerequisites: a running Flair instance (`npm i -g @tpsdev-ai/flair && flair
init` gives you one at `http://localhost:19926`), Python ≥ 3.10.

```bash
cd examples/team-concierge

# 1. Install (pulls adk-flair and google-adk from PyPI):
pip install -e .

# 2. Provision the concierge's own agent identity (never a shared/admin key):
flair agent add concierge          # writes ~/.flair/keys/concierge.key

# 3. Environment (no secrets inline — the keyfile stays a file):
export FLAIR_URL=http://localhost:19926
export FLAIR_AGENT_ID=concierge
export FLAIR_KEYFILE=~/.flair/keys/concierge.key
export GOOGLE_API_KEY=...          # or GEMINI_API_KEY; model override: ADK_MODEL

# 4. Chat:
scripts/run_chat.sh                # adk web (dev UI); or: scripts/run_chat.sh run
```

Tell it *"we decided to adopt the fastify adapter because it halves p99"* —
then, from any other agent identity on the instance, search for "fastify
adapter" and find the decision. That crossing of the identity wall is the
demo.

Note on `adk web`: the agent lives in the `concierge/` package directory
(ADK discovers agents by importing the directory name, and `team-concierge`
is not a valid Python module name). The `flair://` scheme is registered by
`services.py` in this directory — not `services.yaml`, because ADK's generic
YAML factory constructs services as `cls(uri=...)`, which
`FlairMemoryService` (taking `url=`) rejects at boot; `adk_flair.register()`
is the supported registration channel.

## Verify — the demo IS the test

`scripts/verify.sh` executes the scenario's claims against a live instance:
the shared lane crosses the identity wall (a second identity's REST search
finds the decision, persistent+shared, tagged `adk:concierge:<user>`); the
private lane holds (search absence with an indexed-row positive control,
by-id GET denied); per-user tag scope holds in both directions; and
scope-tagged distillation gathers only that user's rows and (with a
generative backend configured) stages `MemoryCandidate` rows whose `scopeTag`
is exactly `adk:concierge:<user>`. Each assertion documents its mutation
check inline — e.g. flip `_PERSONAL_CLASS["visibility"]` to `"shared"` in
`concierge/agent.py` and the private-wall assertions fail.

```bash
# Throwaway identities, auto-provisioned via the ops API:
FLAIR_URL=http://localhost:19926 \
FLAIR_OPS_URL=http://localhost:19925 \
FLAIR_ADMIN_USER=admin FLAIR_ADMIN_PASS=... \
scripts/verify.sh

# Or with pre-provisioned keys (e.g. the real concierge + a teammate's identity):
FLAIR_URL=... CONCIERGE_AGENT_ID=concierge CONCIERGE_KEYFILE=~/.flair/keys/concierge.key \
READER_AGENT_ID=alice READER_KEYFILE=~/.flair/keys/alice.key \
scripts/verify.sh
```

The distillation-execute assertion needs the instance to have a generative
backend (Harper `models:` block — see [docs/rem.md](../../docs/rem.md)).
Without one it reports a loud SKIP (never a silent pass); set
`REQUIRE_DISTILL=1` to make it a hard failure.

Contributors: to run against a throwaway instance instead of your own, boot
the repo's ephemeral Harper (`node packages/adk-flair/tests/helpers/boot-harper.mjs`
from the repo root after `npm run build`) — it prints a JSON line with
`httpURL`/`opsURL`/admin credentials to feed the variables above, and tears
down when its stdin closes.

## Session distillation

Raw session episodes land `standard`+`private` under the user's tag, which
makes them distillation input: a nightly REM run with `scope:"tagged"` per
`adk:concierge:<user>` stages `MemoryCandidate` rows for review. Two
operational rules:

- **The runner must execute as the concierge identity** (or admin). Episodes
  are private to the concierge key — a runner under any other identity reads
  zero episodes and distillation silently produces nothing.
- **Auto-promote starts OFF.** Review candidates through the reviewer flow
  first; enable `AutoPromoteCandidates` only after candidate quality has been
  observed on real sessions.

Success signal: a fact told to the Concierge on day N surfaces in its own
bootstrap on day N+1 without anyone re-typing it.

## Running against Fabric / a remote instance

Point the same environment at a hosted instance — see
[docs/quickstart-fabric.md](../../docs/quickstart-fabric.md) for provisioning
an agent identity against Fabric (`flair agent add concierge --target ...
--ops-target ... --admin-pass ...`). Environment stays the same shape:
`FLAIR_URL` + the concierge keyfile, plus the connector's explicit remote
opt-in `FLAIR_ALLOW_REMOTE_URL=1`. Never inline credentials in commands or
config — keys stay in files, admin passwords in your secret store.

To run the Concierge **managed on GCP** — Vertex AI Agent Engine with Gemini,
memory on your Fabric hub, the identity key minted in Cloud Shell and
delivered via Secret Manager — follow the 10-minute
[deploy/gcp/RUNBOOK.md](deploy/gcp/RUNBOOK.md).

## Not this example

- Not a multi-tenant showcase: per-user **MCP** identities (each teammate's
  agent reading with their own key) demonstrate real isolation; this example
  deliberately uses one app identity and says so above.
- No Discord/chat-platform integration; the Concierge is a terminal/web
  surface.
