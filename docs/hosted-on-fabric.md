# Hosted on Harper Fabric

Deploy Flair as a component to a [Harper Fabric](https://www.harperdb.io/) instance. You do not run the Harper process yourself: managed hosting, multi-region replication, no shell on the node.

Need a public URL for Cursor / Grok Bot / cloud agents? Start at [quickstart-fabric.md](quickstart-fabric.md).

---

## Deploy

You **deploy** rather than install. `flair deploy` pushes Flair as a Fabric component:

```bash
export FABRIC_USER=<admin> FABRIC_PASSWORD=<pass>

# Validate args and package layout without deploying
flair deploy --fabric-org <org> --fabric-cluster <cluster> --dry-run

# Deploy
flair deploy --fabric-org <org> --fabric-cluster <cluster>
```

Credentials go via the environment, not argv, so they stay out of `ps`. Use `--fabric-password-file <path>` (mode `0600`) when scripting; inline `--fabric-user`/`--fabric-password` flags leak to shell history and are discouraged.

Target defaults to `https://<cluster>.<org>.harperfabric.com`; override with `--target`. Deploy verifies the served API, waits for replication, and polls for convergence before reporting success.

> `--fabric-token` is accepted but **fails** — `deploy_component` is Basic-auth only.

### Provision the instance

Run **once**, before serving traffic:

```bash
flair init --target https://<cluster>.<org>.harperfabric.com \
  --ops-target <ops-url> \
  --cluster-admin-user <user> --cluster-admin-pass <pass> \
  --remote --force
```

- `--force` is required — this writes to a live instance.
- `--remote` marks it a federation **hub** and creates the `flair_pair_initiator` role; without it, pairing later fails role-not-found.
- Generated admin password lands in `~/.tps/secrets/flair-fabric-hdb` (mode `0600`); `--flair-admin-pass` to choose your own.

### Operations endpoint

Portless HTTPS targets derive the ops endpoint at `:9925`. <!-- docs-freshness-allow: Fabric ops API port (FABRIC_OPS_PORT), not legacy data port -->

Set `FLAIR_OPS_TARGET` to override the derived endpoint, including for `flair backup`.

---

## Configuration

On Fabric, configuration goes through the component's environment, not a local `config.yaml`. Set these in the Fabric component env:

| Variable | What it does | When to set it |
|----------|--------------|----------------|
| `FLAIR_PUBLIC_URL` | The URL operators reach this Flair on. Surfaced in OAuth metadata and A2A discovery. | **`flair deploy` sets it** to the deploy target, in the component's `.env`. Set it yourself only to advertise a different host (CDN / proxy / vanity domain) — a value you set is never overwritten. |
| `HDB_ADMIN_PASSWORD` | Bootstrap password for the embedded Harper. | Set at install time. |
| `FLAIR_KEY_PASSPHRASE` | Passphrase for federation key encryption. | Set for production federation deployments. |

On Fabric / managed deploys, Harper's secrets mechanism can provision environment variables (encrypted at rest with `enc:v1:` storage format). `flair mcp enable` uses a staged-file fallback when the push is unavailable or fails.

### How `flair mcp enable` delivers its secrets

`flair mcp enable` provisions five variables for the target's process, including `FLAIR_MCP_OAUTH` and the RS256 signing key. Those two are read from `process.env` only, so `set_configuration` cannot deliver them.

Use `--fabric` for a non-loopback custom-domain Fabric target.

It asks the target what it can do, rather than assuming from the hostname or the version:

| The target… | What happens |
|-------------|--------------|
| returns a usable env-secrets public key | `enable` attempts a sealed push over the ops API. If the push fails, it reports a staged-file fallback. After confirmation, an already active surface can pass without a restart or re-run; restart if this run changed a secret value. If the surface is inactive, restart the Fabric target after a successful push, or apply the staged values and restart, then re-run with `--confirm-secrets-applied`. |
| reports no env-secrets public-key operation | the vars are staged to a `0600` file and you apply them yourself, then re-run with `--confirm-secrets-applied` |
| is unreachable, refuses the probe, or answers unusably | same staged-file fallback, and the output says **which** of those happened |

For an automated push, values are encrypted **before leaving your machine** — AES-256-GCM on the value, RSA-OAEP(SHA-256) wrapping the key, addressed to a public key fetched from the target. Plaintext does not appear in the push request body, and the command's output names variables without showing their values.

At secrets provisioning, `enable` stages the file before any probe or push; dry runs stop earlier. A successful push leaves it unused.

> **What the probe does not promise.** When successful, it returns a public key for a possible push; it does not prove the push succeeds or that the target process loads the values. `enable` checks the target's MCP token endpoint and public metadata before reporting success. Flair also serves OAuth metadata when the MCP flag is off: the target check distinguishes Flair's `/OAuthToken` from the MCP `/oauth/mcp/token`. An already active surface can pass these checks before newly pushed values are loaded; restart if this run changed a secret value.

`--secrets-mechanism <fabric-env-secrets|env-file>` remains an explicit override and skips the probe entirely.

### The `mcp.enabled` operator step (Fabric)

MCP is **off by default**. The shipped component `config.yaml` contains the `@harperfast/oauth` block
uncommented with `mcp.enabled: ${FLAIR_MCP_OAUTH}`, a whole-token environment reference
([flair#1152](https://github.com/tpsdev-ai/flair/issues/1152)), so the on/off choice lives in the
instance's environment and a re-packed deploy cannot revert it. There is no `config.yaml` edit and no
re-deploy to make.

For **`*.harperfabric.com` targets** or non-loopback custom-domain targets selected with `--fabric`, `flair mcp enable` does not restart the instance. It provisions the secrets, then checks the MCP
surface in this order:

1. **Target/issuer binding.** The target's *own* metadata at
   `<instance-url>/.well-known/oauth-authorization-server` must name the verified issuer and advertise
   the MCP token endpoint `/oauth/mcp/token`. A mismatch refuses the run.
2. **Public-origin self-verify.** Metadata at the same path is fetched from the public issuer. The check
   requires a matching issuer, a string `token_endpoint` other than Flair's `/OAuthToken`, and advertised
   CIMD support. It does not require the public token endpoint to equal `/oauth/mcp/token`. `flair mcp status`
   uses this check.

Then one of:

- **Self-verify passes.** The run prints the paste block. If this run changed a secret value, restart the
  instance so its process picks the new value up.
- **It answers but does not pass** (HTTP 404, flair's own authorization server, or CIMD not advertised).
  The step fails, reports the metadata problem, and gives generic apply-or-restart advice. Re-run
  `flair mcp enable` with the same options plus `--confirm-secrets-applied`.
- **The request fails** (DNS, connection, TLS, timeout). The step fails and says the public issuer could
  not be reached, quoting the URL and the error. It gives no activation instruction; it asks you to check
  that the host resolves, that this machine can reach it over HTTPS, and that the instance is running in
  Fabric — then re-run with `--confirm-secrets-applied`.

After applying the secrets and restarting, re-run with `--confirm-secrets-applied`. The run passes only if
the target's issuer and MCP token endpoint match, and the public metadata and CIMD checks pass.

---

## Agent authentication

Agents authenticate with **Ed25519 per-agent keys** — the same model as standalone local. Each agent holds a private key and signs every request.

### Register an agent

```bash
# Register an agent — --ops-target is required (see Port derivation trap above)
flair agent add mybot --target "$FLAIR_URL" --ops-target <ops-url>
```

The private key is stored on the **client machine** at `~/.flair/keys/<agent>.key`, not on the Fabric node. The Fabric node stores only the public key in the `Agent` table.

### Connect a client

```bash
export FLAIR_URL=https://<cluster>.<org>.harperfabric.com

# Register an agent
flair agent add mybot --target "$FLAIR_URL" --ops-target <ops-url>

# Use with any MCP client — set FLAIR_AGENT_ID and FLAIR_URL in the client env
```

Auth is the same protocol as standalone: Ed25519 signature of `agentId:timestamp:nonce:METHOD:/path`, 30-second replay window, nonce deduplication. The difference is purely the transport — HTTPS instead of localhost HTTP.

An adapter that just got a 404 is almost never "Harper wants a different verb." Check the three identity pieces (keyfile, agent id, `Agent` row on **this** instance) and treat by-id 404 as fail-closed ownership, not an existence signal: [integrations.md — Hosted Flair auth](integrations.md#hosted-flair-auth--your-agent-got-a-404).

See [secrets-and-keys.md](secrets-and-keys.md) for the full threat model.

---

## Verify it works

### Health and status

```bash
curl -sf https://<cluster>.<org>.harperfabric.com/Health

flair status --target https://<cluster>.<org>.harperfabric.com
flair fleet verify --target https://<cluster>.<org>.harperfabric.com
```

`fleet verify` checks health, auth, and version across the origin node plus every Flair federation peer on file. Exit codes: 0 = all probed nodes verified (unverifiable peers warn, do not fail), 1 = origin failed, 2 = reachable peer diverged, 3 = reachable peer unreachable/auth-failed.

> **A credential mismatch renders as an empty section.** `flair status` reads `/HealthDetail` with `FLAIR_ADMIN_PASS` / `HDB_ADMIN_PASSWORD` / a pinned agent key — **not** the `FABRIC_*` credentials. On failure it renders blank.

### What is available remotely

| Command | Works remotely |
|---|---|
| `GET /Health` | Yes — public, no auth |
| `flair status --target <url>` | Yes — subsystem rollups |
| `flair quality --target <url>` | Yes — recall/coverage metrics |
| `flair fleet verify --target <url>` | Yes — origin + Flair peers |
| `flair federation status\|verify\|reachability --target <url>` | Yes — peer table, sync recency |

### What does **not** work remotely

**`flair doctor`** takes no `--target` — it hardcodes localhost, reads a local PID file, and shells out to `lsof`. Unavailable too: `start`, `stop`, `restart`, `snapshot`, `reembed`, `rem`, `bridge`.

**Fabric's own cluster topology is invisible.** `fleet verify` sweeps *Flair's* federation peer table, not Harper's cluster nodes. **`cluster_status` works on Fabric** — Fabric always runs harper-pro (not the OSS harper build), so cluster_status is available over the ops API. `0 peers known` means "0 on file", never "0 exist."

---

## Upgrade

A Fabric-deployed Flair is a component, not an npm package. Upgrade in place:

```bash
FABRIC_USER=<admin> FABRIC_PASSWORD=<pass> \
  flair upgrade --target https://<cluster>.<org>.harperfabric.com
```

This resolves the target version, stages a clean deployable with the required `@harperfast/harper` version pin, confirms the staged build before deploying, pushes it via `flair deploy`, and verifies the result. After a successful deploy, it runs a fleet convergence sweep across the origin plus every Flair federation peer.

- `--check` shows the version diff and plan without deploying.
- `--yes` skips the confirmation prompt for scripted use.
- `--fabric-password-file <path>` reads the password from a file instead of an env var.
- `--no-fleet-verify` skips the post-deploy fleet sweep.

Inline `--fabric-user`/`--fabric-password` flags also work but are **discouraged** — both leak to shell history and `ps`.

### Backup before upgrading

`flair snapshot` is local-only. Back up before every upgrade:

```bash
flair backup --url https://<cluster>.<org>.harperfabric.com \
  --admin-pass-file <path> --output ./flair-backup.json
```

See [upgrade.md](upgrade.md#upgrading-a-fabric-deployed-instance) for the full walkthrough.

---

## Federation

Available. Pair a local spoke to a Fabric-hosted hub:

```bash
# On any machine (no shell on the hub) — generate a pairing token triple. /path/to/hub-admin-pass is a 0600 file holding the HUB admin password; --admin-pass-file reads it in-process, never as a literal on the command line
(umask 077; set -C; flair federation token --admin-pass-file /path/to/hub-admin-pass \
  --target https://<cluster>.<org>.harperfabric.com \
  --ops-target <ops-url> > ./pair-triple.json)

# On the spoke — the SPOKE admin password (its own ~/.flair/admin-pass) writes the local Peer row
flair federation pair https://<cluster>.<org>.harperfabric.com \
  --admin-pass-file ~/.flair/admin-pass \
  --token-from ./pair-triple.json
```

`set -C` refuses an existing `./pair-triple.json`; remove an old one first (`rm ./pair-triple.json`).

### Pairing limitation

The scheduled sync driver (`flair federation sync enable`) writes a launchd job or systemd timer **on the machine running the CLI** — it cannot be installed on a Fabric node. A periodic one-shot from the spoke machine is the workaround.

Full walkthrough: [federation.md](federation.md).

### Multi-region replication

Fabric gives you N regional nodes running one component — **not** N Flair instances. Every node shares one Flair identity (the `Instance` table replicates). You do **not** federate your own regions to each other — Harper replication handles that. Use `flair federation pair` only to reach a **separate** Flair instance.

---

## Known operational limitations

### No disk or quota telemetry

`flair status` reports usage for two directories: no free space, no total, no quota. An instance can hit its quota with nothing saying so. The one indirect signal is a migration halting for space.

### npm cache is ephemeral per deploy

`flair deploy` / `flair upgrade --target` run the node's `npm install` against a temporary cache and delete it afterwards, so hub quota no longer grows with every install ([flair#886](https://github.com/tpsdev-ai/flair/issues/886)).

---

## See also

- [deployment-shapes.md](deployment-shapes.md) — choose your shape
- [upgrade.md](upgrade.md#upgrading-a-fabric-deployed-instance) — full Fabric upgrade walkthrough
- [federation.md](federation.md) — pairing, sync driver, conflict resolution
- [standalone-local.md](standalone-local.md) — the standalone shape (different upgrade, shell available)
- [secrets-and-keys.md](secrets-and-keys.md) — admin password, key lifecycle
