# Hosted on Harper Fabric

Deploy Flair as a component to a [Harper Fabric](https://www.harperdb.io/) instance. You do not run the Harper process yourself: managed hosting, multi-region replication, no shell on the node.

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

### Port derivation trap

Locally, Flair serves data on `19926` and the ops API on `19925`. The CLI derives **ops = data − 1** everywhere. A managed endpoint is HTTPS on 443 with no port, so derivation produces `:442` — where nothing answers.

**Pass `--ops-target <url>` explicitly** (or set `FLAIR_OPS_TARGET`) on any command that touches the ops API: `init --target`, `agent add --target`, `federation token --target`.

---

## Configuration

On Fabric, configuration goes through the component's environment, not a local `config.yaml`. Set these in the Fabric component env:

| Variable | What it does | When to set it |
|----------|--------------|----------------|
| `FLAIR_PUBLIC_URL` | The URL operators reach this Flair on. Surfaced in OAuth metadata and A2A discovery. | **`flair deploy` sets it** to the deploy target, in the component's `.env`. Set it yourself only to advertise a different host (CDN / proxy / vanity domain) — a value you set is never overwritten. |
| `HDB_ADMIN_PASSWORD` | Bootstrap password for the embedded Harper. | Set at install time. |
| `FLAIR_KEY_PASSPHRASE` | Passphrase for federation key encryption. | Set for production federation deployments. |

On Fabric / managed deploys, environment variables are provisioned through Harper's Fabric secrets mechanism (encrypted at rest with `enc:v1:` storage format).

### How `flair mcp enable` delivers its secrets

`flair mcp enable` needs five variables live in the target's process before it restarts — including `FLAIR_MCP_OAUTH` and the RS256 signing key, both read from `process.env` only and therefore impossible to deliver via `set_configuration`.

It asks the target what it can do, rather than assuming from the hostname or the version:

| The target… | What happens |
|-------------|--------------|
| supports Harper's env-secrets operations | the five vars are **sealed locally** and pushed over the ops API. No manual step, no re-run. |
| does not have them (Harper older than 5.2) | the vars are staged to a `0600` file and you apply them yourself, then re-run with `--confirm-secrets-applied` |
| is unreachable, refuses the probe, or answers unusably | same staged-file fallback, and the output says **which** of those happened |

Values are encrypted **before leaving your machine** — AES-256-GCM on the value, RSA-OAEP(SHA-256) wrapping the key, addressed to a public key fetched from the target. Plaintext never appears in a request body, and the command's output carries variable *names* only.

The staging file is written in every case, so a fallback never strands you mid-run. When the push succeeds it simply goes unused.

> **What the probe does not promise.** It establishes that the target accepts secrets, not that it will *decrypt* them — no read-only call can, since a secret only proves it was decrypted by being present in the process. The **self-verify** step at the end is what proves that. Note the endpoint does *not* go quiet when the flag is off — flair serves its own OAuth 2.1 discovery document instead, and self-verify tells them apart by the advertised `token_endpoint` (`/OAuthToken` is flair's own; the MCP one is `/oauth/mcp/token`). So a secret that is stored and never decrypted fails at self-verify with a message naming `FLAIR_MCP_OAUTH`, rather than reporting success.

`--secrets-mechanism <fabric-env-secrets|env-file>` remains an explicit override and skips the probe entirely.

### The `mcp.enabled` operator step (Fabric)

MCP is **off by default**. The shipped component `config.yaml` contains
`@harperfast/oauth` → `mcp` → `enabled: false`. Until [flair#1152](https://github.com/tpsdev-ai/flair/issues/1152)
lands (interpolate from env — *ON HOLD*), you must flip this manually:

1. In your deployed component's `config.yaml`, change:
   ```yaml
   '@harperfast/oauth':
     mcp:
       enabled: true     # was: false
   ```
2. Re-deploy the component so Harper picks up the new value.
3. **Verify the `/mcp` surface is actually serving** (the flag alone does not
   guarantee it — a secret that is stored but never decrypted fails at self-verify):
   ```bash
   # Check /mcp is reachable and returning MCP protocol (not a loopback proxy or 404)
   curl -sf https://<cluster>.<org>.harperfabric.com/mcp
   # Should return MCP JSON-RPC content; if you get HTML redirect or 404 the flag
   # is not effective
   ```

**⚠ SECURITY CAVEAT — the upgrade-reverts trap.** Any package update or fleet component
update re-ships the literal `enabled: false` and silently darkens a live `/mcp` surface.
You must **re-flip to `true` after every upgrade** and re-deploy. An updated component
without this re-flip will appear healthy (`/Health` green) while its MCP tools are
dark to every connected client. If you rely on MCP, add the re-flip to your upgrade
runbook.

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

See [secrets-and-keys.md](secrets-and-keys.md) for the full threat model.

---

## Verify it works

### Health and status

```bash
curl -sf https://<cluster>.<org>.harperfabric.com/Health

flair status --target https://<cluster>.<org>.harperfabric.com
flair fleet verify --target https://<cluster>.<org>.harperfabric.com
```

`fleet verify` checks health, auth, and version across the origin node plus every Flair federation peer on file. Exit codes: 0 = all verified, 1 = origin failed, 2 = peer version skew, 3 = peer unverifiable.

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
# On any machine (no shell on the hub) — generate a pairing token triple
FLAIR_ADMIN_PASS=<hub-admin-password> flair federation token \
  --target https://<cluster>.<org>.harperfabric.com \
  --ops-target <ops-url> > ./pair-triple.json

# On the spoke — pair to the Fabric hub
flair federation pair https://<cluster>.<org>.harperfabric.com \
  --token-from ./pair-triple.json
```

### Pairing limitation

The scheduled sync driver (`flair federation sync enable`) writes a launchd job or systemd timer **on the machine running the CLI** — it cannot be installed on a Fabric node. A periodic one-shot from the spoke machine is the workaround.

Full walkthrough: [federation.md](federation.md).

### Multi-region replication

Fabric gives you N regional nodes running one component — **not** N Flair instances. Every node shares one Flair identity (the `Instance` table replicates). You do **not** federate your own regions to each other — Harper replication handles that. Use `flair federation pair` only to reach a **separate** Flair instance.

---

## Known operational limitations

### No disk or quota telemetry

`flair status` reports usage for two directories: no free space, no total, no quota. An instance can hit its quota with nothing saying so. The one indirect signal is a migration halting for space.

### Unbounded npm cache

Every deploy runs a server-side `npm install` using the node's default cache. npm never evicts it, so it grows until it fills the quota. There is no cache flag, alternate location, or cleanup option. [flair#886](https://github.com/tpsdev-ai/flair/issues/886).

---

## See also

- [deployment-shapes.md](deployment-shapes.md) — choose your shape
- [upgrade.md](upgrade.md#upgrading-a-fabric-deployed-instance) — full Fabric upgrade walkthrough
- [federation.md](federation.md) — pairing, sync driver, conflict resolution
- [standalone-local.md](standalone-local.md) — the standalone shape (different upgrade, shell available)
- [secrets-and-keys.md](secrets-and-keys.md) — admin password, key lifecycle
