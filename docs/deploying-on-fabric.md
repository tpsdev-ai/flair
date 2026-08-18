# Deploying on Harper Fabric

Run Flair as a component on [Harper Fabric](https://www.harperdb.io/) — managed, hosted,
multi-region — instead of a local process you own. The hosted counterpart to
[deployment.md](deployment.md); two things define it: you *deploy* rather than install,
and **you get no shell on the node.**

## When to use it

| | Standalone local | Harper Fabric |
|---|---|---|
| You run | `flair init` | `flair deploy` |
| Shell on the node | yes | **no** |
| Multi-region / failover | no | yes |
| Upgrade | `flair upgrade` | `flair upgrade --target <url>` |

Choose Fabric for an always-on hub in more than one region. For a single instance on a VPS
you already have, [Remote Server](../README.md#remote-server) is simpler and keeps your shell.

---

## Quickstart

New user who just needs a reachable `FLAIR_URL` for Cursor / Grok Bot? Start at
[quickstart-fabric.md](quickstart-fabric.md). This page is the operator path.

### 1. Deploy the component

```bash
export FABRIC_USER=<admin> FABRIC_PASSWORD=<pass>

# Validate args and package layout without deploying
flair deploy --fabric-org <org> --fabric-cluster <cluster> --dry-run

flair deploy --fabric-org <org> --fabric-cluster <cluster>
```

Target defaults to `https://<cluster>.<org>.harperfabric.com`; override with `--target`.

Credentials go via the environment, not argv, so they stay out of `ps`. Use
`--fabric-password-file <path>` (mode `0600`) when scripting; inline flags leak to history.

Deploy verifies the served API (Harper reports success for a component serving
nothing; `--no-verify` opts out), waits 600s for replication (Harper's 120s default
aborts mid-replicate on Fabric), and polls for convergence before reporting one.

> `--fabric-token` is accepted but **fails** — `deploy_component` is Basic-auth only.

### 2. Provision

```bash
flair init --target https://<cluster>.<org>.harperfabric.com \
  --ops-target <ops-url> \
  --cluster-admin-user <user> --cluster-admin-pass <pass> \
  --remote --force
```

- `--force` is required — this writes to a live instance.
- `--remote` marks it a federation **hub** and creates the `flair_pair_initiator` role;
  without it, pairing later fails role-not-found.
- Generated admin password lands in `~/.tps/secrets/flair-fabric-hdb` (mode `0600`);
  `--flair-admin-pass` to choose your own.

Run **once**, before serving multi-region traffic — see
[Multi-region](#multi-region-replication-vs-federation).

### 3. Verify

```bash
curl -sf https://<cluster>.<org>.harperfabric.com/Health
flair fleet verify --target https://<cluster>.<org>.harperfabric.com
flair status --target https://<cluster>.<org>.harperfabric.com
```

### 4. Connect a client

```bash
export FLAIR_URL=https://<cluster>.<org>.harperfabric.com

# Register an agent — --ops-target is required, see Ports below
flair agent add mybot --target "$FLAIR_URL" --ops-target <ops-url>
```

### `FLAIR_PUBLIC_URL` — set for you, and how to override it

OAuth metadata and A2A discovery advertise `FLAIR_PUBLIC_URL`; with it unset, every
URL a client is handed points at loopback and no remote client can authorize.

`flair deploy` ships it. The deploy already knows the URL — it is the target it
verifies the served API against immediately afterwards — so it writes
`FLAIR_PUBLIC_URL=<target>` into a `.env` in the component payload, and then checks
`GET <target>/OAuthMetadata` really does advertise a non-loopback issuer. That check
fails the deploy if it does not.

To advertise something other than the deploy target — a CDN, a reverse proxy, a
vanity domain — put your own `.env` in the package root:

```
FLAIR_PUBLIC_URL=https://flair.example.com
```

A value you set is never overwritten; the deploy prints the disagreement and keeps
yours. Any other keys in that file are carried through untouched.

Three things worth knowing about that file:

- Harper reads a component's `.env` **only** because flair's `config.yaml` declares
  its `loadEnv` plugin, above `jsResource`. Without that declaration the file is
  present and inert.
- A variable already set in the instance's **process environment** outranks the
  file. Harper's `loadEnv` skips any key already present in `process.env` (and logs
  an "Environment variable conflict" warning) unless `override` is declared, which
  flair does not declare. So a value you set through Fabric's own environment
  mechanism is what the instance uses, and a deploy cannot replace it.
- The deploy payload is stored in Harper's deployment record and replicated to every
  node, so anything in `.env` is persisted cluster-wide. flair puts no credential
  there. `HDB_ADMIN_PASSWORD` in particular cannot work from a component `.env` at
  all — Harper composes its own configuration before component env files load.

---

## Ports: the derivation trap

Locally, Flair serves data on `19926` and the ops API on `19925`. The CLI derives
**ops = data − 1** everywhere.

A managed endpoint is HTTPS on 443 with no port, so derivation produces **`:442`** —
where nothing answers:

```bash
# --target https://<cluster>.<org>.harperfabric.com   → ops derived as :442  ✗
# --target https://<fabric-node>:19926/<instance>     → ops derived as :19925 ✓
```

**Fabric's ops API runs on the same hostname at port 9925** <!-- docs-freshness-allow: Fabric ops API port, not legacy data port --> (the deploy/upgrade path already targets this port). For a managed `*.harperfabric.com` instance:

```bash
# Same hostname, port 9925 — not port 442 <!-- docs-freshness-allow: Fabric ops API -->
flair init --target https://<cluster>.<org>.harperfabric.com \
    --ops-target https://<cluster>.<org>.harperfabric.com:9925 <!-- docs-freshness-allow: Fabric ops API -->
```

**Pass `--ops-target <url>` explicitly** (or set `FLAIR_OPS_TARGET`) on any command that
touches the ops API: `init --target`, `agent add --target`, `federation token --target`.

Precedence: `--target` > `--url` > `FLAIR_TARGET` > `FLAIR_URL` > localhost. For ops:
`--ops-target` > `FLAIR_OPS_TARGET` > derived > localhost.

## Auth

Flair ships `authorizeLocal: false` — it only governs loopback, so it changes nothing
here; remote callers always need real credentials.

- Admin ops use Basic auth; agents use Ed25519 ([auth.md](auth.md)).
- `/Health` is public — your liveness check.
- Don't debug with raw `curl` — on Fabric the auth gate fires before the resource
  handler, so a hand-rolled request 401s in a way that looks like a Flair bug and isn't.

---

## Pairing a spoke to a hosted hub

No shell on the hub, so mint the token remotely rather than over `ssh`:

```bash
# On any machine — note --ops-target, this hits the ops API
FLAIR_ADMIN_PASS=<hub-admin-password> flair federation token \
  --target https://<cluster>.<org>.harperfabric.com \
  --ops-target <ops-url> > ./pair-triple.json

# On the spoke
flair federation pair https://<cluster>.<org>.harperfabric.com \
  --token-from ./pair-triple.json
```

`federation token` takes `--admin-pass`, **not** `--admin-pass-file`. The triple holds a
one-time credential — delete it after pairing (60-min TTL, `--ttl`).

### Federation is push-only

**A spoke pushes up. It cannot pull down.** `POST /FederationSync` is one-directional per
call and there is no pull endpoint anywhere.

For both directions, each side pairs **as a spoke of the other**: two pairings, two
tokens, two syncs. No setting makes sync bidirectional.

Syncs `Memory`, `Soul`, `Agent`, `Relationship`. **`Presence` is not federated** — no
cross-spoke roster.

### Keeping a spoke synced

`flair federation sync` is one-shot; `watch` dies with its terminal. Use the scheduled
driver ([federation.md](federation.md#keeping-it-synced)):

```bash
flair federation sync enable --interval 300
flair federation sync status
```

> **The driver is local-only.** It writes a launchd job or systemd timer **on the machine
> running the CLI**; `--target` just points that local job at a remote instance. You
> cannot install a driver on a Fabric node.

A periodic one-shot, not a supervised watcher; `--interval` is the latency knob.
`flair federation status` omits its driver verdict for a remote `--target`.

---

## Multi-region: replication vs federation

Fabric gives you N regional nodes running one component — **not** N Flair instances.
Instance identity lives in the `Instance` table (`schemas/federation.graphql`); it is a
Harper table, so **it replicates** — every node shares one Flair identity.

| Layer | Handles | Scope |
|---|---|---|
| Harper replication | your app across its own regions | intra-app, automatic |
| Flair federation | this app ↔ another Flair instance | instance-to-instance, you pair it |

**You do not federate your own regions to each other** — Harper already did. Use
`flair federation pair` only to reach a *separate* Flair instance.

One asymmetry: identity replicates, but `flair-instance.yaml` (port config, per data
directory) does not. A node reporting a different **port** is expected; a different
**instance id** is not.

Provision once, from one place, before serving multi-region traffic: step 2's
`flair init … --remote` seeds the identity row so it exists before any node needs it.

---

## Operating it

### What works remotely

| Command | Gives you |
|---|---|
| `GET /Health` | liveness, no auth |
| `flair status --target <url>` | subsystem rollups; the only byte counts available remotely |
| `flair quality --target <url>` | recall/coverage; halted-migration reasons |
| `flair fleet verify --target <url>` | health, auth, version across origin + Flair peers |
| `flair federation status\|verify\|reachability --target <url>` | peer table, sync recency, probes |

`fleet verify` exit codes: 1 origin failed, 2 peer version skew, 3 peer unverifiable.

> **A credential mismatch renders as an empty section, not an error.** `flair status`
> reads `/HealthDetail` with `FLAIR_ADMIN_PASS` / `HDB_ADMIN_PASSWORD` / a pinned agent
> key — **not** the `FABRIC_*` credentials `deploy` and `fleet verify` use. On failure it
> renders blank — a blank Disk section means "couldn't authenticate" as often as
> "nothing to report".

### What doesn't

**`flair doctor` takes no `--target`** — it hardcodes localhost, reads a local PID file
and shells out to `lsof`. The command you'd reach for when something breaks is unavailable
here. Unavailable too: `start`, `stop`, `restart`, `snapshot`, `reembed`, `rem`, `bridge`.

**Fabric's own cluster topology is invisible.** `fleet verify` sweeps *Flair's* federation
peer table, not Harper's cluster nodes. **`cluster_status` works on Fabric** — Fabric
always runs harper-pro (not the OSS harper build), so cluster_status is available over
the ops API. `0 peers known` means "0 on file", never "0 exist."

**There is no disk or quota telemetry.** `flair status` reports usage for two directories:
no free space, no total, no quota, no warning threshold, walk capped at six levels, no
per-component size. `system_information` is never called — an instance can hit its quota
with nothing saying so. The one indirect signal is a migration halting for space.

> **On `get_components`.** A source comment claims Harper excludes `node_modules`
> server-side. That is uncited and unverified, so this guide doesn't rely on it — and it
> wouldn't matter: Flair calls it only as a post-failure convergence oracle and discards
> the `size` field. Component disk usage is invisible structurally.

### The `mcp.enabled` operator step

MCP is **off by default**. The shipped component `config.yaml` contains
`@harperfast/oauth` → `mcp` → `enabled: false`. Until [flair#1152](https://github.com/tpsdev-ai/flair/issues/1152)
lands (interpolate from env — *ON HOLD*), you must flip this manually:

1. In your deployed component's `config.yaml`, change:
    ```yaml
    '@harperfast/oauth':
     mcp:
       enabled: true      # was: false
    ```
2. Re-deploy the component so Harper picks up the new value.
3. **Verify the `/mcp` surface is actually serving** (the flag alone does not
   guarantee it — a secret that is stored but never decrypted fails at self-verify):
    ```bash
    # Check /mcp is reachable and returning MCP protocol (not a loopback proxy or 404)
    curl -sf https://\<cluster\>.\<org\>.harperfabric.com/mcp
    # Should return MCP JSON-RPC content; if you get HTML redirect or 404 the flag
    # is not effective
    ```

**⚠ SECURITY CAVEAT — the upgrade-reverts trap.** Any package update or fleet component
update re-ships the literal `enabled: false` and silently darkens a live `/mcp` surface.
You must **re-flip to `true` after every upgrade** and re-deploy. An updated component
without this re-flip will appear healthy (`/Health` green) while its MCP tools are
dark to every connected client. If you rely on MCP, add the re-flip to your upgrade
runbook.

### Known hazard: unbounded npm cache

**Open — [flair#886](https://github.com/tpsdev-ai/flair/issues/886).** Every deploy runs a
server-side `npm install` using the node's default cache. npm never evicts it, so it
grows until it fills the quota.

No in-product mitigation: no cache flag, no alternate location, no cleanup. One install
per deploy bounds the *rate*, not the total. Harper consults `install_command` only when
`node_modules` is absent and `deploy_component` has no force-reinstall option, so the
obvious fix isn't available — and clearing the cache needs node access this shape
doesn't give you.

### Backup and rollback

`flair snapshot` is local-only. Back up before every upgrade — `flair backup` takes
**`--url`**, not `--target`:

```bash
flair backup --url https://<cluster>.<org>.harperfabric.com \
  --admin-pass-file <path> --output ./flair-backup.json

# --check shows the version diff and plan without deploying
flair upgrade --target https://<cluster>.<org>.harperfabric.com --check
```

Full path: [upgrade.md](upgrade.md#upgrading-a-fabric-deployed-instance).

---

## See also

- [deployment.md](deployment.md) — the standalone local shape
- [upgrade.md](upgrade.md#upgrading-a-fabric-deployed-instance) — Fabric upgrades, fleet verify
- [federation.md](federation.md) — pairing, sync driver, conflict resolution
- [spoke-bringup.md](spoke-bringup.md) · [auth.md](auth.md) · [secrets-and-keys.md](secrets-and-keys.md)
