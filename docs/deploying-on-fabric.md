# Deploying on Harper Fabric

Run Flair as a component on [Harper Fabric](https://www.harperdb.io/) — the managed,
multi-region Harper surface — instead of as a local process you own.

This is the hosted counterpart to [deployment.md](deployment.md). That guide covers the
standalone shape: `npm install -g @tpsdev-ai/flair`, `flair init`, a Harper process on
your own machine with launchd or systemd keeping it alive. Fabric is a different
mechanism end to end — you do not install Flair, you *deploy* it, and you never get a
shell on the node. Almost everything downstream of that follows from those two facts.

---

## When Fabric is the right shape

| | Standalone local | Harper Fabric | Embedded in an app |
|---|---|---|---|
| You run | `flair init` | `flair deploy` | Harper's `register()` in your own component |
| Process ownership | Yours | Harper's | Your app's |
| Shell on the node | Yes | **No** | Yes |
| Multi-region / failover | No | Yes | No |
| Upgrade | `flair upgrade` | `flair upgrade --target <url>` | Your app's release |

Pick Fabric when you want an always-on hub that survives your laptop closing, in more
than one region, without operating a Harper yourself. That is a real benefit and it is
the reason most people end up here.

**Be honest about the trade.** Losing the shell is not a detail — it is the defining
constraint of this shape, and it costs you more than it first appears:

- Several `flair` commands are local-only by construction. Anything that reads
  `~/.flair`, or drives `launchctl` / `systemctl`, cannot act on a Fabric node.
- Some things you would expect to be able to see, you cannot — see
  [Operating it](#operating-it). Disk quota is the sharp edge.
- Deploys are slower and have more failure modes than a local restart, because a
  deploy replicates a component across a cluster asynchronously.

If you only need one always-on instance and you already have a VPS, the "Remote Server"
shape in the [README](../README.md#remote-server) is simpler and keeps your shell.

---

## Getting an instance up

Read [deployment.md](deployment.md) first for what Flair *is*; this section covers only
what differs.

There is no `flair init` step against an empty Fabric cluster in the local sense. The
component is pushed from a machine that has the `@tpsdev-ai/flair` package, and Harper
installs it server-side on every node.

### Deploy

```bash
FABRIC_USER=<admin> FABRIC_PASSWORD=<pass> \
  flair deploy --fabric-org <org> --fabric-cluster <cluster>
```

`--fabric-org` and `--fabric-cluster` (or `FABRIC_ORG` / `FABRIC_CLUSTER`) build the
target as `https://<cluster>.<org>.harperfabric.com`. Override the whole URL with
`--target <url>` if your cluster does not follow that template.

**Credentials.** `FABRIC_USER` + `FABRIC_PASSWORD` in the environment is the safest
form, and the CLI passes them to Harper's child process via the environment rather than
argv so they do not appear in `ps`. `--fabric-password-file <path>` (mode `0600`) is the
equivalent for scripted use. Inline `--fabric-user` / `--fabric-password` work but leak
to shell history and `ps` — avoid them on any shared host.

> **`--fabric-token` does not work yet.** The flag is accepted and documented as
> "reserved for future Fabric bearer support", but a token-only deploy fails with an
> explicit error: Harper's `deploy_component` CLI path only accepts Basic auth today.
> Use `--fabric-user` + a password.

### What deploy does that a local install does not

- **Long timeouts by default.** Harper's own deploy CLI defaults to a 120-second
  peer-replication timeout, which is too short for Fabric and aborts mid-replicate.
  Flair overrides both the deployment and install timeouts to 600s
  (`--deployment-timeout`, `--install-timeout`).
- **Verifies the served API, on by default.** Harper can print "Successfully deployed"
  for a component that is not actually serving anything. After deploying, the CLI polls
  until the API settles and then checks that the deployed resources return non-404.
  `--no-verify` opts out; `--verify-resource <name>` (repeatable) overrides what is
  checked.
- **Treats a replication error as a snapshot, not a verdict.** Harper replicates
  asynchronously, so a peer-replication error at the moment the CLI looks is not proof
  of failure. The CLI polls for convergence before reporting one
  (`--no-convergence-check` to disable, `--convergence-timeout <ms>` to tune).
- **Runs a fleet convergence sweep afterwards** — see
  [upgrade.md](upgrade.md#post-deploy-fleet-verify), and read the caveat in
  [Operating it](#what-you-cannot-observe) before trusting a green result.

### Provisioning the instance

Once the component is serving, provision Flair's admin user and roles against it:

```bash
flair init --target https://<cluster>.<org>.harperfabric.com \
  --ops-target <ops-url> \
  --cluster-admin-user <user> --cluster-admin-pass <pass> \
  --remote --force
```

- `--force` is **required** with `--target` — remote init writes to a live instance.
- `--remote` marks this instance as a federation **hub** and provisions the
  `flair_pair_initiator` role, which the pairing handshake needs in order to pass
  platform auth before reaching the resource handler. Skip it and pairing fails with a
  role-not-found error.
- `--cluster-admin-user` / `--cluster-admin-pass` (or `FLAIR_CLUSTER_ADMIN_USER` /
  `FLAIR_CLUSTER_ADMIN_PASS`) drive the automated provisioning path.
- The generated Flair admin password is written to `~/.tps/secrets/flair-fabric-hdb`
  with mode `0600` on the machine you ran the command from. Treat that file the way you
  treat `~/.flair/admin-pass` — see [secrets-and-keys.md](secrets-and-keys.md).
- Pass `--flair-admin-pass` (or `FLAIR_ADMIN_PASS`) to choose the password yourself
  instead of having one generated.

Why `--ops-target` is spelled out here rather than left to derivation is the subject of
the next section, and it is the single most likely thing to break your first attempt.

### Upgrading

Do **not** use the local upgrade path. See
[upgrade.md — Upgrading a Fabric-deployed instance](upgrade.md#upgrading-a-fabric-deployed-instance).

---

## Connecting to it

### Ports: the derivation trap

A local Flair serves the data API on `19926` and the Harper operations API on `19925`
(older installs use `9926` / `9925` — see the legacy-default gotcha in
[spoke-bringup.md](spoke-bringup.md#8-known-gotchas)). The rule everywhere in the CLI is
**ops port = data port − 1**.

A managed Fabric instance is reached over **HTTPS on 443** with no port in the URL. That
breaks the derivation, and it breaks it silently:

> Given a `--target` with **no explicit port** and an `https` scheme, the CLI derives the
> ops URL as **port 442** (443 − 1). Nothing on Fabric is expected to answer there.

So on a managed Fabric URL, any command that needs the ops API will aim at `:442` unless
you tell it otherwise. **Pass `--ops-target <url>` explicitly** (or set
`FLAIR_OPS_TARGET`) — it bypasses port derivation entirely. The commands where this
bites are the ones that seed or provision through the ops API: `flair init --target …`
and `flair agent add --target …`.

If your Fabric endpoint *does* carry an explicit port — e.g.
`https://<fabric-node>:19926/<instance>` — derivation works correctly and gives
`:19925`, which is the shape shown in
[spoke-bringup.md](spoke-bringup.md#8-known-gotchas) and
[federation.md](federation.md#fabric-pairing-example).

> **Gap — needs verification by someone with a Fabric account.** This document does not
> state what the correct ops-API URL is for a managed `*.harperfabric.com` instance, or
> whether the Harper operations API is exposed to remote callers there at all. The
> derivation behaviour above is read from the CLI source and is certain; the right value
> to pass to `--ops-target` on managed Fabric is not, and guessing it in a deployment
> guide would cost someone a broken instance.

### Targets

Precedence for the data API, highest first:

```
--target <url>  >  --url <url>  >  FLAIR_TARGET  >  FLAIR_URL  >  http://127.0.0.1:<local port>
```

For the ops API: `--ops-target` > `FLAIR_OPS_TARGET` > derived from the target > local.

### Auth

`authorizeLocal` is Harper's localhost bypass: with it on, a credential-less loopback
request is auto-authorized as `super_user`. Flair ships **`authorizeLocal: false`**, so
even a loopback request needs a real credential.

For a Fabric operator the practical consequences are:

- **`authorizeLocal` never mattered for you.** It only ever governed loopback, and you
  are always a remote caller. Remote requests have always required real credentials —
  flipping it changes nothing about a hosted instance.
- **Admin operations use HTTP Basic auth** against the Flair admin user you provisioned
  above. Agent operations use Ed25519 signatures as normal — see [auth.md](auth.md).
- **`/Health` is genuinely public** and works for remote callers. It was not always:
  it used to return 401 from outside the localhost bypass, which made health-checking a
  hosted instance impossible. That is fixed.
- **Do not debug with raw `curl` against the platform-gated endpoints.** On Fabric the
  auth gate fires before the resource handler, so a hand-rolled request that omits the
  headers the platform expects returns 401 in a way that looks like a Flair bug and is
  not. Use the CLI. See
  [federation.md](federation.md#local-federationinstance-fetch-needs-auth).

### From a client

Point the SDK or MCP server at the HTTPS URL, no port:

```bash
export FLAIR_URL=https://<cluster>.<org>.harperfabric.com
```

Set **`FLAIR_PUBLIC_URL`** in the deployed component's environment to that same URL.
It is what OAuth metadata and A2A discovery advertise, so external clients see a
reachable address rather than a loopback one. [deployment.md](deployment.md#environment-variables)
lists it as "always set on remote / Fabric deployments" — that is not boilerplate.

---

## The hub shape

The most common reason to run Flair on Fabric: an always-on hub that local spokes pair
to. This works and is validated across standalone, Fabric single-node, and Fabric
multi-node topologies.

Pairing follows
[federation.md](federation.md#pairing-a-new-spoke-bootstrap-user-flow), with one
adjustment: **you have no shell on the hub.** The worked example there generates the
token triple over `ssh` to the hub host, which is not available on managed Fabric.
`flair federation token` accepts `--target`, so mint the triple remotely instead:

```bash
# 1. Mint the pairing triple against the hosted hub (no ssh required)
FLAIR_ADMIN_PASS=<hub-admin-password> \
  flair federation token \
    --target https://<cluster>.<org>.harperfabric.com \
    --ops-target <ops-url> > ./pair-triple.json

# 2. On the spoke, pair against the same URL
flair federation pair https://<cluster>.<org>.harperfabric.com \
  --token-from ./pair-triple.json
```

`flair federation token` reaches the ops API, so the
[derivation trap](#ports-the-derivation-trap) applies — pass `--ops-target` rather than
letting it derive `:442`. It takes `--admin-pass` but **not** `--admin-pass-file`; prefer
`FLAIR_ADMIN_PASS` in the environment over an inline flag that lands in shell history.

The triple contains a one-time bootstrap credential — treat the file accordingly and
delete it once pairing succeeds. Tokens expire after 60 minutes by default (`--ttl`).

The bootstrap-user handshake exists specifically because the older design broke on
Fabric: the platform auth gate fires before the resource handler sees the request, so a
body-only authentication scheme never gets a chance to run.

### Federation is push-only

**A spoke pushes up. It cannot pull down.** `POST /FederationSync` is push-only and
one-directional per call, and there is **no pull endpoint anywhere in the codebase**.
`flair federation pair <hub-url>` always declares the *caller* as the spoke and records
the target as its hub.

To move data both ways you need **two independent pairings**, each side pairing as a
spoke of the other, with two separate tokens and two separate `flair federation sync`
invocations. There is no single setting that makes sync bidirectional.

The tables that sync are `Memory`, `Soul`, `Agent`, and `Relationship`. **Presence is
not federated** — it is a local heartbeat table, so a hosted hub will not show you a
roster of agents across your spokes.

### Keeping a spoke synced — the driver is local-only

`flair federation sync` is one-shot and `flair federation watch` only lives as long as
its terminal, so a spoke synced by hand looks paired and quietly stops replicating.
[federation.md](federation.md#keeping-it-synced) covers the scheduled driver
(`flair federation sync enable`) in full.

The Fabric-specific point that guide does not make:

> **You cannot install a sync driver on a Fabric node.** `flair federation sync enable`
> writes a launchd job or a systemd user timer **on the machine running the CLI**. There
> is no remote-install path. `--target <url>` does not change that — it configures the
> *local* periodic job to read from that remote instance and push onward.

So the shape is: the driver runs on a machine you control; Fabric is the hub it pushes
to. Relatedly, `flair federation status` deliberately omits its "is anything driving
sync?" verdict when `--target` points at a remote instance — `launchctl` and `systemctl`
only know about the host the CLI is on, and claiming "no driver" about a machine it
cannot see would be a confident lie.

It is a **periodic one-shot, not a supervised watcher** — deliberately. The sync holds
no state between runs, so a resident process buys nothing, and a supervisor cannot
restart something that hangs instead of exiting. The trade-off is latency; `--interval`
is the knob (default 300s, floor 60s, ceiling 86400s).

---

## Operating it

### What you can observe

Only these surfaces accept `--target` and therefore work without a shell:

| Command | What it gives you |
|---|---|
| `GET /Health` | Liveness. Public, no auth. |
| `flair status --target <url>` (and `status deep`) | Per-subsystem rollups, including the only byte counts available remotely |
| `flair quality --target <url>` | Recall/coverage metrics; also surfaces halted-migration reasons |
| `flair fleet verify --target <url>` | Health, auth, and version across the origin and every Flair federation peer on file |
| `flair federation status \| verify \| reachability --target <url>` | Peer table, sync recency, per-peer probes |

`flair fleet verify` exit codes distinguish origin failure (1), version skew among
peers (2), and a peer that could not be verified at all (3). It needs
`FABRIC_USER`/`FABRIC_PASSWORD`.

Harper Studio remains the general-purpose window into a hosted instance and the fallback
for anything the CLI cannot reach.

> **A credential mismatch looks like an empty section, not an error.** `flair status`
> fetches `/HealthDetail` using `FLAIR_ADMIN_PASS` / `HDB_ADMIN_PASSWORD`, a pinned agent
> key, `~/.flair/admin-pass`, or the Ed25519 floor. It does **not** accept the
> `FABRIC_*` credentials that `deploy`, `upgrade --target` and `fleet verify` use. If the
> fetch fails, the CLI leaves the health data null and every dependent block simply
> renders empty. A blank Disk section means "could not authenticate" at least as often
> as it means "nothing to report."

### What you cannot observe

This is the part that costs people real incidents.

**`flair doctor` cannot be pointed at a hosted instance at all.** It takes no `--target`
and no `--url` — it hardcodes localhost, reads the PID file off the local data
directory, and shells out to `lsof`. The command most people reach for when something is
wrong is unavailable in this shape. The same is true of `start`, `stop`, `restart`,
`snapshot`, `reembed`, and the whole `rem` and `bridge` families.

**Fabric's own cluster topology is invisible to this CLI.** `flair fleet verify` checks
*Flair's* federation peer table, not Harper's cluster-replication nodes. Harper's
`cluster_status` operation — the one that would answer "what nodes are in this cluster
and are they in sync?" — is harper-pro-only and not available in the OSS `harper` build
the CLI ships. A Fabric replica that was never separately paired as a Flair federation
peer is simply absent from the sweep. **`0 peers known` means "0 peers on file", never
"0 peers exist."** A green sweep is not a statement about your cluster.

**There is no disk-space or quota telemetry.** What `flair status` reports is a *usage*
figure for two directories — the data directory and the snapshots directory — and
nothing else:

- No free space, no total space, no filesystem quota, and **no warning threshold**. No
  surface anywhere raises "disk nearly full."
- The directory walk is capped at six levels deep, so deep trees are undercounted with
  no flag saying so.
- The components directory is not reported as such, and there is no per-component size
  anywhere.
- Harper's `system_information` operation, which would report host disk state, is never
  called by Flair.

The practical consequence: **an instance can approach and hit its disk quota with no
Flair surface saying anything.** The one indirect signal is that a migration blocked for
lack of space surfaces its halt reason through `flair status` / `flair quality` — but
only if a migration happens to be pending.

Two distinct things can fill that disk, and they are worth separating because the
remedies differ:

1. **Data-side growth**, which `flair status` does at least count. Stored-version churn
   is the one to watch — each rewrite of a memory regenerates its vector blob, so a
   pathological sync loop can multiply on-disk size far beyond the logical record count
   while the record count itself looks normal. Compare `dataBytes` against the number of
   live records, not against your expectations.
2. **Component-side growth**, which nothing counts at all — see the next section.

> **Note on `get_components`.** This repo asserts in a source comment that Harper's
> `get_components` operation excludes `node_modules` server-side. That claim is uncited
> and unverified here — no test asserts it and Harper's source is not vendored — so this
> guide does not rely on it. It also would not change the outcome: Flair calls
> `get_components` only as a convergence oracle during a deploy that hit a replication
> error, and it discards the `size` field after comparing file trees. Component disk
> usage is invisible structurally, not because of any exclusion.

### Known hazard: unbounded npm cache on the node

**Open defect — [flair#886](https://github.com/tpsdev-ai/flair/issues/886).**

Every deploy runs Harper's server-side `npm install` into the component directory on
each node, using the node's default npm cache. npm never evicts that cache, so it grows
without bound across deploys until it consumes the instance's disk quota.

There is **no in-product mitigation today**. The CLI passes no cache flag, sets no
alternate cache location, and performs no post-install cleanup. Two changes have reduced
the *rate* without bounding the total: the default deploy retry count is now 0 (so one
install per deploy instead of up to three), and the platform-specific llama.cpp binary
is now an optional peer dependency, so each cached generation is smaller.

Worth knowing if you are tempted to fix it yourself: Harper consults a component's
`install_command` only when `node_modules` is **absent** — it returns early on a
redeploy over an existing tree — and `deploy_component` exposes no clean or
force-reinstall option. The obvious fix is not as available as it looks.

**Workaround, not a solution:** clear the npm cache on the node
(`npm cache clean --force`) or raise the quota to buy time. Both require access the
Fabric shape does not generally give you, which is precisely why the issue is open.
Track flair#886 rather than building on either.

### Rolling back

There is no local snapshot to restore, and `flair snapshot` is one of the local-only
commands. `flair upgrade --target` stages and verifies before deploying, and `--check`
shows the version diff and plan without deploying anything — use it.

Back up before every upgrade. Note that `flair backup` takes **`--url`**, not
`--target`:

```bash
flair backup --url https://<cluster>.<org>.harperfabric.com \
  --admin-pass-file <path> --output ./flair-backup.json
```

---

## See also

- [deployment.md](deployment.md) — the standalone local shape
- [upgrade.md](upgrade.md#upgrading-a-fabric-deployed-instance) — Fabric upgrade path and fleet verify
- [federation.md](federation.md) — pairing, sync driver, conflict resolution
- [spoke-bringup.md](spoke-bringup.md) — bringing up a spoke that pairs to a hub
- [auth.md](auth.md) — auth across surfaces
- [secrets-and-keys.md](secrets-and-keys.md) — credential precedence and rotation
