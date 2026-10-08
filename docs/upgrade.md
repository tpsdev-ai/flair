# Upgrade Guide

This page covers the mechanics of upgrading Flair — the general path, valid across
versions. For **what changed in a specific release** (behavior changes, new surfaces,
breaking changes), see [`CHANGELOG.md`](https://github.com/tpsdev-ai/flair/blob/main/CHANGELOG.md) — each version has its own
`## [X.Y.Z]` section. Check the CHANGELOG entries between your current version and the
target version before upgrading anything you depend on in production.

There are two things you might be upgrading:

1. **A local install** — the common case: `flair` on your own machine or a VPS,
   either via `npm install -g @tpsdev-ai/flair` or a plain extracted tree
   (`npm pack` + `npm install --omit=dev` under systemd).
2. **A Flair component deployed to a Harper Fabric cluster** — a different mechanism
   (`flair deploy` / `flair upgrade --target`), covered separately below.

## Standard upgrade (local install)

```bash
# 1. Back up first, always
#    --admin-pass-file keeps the secret out of ps and shell history.
#    --output is required — the archive goes to a file, not stdout.
flair backup \
  --output ~/flair-backup-$(date +%Y%m%d).json \
  --admin-pass-file ~/.flair/admin-pass

# 2. Check what's outdated (doesn't install anything)
flair upgrade --check

# 3. Upgrade — installs, then restarts and verifies that the new version is
#    serving (--no-restart skips both, --no-verify skips the verification).
#    A failure does not always roll back: when a new flair package was
#    installed and the pre-install /Health check was refused, a failed restart
#    keeps the new package and exits successfully, printing the start error
#    and `flair start`. See "Restart, verification and rollback" below
flair upgrade

# 4. Verify
flair status
flair doctor
```

After a restart, `flair status` shows the BM25 index building in the
background (`building 312/817 docs (38%) · started 4s ago`) and then
`ready · 817 docs · built in 1.2s · 3m ago`. A text search issued while it
is building waits for that build. `disabled — <reason>` means the index is
not serving; the reason says why (after a failure, search is on the
per-query scan). With `FLAIR_BM25_INDEX=false` or vector-only retrieval the
index is not built at all. With `THREADS_COUNT` greater than 1 the line
names the worker it describes.

`flair upgrade` checks and upgrades the npm-global packages (`@tpsdev-ai/flair`,
`@tpsdev-ai/flair-mcp`) and, if present, the `openclaw-flair` plugin (via
`openclaw plugins install --force --pin`, not `npm install -g` — it needs OpenClaw's
own plugin loader). It also refreshes every `@tpsdev-ai/flair-mcp@<version>` pin
it previously wrote — MCP server entries **and** SessionStart hook commands —
for each already-wired client (`~/.claude.json`, `~/.claude/settings.json`,
`~/.codex/config.toml`, `~/.codex/hooks.json`, and the other auto-wired clients).
Pass `--all` to also see `flair-client` (normally hidden as a
transitive dependency). **Other integrations upgrade in their own ecosystem, not via
`flair upgrade`:** `pi-flair` (pi's plugin manager), `langgraph-flair` (an npm module), `hermes-flair`
(reinstall the plugin from a flair checkout: `hermes plugins install path:<flair>/packages/hermes-flair`), `n8n-nodes-flair` (n8n's Community Nodes UI).

If the running instance's exec path is a **plain extracted tree** (npm pack +
`npm install --omit=dev`, typically under systemd — no git checkout, not the
npm-global prefix), `flair upgrade` takes that lane: it fetches the published
tarball, swaps the tree in place, keeps operator launchers that are not in the
pack, and restarts the systemd unit that points at the tree (or `flair restart`
when no unit is found). Pass `--tree <dir>` to select the tree explicitly;
`--flair-version <semver>` pins the tarball.

A leftover npm-global relic next to a tree that is **not** a packed install
still gets the mismatch warning: the listing is the npm-global surface and the
warning names both paths so the relic is not reported as "the" install. Git
checkouts and source trees are never tarball-swapped.

### Plain-tree / npm-pack install

Spokes that extract the published tarball and run `npm install --omit=dev`
under a systemd unit — no git checkout, no `npm install -g` — use the same
command. `flair upgrade` detects the serving tree (or takes `--tree <dir>`)
and:

1. Fetches `@tpsdev-ai/flair@<version>` with `npm pack`
2. Extracts it next to the live tree and runs `npm install --omit=dev`
3. Copies operator files at the tree root that are **not** in the published
   pack (a `flair` wrapper, `.env`, anything else you added)
4. Renames the live tree to `<tree>.upgrade-prev` and the staging dir into
   place
5. Restarts the systemd unit whose `WorkingDirectory` / `ExecStart` names the
   tree (`FLAIR_SYSTEMD_UNIT=flair.service` adds an explicit unit). If no unit
   is found, it falls back to `flair restart`
6. Verifies, then removes `.upgrade-prev` on success. A thrown restart error
   keeps a swapped Flair package when the prior `/Health` connection was
   refused (`keep`, successful exit). With a swap and a running or indeterminate
   prior probe, a nonempty previous version selects rollback. No swap, or no
   previous version after a running or indeterminate probe, selects `no-target`
   (failure). Verification keeps an `ok` or `healthy-unverified` result;
   other results select rollback with a
   nonempty previous version, or `cannot-rollback` without one. A reported
   deprecation blocks rollback, and a missing saved tree skips tree restoration.
   See [Restart, verification and rollback](#restart-verification-and-rollback).

```bash
flair upgrade --check --tree /opt/flair
flair upgrade --tree /opt/flair
flair upgrade --tree /opt/flair --flair-version 0.50.0
```

`--check` prints the plan (versions, preserved names, which unit will restart)
without touching the tree. A git checkout or a path that *is* the npm-global
install is refused rather than overwritten.

### A symlinked data directory is refused at boot

The migration probe refuses a symlinked data directory or `.migrations` child.
When no candidate is usable, the boot log and `/HealthDetail` report the failure;
`flair doctor` does so with a verified agent and a reachable instance. Full paths
appear in the operator log, admin `/HealthDetail` responses and admin `flair doctor` output.

> **Heads-up:** for a link to a directory, only after verifying that the target is
> dedicated to this Flair instance and safe to relocate, stop Flair, remove the
> link, move its target to the configured path and start Flair. If ownership is
> uncertain, leave the target in place: for a linked **data directory**, set
> `FLAIR_MIGRATION_DATA_DIR` to the real directory path instead of the link and
> restart; for a linked `.migrations` child, configure a different data directory
> with an unlinked `.migrations` child. For a dangling link or a link to a file,
> replace the link with a writable directory.

### After a Node bump: the CLI and the instance in different install trees

A service unit bakes the node binary and install tree of the runtime it was
written under. After a Node version bump, `flair` on your PATH can come from the
new runtime's global tree while the instance keeps serving the old one.
`flair status`, `flair upgrade`, `flair doctor` and `flair restart` name this —
both trees, both versions, the unit — but only when it is **proven**: the
service manager must own the process that answered — the one process listening
on the instance's port, which must also be the PID the instance reported about
itself when it reported one. Two listeners, none, or a PID file that names
another process make the answer unknown; only when the port's listeners cannot
be read at all (`lsof` missing or failing) does a reported PID stand on its own.
On Linux, the unit is found from that process — its cgroup (`/proc/<pid>/cgroup`,
cgroup v2) names the systemd user unit it runs in — and systemd must report that
process as the unit's MainPID and the unit's file in `~/.config/systemd/user` as
its `FragmentPath`. Because the unit comes from the process, not from a tree path
in a unit file, it is still found after `flair init` re-pointed the file: the
state is then diverged with `flair restart` as the remedy. Otherwise the serving
tree is reported as unknown and nothing is advised from it.

The remedy is `flair init && flair restart`. `flair init` re-points the
instance's own unit — **only** its launcher, node, Harper entry and working
directory — and writes nothing unless the unit is provably this instance's and
exactly a shape flair supports:

| | Written only when | Refused (nothing written) |
|---|---|---|
| macOS plist (`~/Library/LaunchAgents/ai.tpsdev.flair.<hash>.plist`), read as XML structure | one Label (this data directory's) at the top level, ROOTPATH (this data directory) and HOME (yours) in `EnvironmentVariables`, no `Program` key, ProgramArguments = the launcher in its WorkingDirectory tree, this instance's admin-pass file, a `node`, a Harper entry in that tree | a plist that is not this instance's or not in that shape — another HOME, label or pass file, an extra argument, a key in the wrong dict — and an XML declaration naming an encoding other than UTF-8, an XML comment, CDATA, a character reference, a duplicate key, or an unsupported XML element |
| Linux systemd user unit (the one proven above) | one `WorkingDirectory=` (the served tree) and one `ExecStart=` of `<node> <harper.js> run .` or `<launcher> <admin-pass file> <node> <harper.js>`, optional `-` prefix | drop-ins (any location systemd reports, or `<unit>.d` beside the file), any other argument (operator arguments are never rewritten), quoting, `%` specifiers, `$` variables, line continuations, other `ExecStart=` prefixes, and a new path that would need quoting |
| Both, when moving to a different installed tree | the old tree is an npm-global install; its flair version and this CLI's are strict semver and this CLI's is not older (prereleases count: `0.57.0-beta.1` is older than `0.57.0`) | a plain tree or checkout (separately managed), an unreadable, non-semver or newer version (a downgrade cannot be ruled out) |

A unit that serves this CLI's tree with a different, existing node is treated
as a deliberate pin: `flair init` leaves it, and init and `flair doctor` report it
with the hand edit that would move it. A plist that already serves this CLI's
tree has a missing runtime path replaced without the version check in the table,
which applies only to a move between trees. The write is atomic and
lands only over the bytes it was planned from — the file is read as a regular
file (a symlink is refused, not followed) whose bytes are valid UTF-8 (anything
else is refused before planning), and its bytes are re-checked immediately
before the rename, so an edit saved in between refuses the write. On Linux,
`flair init` first records what systemd holds for the unit (it writes nothing
if it cannot, or if systemd no longer reports the serving process as the
unit's MainPID), then runs `systemctl --user daemon-reload` (which also loads any
other pending edits to your user units) and checks what systemd loaded. If the
reload fails or systemd does not hold the re-pointed unit, the previous bytes
are restored, systemd is reloaded and asked again. That check covers three
fields: when systemd's FragmentPath, drop-ins and WorkingDirectory are back at
the values recorded before the write, flair says exactly that and still calls
full agreement between the restored file and systemd unverified; otherwise it
reports systemd's state as unverified. Every refusal names the file, what did not match, and the
remedy — the paths to set by hand, an update of this CLI's tree, or a
reinstall; after a hand edit, `flair restart` brings the instance up under
the edited unit (macOS reloads the plist; on Linux, when the unit is proven to
run the instance, it reloads systemd, restarts through the unit and checks that
the unit's new main process runs from its WorkingDirectory). On Linux,
`flair restart` never stops a process that a systemd unit supervises — one
systemd reports as that unit's MainPID — and starts it again outside the unit:
when it is not the proven unit, it refuses and names the `systemctl` command to
use. It also refuses when flair cannot learn the MainPID of the unit the
process's cgroup names (systemd cannot be asked, or reports no main process),
naming the same command, and when the process's cgroup cannot be read at all
or contradicts itself (for example, a user slice and a user manager that name
different users, or one unit's cgroup nested in another's) — then no manager is
asked.
A process that only runs inside some service's cgroup without being its main
process (a child of a CI runner agent, a terminal multiplexer or an ssh session
service) was started directly, and `flair restart` restarts it directly.

The federation-sync shim (`~/.flair/bin/flair-federation-sync`) is re-pointed
the same way: only its exec line changes, the scheduler unit is never
rewritten, and the shim is refused when it is a symlink or not valid UTF-8,
changes between the read and the rename, runs any command other than what
`flair federation sync enable` writes (comment lines are not compared), or —
when it is moved to a different installed tree — when that tree's version (or
this CLI's) is not strict semver or is newer.
`flair federation sync enable` regenerates it.

### Restart, verification and rollback

In the local upgrade path, `--no-restart` skips restart and post-restart
verification. With restart enabled, the pre-install `/Health` probe runs, also
under `--no-verify`. With `--no-restart`, it runs only when a pre-upgrade
snapshot is needed, to decide whether that snapshot restarts the old instance.

The probe labels a successful HTTP response `running`. A caught error is
`stopped` when every failure in it, including each `cause` and aggregated
error, is a connection refusal: a string code must be `ECONNREFUSED` or
`ConnectionRefused`, and an uncoded failure with no nested failures must
contain one of them in its text. Other responses and caught errors are
`indeterminate`.
The `stopped` label does not establish whether a process exists.

After a thrown restart error, `decideAfterRestartFailure` selects:

| Flair itself was swapped | Prior probe | Previous version | Decision |
| --- | --- | --- | --- |
| No | Any | Any | `no-target` |
| Yes | `stopped` | Any | `keep` |
| Yes | `running` or `indeterminate` | Nonempty | `rollback` |
| Yes | `running` or `indeterminate` | Missing or empty | `no-target` |

`keep` leaves the new package installed, prints the start error and
`flair start`, and exits successfully. `no-target` exits with failure.
`rollback` enters the shared rollback path below.

When post-restart verification runs, `decideAfterVerify` returns `ok` for
a successful probe; otherwise it returns `healthy-unverified` when the probe
reports healthy with a credentials failure. Other results select `rollback`
for a nonempty previous version and `cannot-rollback` otherwise; the latter exits
with failure. Prior liveness and the swap flag are not inputs to this decision.

The shared rollback path refuses a target reported deprecated by the registry
lookup and exits with failure. Failed or unusable lookups, including a null
`deprecated` field, allow the attempt. npm-global attempts to reinstall the
previous package version; plain-tree attempts to restore the saved tree when
it exists and skips restoration when it is absent. The tree restore first
attempts to move the live path to `.upgrade-failed` when it exists.

After that stage, an engine change requires a snapshot path and successful
snapshot restoration before restart. Before restoring, rollback stops the
instance and requires fresh daemon evidence that it is stopped. It then moves
the current data directory to a unique, timestamped sibling named
`<data-dir>.pre-rollback-<timestamp>-<suffix>` and prints that retained path.
Rollback never deletes this retained directory. If stopping, confirming the
stop, validating the snapshot, or moving the data aside fails, restoration is
refused without replacing the current data. To recover writes made after the
snapshot, stop Flair, set aside the restored data directory, move the retained
directory back, and start with the Harper engine version that wrote it.
Rollback then attempts restart and, if restart returns, verification; its
reported outcomes exit with failure.

If that restart throws, the npm-global and restored-tree diagnostics label
the rollback target known-broken for this attempt. The missing-tree diagnostic
uses a neutral headline. Plain-tree recovery text reports whether the previous
tree was restored and whether a live tree was set aside. Both lanes report
whether a data snapshot was restored. An npm version candidate printed by
this message is not guaranteed non-deprecated.

### Pre-upgrade snapshot (opt-in for same-engine, unconditional on engine change)

flair#637 added a **physical**, byte-exact snapshot of `~/.flair/data` — the whole
directory (RocksDB files, keys, config, `admin-pass`), not just the logical records a
`flair backup` JSON export covers. As of 2026-07-08 this is **opt-in** for same-engine
upgrades: pass `--snapshot` to `flair upgrade` to take one before the package swap.
It's off by default — matching how Harper's own upgrade CLI behaves (it recommends a
backup before proceeding, but never auto-tars your data directory for you) — because
the downgrade-boot test (see below) covers same-engine downgrades, and the old opt-out
default meant every upgrade paid the cost (the data dir can be 800MB+; keep-last-3
retention meant up to ~2.5GB of snapshots sitting around) whether or not you wanted it.

**When the engine (Harper) version changes** (flair#1047), the snapshot is
**unconditional** — the tested-downgrade guarantee does not hold across engine version
boundaries, and the backwards-boot refusal + snapshot recovery path is the invariant
that applies. Opting out requires `--no-engine-snapshot` and prints what is being
given up.

```bash
flair upgrade --snapshot
```

```
Snapshotting data before upgrade...
✅ Snapshot: ~/.flair/upgrade-snapshots/flair-data-2026-07-08T14-32-01-118Z.tar.gz (842.3 MB)
   Restore: flair snapshot restore "~/.flair/upgrade-snapshots/flair-data-2026-07-08T14-32-01-118Z.tar.gz"
   Pruned 1 older snapshot (keeping last 3)
```

If you omit `--snapshot` (the default) and a data directory exists, `flair upgrade`
prints a non-blocking recommendation instead of silently skipping it — it never
prompts or blocks, so scripted/non-interactive upgrades are unaffected:

```
No pre-upgrade snapshot will be taken.
To capture one first: `flair snapshot create` (physical) or `flair backup` (logical export), or re-run with --snapshot.
```

- **Location:** `~/.flair/upgrade-snapshots/flair-data-<timestamp>.tar.gz` — owner-only
  (`0600`), with every file inside it at its **original** mode (so a `0600` key or
  `admin-pass` file stays `0600` after a restore, not whatever tar's default would be).
- **Retention:** keeps the newest 3 snapshots, prunes older ones automatically after
  each successful snapshot — whether taken via `--snapshot` or `flair snapshot create`
  (below); both draw from the same `~/.flair/upgrade-snapshots/` pool.
- **Consistency:** a snapshot uses a stopped, quiesced data directory — a plain
  file copy of a *running* Harper's data directory isn't guaranteed point-in-time
  consistent (Harper 5.x stores tables in RocksDB, whose WAL, MANIFEST, and SST
  files can be mid-write/mid-compaction). `flair snapshot create` restarts Flair
  afterward. During an upgrade, the old version is restarted after the snapshot
  only if the pre-install `/Health` probe did not refuse the connection. A refused
  connection leaves it stopped through the package swap. An instance that answered
  or had indeterminate liveness has a short stop/start blip even with
  `--no-restart`; that flag controls the restart *after* the upgrade. (A native
  Harper backup operation, `get_backup`, was evaluated and rejected here — see the code comment
  above `createDataSnapshot` in `src/cli.ts` for why: it backs up one table/schema at a
  time over the running HTTP API, not the whole data directory, and would be strictly
  less complete than a plain file copy.)
- **Failure is a hard stop when requested:** if you passed `--snapshot` and the
  snapshot itself fails (disk full, permissions, etc.), the upgrade aborts before any
  package changes. Flair is restarted on the old version only if the pre-install
  `/Health` probe did not refuse the connection.

#### `flair snapshot` — the standalone command

The same mechanism is available on its own, independent of upgrading:

```bash
flair snapshot create              # take one now (default: ~/.flair/data)
flair snapshot create --data-dir <path>
flair snapshot list                # list what's under ~/.flair/upgrade-snapshots/
flair snapshot list --json
flair snapshot restore <path>      # stop Flair, replace the data dir, restart
flair snapshot restore <path> --yes   # skip the confirmation prompt
```

`flair snapshot restore` is destructive — it deletes the current data directory and
replaces it with the snapshot's contents — so it asks for confirmation unless `--yes`
is passed, and refuses outright in a non-interactive shell without `--yes` (it will
never silently destroy data on an unattended run). Symlinks and file modes extract
exactly as the snapshot recorded them; nothing outside the original data directory is
ever touched.

**`flair snapshot` (physical) vs `flair backup`/`flair restore` (logical) — not the
same thing:**

| | `flair snapshot` | `flair backup` / `flair restore` |
|---|---|---|
| What | Byte-exact tar.gz of `~/.flair/data` | JSON export of Agent/Memory/Soul records |
| Scope | Everything — RocksDB files, keys, config, `admin-pass` | Just the records, over the HTTP API |
| Portability | Same host, same Flair/Harper version | Portable across hosts and versions |
| Use for | Undoing an upgrade that wrote data the old version can't read | Migrating data, or a lightweight logical restore |

Use whichever (or both) fits — they're complementary, not redundant, which is why they
live under separate command namespaces instead of overloading `restore`.

If you'd rather upgrade by hand instead of `flair upgrade`:

```bash
npm install -g @tpsdev-ai/flair@latest
# flair-mcp is zero-install via npx — no global install needed.
# flair doctor --fix rewires the hook to the current npx form.
flair restart
```

`flair doctor` flags issues after an upgrade (stale embeddings, hash-fallback rows,
connectivity problems) and can auto-remediate some of them with `flair doctor --fix`
(`--dry-run` to preview first).

## Upgrading a Fabric-deployed instance

A Flair instance deployed to a Harper Fabric cluster isn't a local npm package — it's a
component pushed via `flair deploy`. Upgrade it in place with:

```bash
FABRIC_USER=<admin> FABRIC_PASSWORD=<pass> \
  flair upgrade --target https://<fabric-node>/<instance-name>
```

(or `--fabric-password-file <path>` instead of the `FABRIC_PASSWORD` env var — reads the
password from a file, chmod 600). This resolves the target version (latest published
`@tpsdev-ai/flair`, or pin one with `--flair-version`), stages a clean deployable with the
required `harper` version pin applied (`--harper-version` to override),
confirms the staged Harper build before deploying, then reuses `flair deploy` to push it
and verifies the result. `--check` shows the version diff and plan without deploying
anything; `--yes` skips the confirmation prompt for scripted use.

Inline `--fabric-user`/`--fabric-password` flags also work — **discouraged: both leak to
shell history and `ps`** for the life of the process, so avoid them on shared/multi-user
hosts:

```bash
flair upgrade --target https://<fabric-node>/<instance-name> \
  --fabric-user <admin> --fabric-password <pass>
```

### Post-deploy embedding-stamp verify

As of flair#1073, both `flair deploy` and `flair upgrade --target` poll
authenticated `/HealthDetail` after the served-API check until the
`embedding-stamp` migration has converged — every real embedding is in the
current `+searchprefix` space, and the migration is not halted or still
running. Route verify only proves the component is serving; it does not
prove the boot-keyed re-embed actually finished. A Fabric instance that
stayed split for days after 0.30.0 was the incident this closes.

`--no-verify` skips this check together with the served-API check.
`--verify-timeout` covers both. Token-only auth skips the stamp check
(it needs Basic admin to read `/HealthDetail`) and says so.

### Post-deploy fleet verify

As of flair#636, both `flair deploy` and `flair upgrade --target` automatically run a
fleet convergence sweep after a successful deploy — Harper's own "Successfully
deployed" (and the served-API verify above) only confirm the *origin* node; nothing
previously checked that peers actually converged, which is exactly the gap that let
the 0.21.0 deploy report success while a peer was still throwing replication errors.

The sweep hits the origin plus every Flair federation peer on file (`GET
/FederationPeers`) and checks health, auth, and version. Skip it with
`--no-fleet-verify`, or run it standalone against any already-deployed instance:

```bash
FABRIC_USER=<admin> FABRIC_PASSWORD=<pass> \
  flair fleet verify --target https://<fabric-node>/<instance-name>
```

(inline `--fabric-user`/`--fabric-password` also work but are discouraged — see above.)

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | All probed nodes verified. Unverifiable peers (no endpoint on file) are listed as a warning and do not fail |
| 1 | Origin failed (unreachable, unauthenticated, or wrong version) |
| 2 | A reachable node diverged (wrong version) — NOT converged |
| 3 | A reachable peer was unreachable or rejected auth (not unverifiable) |

**What "peer" means here — read before trusting a green sweep:** this checks
*Flair's own* federation peer table, not Harper Fabric's own cluster-replication
nodes. Harper's `cluster_status` operation (the one that would answer "what nodes are
in this cluster and are they in sync") is harper-pro-only and unavailable in the OSS
`harper` build this CLI ships — there is no way for this CLI to enumerate
Fabric's own replication topology, on the origin or anywhere else. A Fabric replica
that was never separately paired as a Flair federation peer (`flair federation pair`)
is invisible to this sweep: `0 peers known` means "0 peers on file," never "0 peers
exist." A peer with no usable endpoint is reported `unverifiable` — listed and
warned, never shown green, and does not fail the run (a reachable peer on the
wrong version still does). The sweep also needs Basic-auth credentials
(`FABRIC_USER`/`FABRIC_PASSWORD` env, or the discouraged inline
`--fabric-user`/`--fabric-password`) to authenticate each peer probe; a token-only
(`--fabric-token`) deploy skips it with a note instead of a silent no-op.

### Peer-replication errors are not verdicts

Harper replicates a deployed component to its cluster peers **asynchronously**, so
`harper deploy` can exit non-zero with

```
Component 'flair' was deployed on the origin node but failed to replicate to 1 of 1
peer node(s): <peer> (Error: Connection closed 1006)
```

for a deploy that then converges on its own moments later. That error describes one
instant, not an outcome.

Both `flair deploy` and `flair upgrade --target` therefore **check before they
declare**. On that error the CLI reads the peer node names out of Harper's own
message, polls each node's component file tree (`get_components` — path, size and
mtime), and compares it against the origin's. If every named peer converged, the
deploy is reported as a **success**, with a line saying that Harper's error resolved:

```
⚠ harper reported a peer-replication failure, but every named peer node's component
  tree matched the origin when checked afterwards — replication converged on its own.
```

Convergence is only ever claimed on positive evidence. A peer whose name is not an
addressable host, whose hostname does not resolve, which cannot be reached, which
reports no such component, or which currently resolves to the *same address as the
deploy target* (a Fabric cluster endpoint is steered to one member node, so that
comparison would be a node against itself) is reported as unverified — never as
converged.

| Flag | Effect |
|------|--------|
| `--convergence-timeout <ms>` | How long to wait for replication to converge before reporting failure (default `180000`) |
| `--no-convergence-check` | Skip the poll and fail on Harper's error verbatim |
| `--ignore-replication-errors` | Accept an origin-only deploy when replication has not converged; the peer catches up via federation sync or a later deploy |
| `--deploy-retries <n>` | Retry the full deploy when replication is *observed* not to have converged (default `0`) |

**`--deploy-retries` defaults to `0`, deliberately.** A retry re-runs the whole
deploy, including Harper's own `npm install` into the component directory on every
node, and a real upgrade died that way — `ENOTEMPTY` on a native module, on the
*retry*, for a deploy whose peers had already converged. Retrying was compensating
for the absence of a convergence check; the poll above covers that window without
touching the cluster. When retries are enabled they are gated twice: only on
positively observed non-convergence, and only once the origin's component tree has
stopped changing across consecutive reads. If a retry does still fail differently
from the original error, the CLI reports the **original** failure as the headline and
labels the later one as a consequence of retrying — a retry can never change what the
failure is reported to be.

## Re-embedding after an upgrade

Two situations require a re-embed pass, and `flair doctor` will flag both:

- **The embedding model changed** between versions — old memories carry vectors from
  the previous model and won't compare correctly against new ones.
- **Harper's internal vector storage changed across a version bump** (this has
  happened between Harper point releases, e.g. HNSW-index-internal changes) — even
  with the same embedding model, stored vectors may need to be regenerated to match
  what the new Harper build expects.

`flair doctor` reports the counts:

```
⚠️  49 memories have hash-fallback embeddings (512-dim)
   Current model produces 768-dim vectors
   Run: flair reembed
```

Fix with:

```bash
flair reembed                 # all agents, all stale rows
flair reembed --stale-only    # only mismatched-model-tag rows
flair reembed --agent <id>    # scope to one agent
flair reembed --dry-run       # show the count without writing
```

This runs in the background — the server stays available while it re-embeds. This is
also the step CI's `upgrade-smoke` job exercises directly: it upgrades a running
instance from the latest published version to the candidate build, then runs
`flair reembed` before asserting old memories are still searchable and new writes
round-trip. See the `upgrade-smoke` job in
[`.github/workflows/test.yml`](../.github/workflows/test.yml) for the exact sequence
if you want to see it scripted end-to-end.

## Version compatibility

- **Data format:** Flair stores data in Harper's native format; Harper maintains
  backward compatibility within a major line. Cross-Harper-version data compatibility
  is exactly what `upgrade-smoke` exists to catch regressions in — check the CHANGELOG
  for any called-out breaking change before a major jump.
- **Keys:** Ed25519 keypairs are version-independent. No key migration is ever needed
  between Flair versions.
- **Config:** `~/.flair/config.yaml` format is additive — new options fall back to
  defaults when absent, old options aren't removed out from under you.
- **Harper 5.2:** Starting with the release that pins Harper 5.2.0 (see CHANGELOG). This upgrade is **forward-only** — Harper 5.2 writes LZ4-compressed storage
  that Harper 5.1.x cannot read. If you need to roll back, restore the pre-upgrade snapshot: `flair snapshot restore <path>` (use `flair snapshot list` to find available snapshots). Note this is the physical engine snapshot restore, distinct from `flair restore` which replays a logical JSON export and cannot recover a 5.1-incompatible data directory. Installing an older Harper version will not boot against a
  5.2-written data directory. Flair automatically takes a snapshot when the Harper engine
  minor version changes, so a valid snapshot will exist if you
  upgraded via `flair upgrade`. Real snapshots for production datasets run hundreds of
  megabytes — plan disk capacity accordingly. Cleanup of old engine snapshots is manual;
  `flair snapshot list` shows available snapshots, and you can delete entries you no longer
  need (e.g. `rm ~/.flair/upgrade-snapshots/flair-data-<old>.tar.gz`).

## Rollback

If an upgrade causes problems immediately after upgrading (code-level, not data):

```bash
# Install a specific previous version (substitute your last known-good)
npm install -g @tpsdev-ai/flair@<previous-version>
flair restart

# If data looks wrong, restore from your pre-upgrade backup
flair restore ~/flair-backup-<date>.json
```

`flair upgrade` selects automatic rollback after post-restart verification only
when the result is neither `ok` nor `healthy-unverified` and a nonempty previous
version is available; otherwise a failed result is `cannot-rollback`. A thrown
restart error instead keeps a swapped Flair package after a refused pre-upgrade
`/Health` connection (`keep`, successful exit). No swap, or no previous version
after a running or indeterminate probe, selects `no-target`; a swap with that
probe and a nonempty previous version selects rollback. Reported deprecation
blocks rollback; a missing saved plain-tree directory skips tree restoration.
Engine-change data restoration requires a confirmed stop and retention of the
current directory. See [Restart, verification and rollback](#restart-verification-and-rollback)
for the decisions and retained-data recovery instructions. This section is for
manual recovery, e.g. after `--no-verify`, or after problems surface later than
the automatic check catches.

### Known issue — upgrading *from* an older version can still report a false rollback

The 0.25.1 fix (see [`CHANGELOG.md`](https://github.com/tpsdev-ai/flair/blob/main/CHANGELOG.md)) makes `flair upgrade` resolve a
credentials-only post-restart-verification failure to `healthy-unverified` instead of
rolling back. That fix is **forward-only**: it lives in the *new* CLI code, but an
upgrade's post-restart verification is run by the CLI that was already installed
*before* the upgrade — the old code, which doesn't have the fix.

So on a machine upgrading **from** a version older than 0.25.1, with no
`~/.flair/admin-pass` and no agent key on disk, the old verifier still can't
authenticate to the authenticated `/HealthDetail` check. It reports a false
`post-restart verification failed … 403: no credentials sent`, triggers an automatic
rollback, and that rollback's own re-verify hits the identical missing-credential
wall — leaving you with `ROLLBACK ALSO FAILED VERIFICATION — instance state is
UNKNOWN`, even though the instance was healthy the entire time (a 403 means the server
answered).

**Workarounds:**

- Skip verification for this one upgrade: `flair upgrade --no-verify` — safe as long
  as you've confirmed the instance is reachable first (`flair status`).
- Or provision credentials before upgrading, so the verifier can authenticate:
  `flair init`, or export `FLAIR_ADMIN_PASS`.

This gap only exists while crossing into 0.25.1. Once you're running 0.25.1 or later,
the verifier itself resolves a credentials-only failure to `healthy-unverified`
instead of rolling back, so it cannot recur on subsequent upgrades.

### Known issue — upgrading *from* 0.26.0 or older can leave the server stopped

On Linux (and macOS without a launchd plist), versions up to and including 0.26.0
had a bug in the upgrade path's port-based stop step: it matched *any* process
with a socket on the Flair port — including the upgrading CLI's **own** keep-alive
connections left by the credential pre-flight — and SIGTERM'd itself mid-restart.
The visible symptom: `Restarting Flair... Stopping...` and then the command dies
(SIGTERM, exit 143) before `Starting...`, leaving the server down even though the
package upgraded fine (flair#800).

The fix (listening-socket filter + self-PID guard) is **forward-only** for the same
reason as above: the restart is performed by the *old*, already-installed CLI.

**Workarounds when upgrading from ≤ 0.26.0:**

- Prefer `flair upgrade --no-verify` — skips the credential pre-flight whose
  keep-alive sockets trigger the self-kill (validated end-to-end).
- If you already hit it (upgrade "finished" but the server is down): run
  `flair start` — not `restart` — and you're on the new version. Nothing was lost.

### Known issue — upgrading *from* 0.29.0 stops with a false "Harper binary not found"

0.30.0 renamed its Harper dependency from `@harperfast/harper` to the bare
`harper` package (flair#870, a real ~104 MB saving — the two names are the same
engine and no package manager can dedupe across them). `flair upgrade` replaces
the package tree *while the CLI is executing out of it*, and 0.29.0's restart
step only ever probes the old name — so once the swap lands, the name it is
looking for is genuinely gone:

```
Restarting Flair...
Stopping...
Starting...
❌ restart failed: Harper binary not found. Run 'flair init' first.
   Flair may be partially down. Check: flair doctor
```

The error is false twice over. The install is complete and Harper is present
under its new name; and `flair init` is the wrong remedy — on an initialised
instance it is not what you want to reach for, and it could not have fixed a
missing binary anyway.

**Workaround when upgrading from 0.29.0:** run `flair start`. The new version is
installed and correct; only the old CLI's restart step failed. `flair status`
should then report 0.30.0 and healthy. Nothing was lost — the upgrade never
touches `~/.flair/data`.

Forward-only, for the same reason as the two issues above: the code that
performs the restart is the version you are upgrading *from*. From flair#905
onward the restart is handed to the newly installed CLI and the Harper package
name is read from the post-swap `package.json` instead of being compiled in, so
a future dependency rename cannot reproduce it.

## Downgrade

Rolling back the **package** (above) assumes the data on disk is fine — only the new
code was the problem. If the new version actually **wrote data in a way the old
version can't read**, package rollback alone isn't enough. This is what the
flair#637 pre-upgrade snapshot exists for.

### Procedure

```bash
# 1. Find the snapshot (the exact path/command `flair upgrade --snapshot` printed
#    when it ran, or list them yourself):
flair snapshot list

# 2. Restore it — this stops Flair, replaces ~/.flair/data, and restarts:
flair snapshot restore ~/.flair/upgrade-snapshots/flair-data-<timestamp>.tar.gz

# 3. Install the previous version
npm install -g @tpsdev-ai/flair@<previous-version>
flair restart

# 4. Verify
flair status
flair doctor
```

`flair snapshot restore` does the stop/replace/restart in one step (confirming before
the destructive replace unless you pass `--yes`); the equivalent by hand is `flair
stop && rm -rf ~/.flair/data && mkdir -p ~/.flair/data && tar -xzf
<snapshot> -C ~/.flair/data && flair start`, in case you'd rather not use the command.

If you don't have a snapshot (upgraded without `--snapshot`, or on a version from
before flair#637 shipped it), there is no tested way back short of restoring from a
`flair backup` JSON export on the older version — do not assume an untested downgrade
boot will work.

### Does the previous version actually boot against newer data? (tested, not assumed)

This used to be aspirational — nobody had actually checked. `test/compat/downgrade-boot.test.ts`
now checks it for real, nightly, alongside the mixed-version federation suite (both run
from `.github/workflows/federation-compat.yml`'s `bun test test/compat/`): it boots the
current build, writes a memory and a presence row, stops it *without* wiping the data
directory, then boots the last **npm-published** `@tpsdev-ai/flair` against that exact
same directory and confirms it comes up healthy and can read both rows back.

**The guarantee is now restated (flair#1050):** there is never a silent bad outcome.
Either the old binary boots and serves the corpus correctly, **or** it refuses to start
with a message naming what wrote the store, what is running, and how to recover — and a
pre-upgrade snapshot exists to recover *from*. The first branch (clean boot) holds for
same-engine upgrades; the second (refusal + snapshot) applies when the engine version
changes, which is the case where downgrade was never ours to guarantee.

**First known engine-version break:** Harper 5.1 → 5.2 (2026-08). 5.2.0 creates the
`hdb_secret` store on first boot against an existing data directory, and the older binary
will not start against it. Harper's 5.2.0 release notes document no rollback procedure.
The backwards-boot refusal (flair#1049) catches this: the old binary refuses to start,
naming both versions and the data directory, with recovery instructions. A pre-upgrade
snapshot exists at the named path. Restoring it returns the store to a working state.

**Patch-level break inside 5.2:** Harper 5.2.7 writes LZ4-compressed RocksDB that
Harper 5.2.0 cannot open (`LZ4 not supported in this build`). Downgrade from a
5.2.7-written store to the npm-published 5.2.0 pin is forward-only — same
recovery as the 5.1 → 5.2 break: `flair snapshot restore <path>`. The
`downgrade-boot` suite treats that Harper crash as the loud-refusal branch of
the flair#1050 invariant (it boots Harper via `startHarper`, so the CLI stamp
phrasing is not on that path).

**As observed when this suite was added (2026-07-08):** the npm-published baseline
(0.21.0) boots cleanly against data written by a HEAD build roughly 14 commits ahead of
it (several security-hardening and CLI-behavior changes, no Flair schema migration, and
only a patch-level `@harperfast/harper` bump, 5.1.15 → 5.1.17) — both the memory and
presence rows written by the newer build were readable through the older build's own
HTTP surface after the downgrade boot. **No downgrade break has been found across that
gap.**

This is *not* a blanket "downgrade is always safe" guarantee for every future release —
it's a live, continuously-checked claim. If `test/compat/downgrade-boot.test.ts` starts
failing (a real schema-incompatible change landing without a documented break), this
section and the test's own assertions get updated together to say so explicitly, the
same way this paragraph does today. Check the suite's latest nightly run (or the
CHANGELOG for an explicit "no downgrade past X" note) before relying on this for a jump
you haven't personally tested.

## See also

- [`CHANGELOG.md`](https://github.com/tpsdev-ai/flair/blob/main/CHANGELOG.md) — what actually changed, version by version.
- [`docs/releasing.md`](releasing.md) — how a release gets published in the first
  place (staged npm publish with 2FA approval), if you're curious why a new version
  shows up when it does.
- [`docs/deployment.md`](deployment.md) — initial install / deployment, as opposed to
  upgrading an existing one.
- [`docs/api-reference.md`](api-reference.md) — HTTP endpoints, auth per resource, and
  the Presence / Memory / Soul / Agent / Federation schemas.
