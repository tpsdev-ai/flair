# Upgrade Guide

This page covers the mechanics of upgrading Flair — the general path, valid across
versions. For **what changed in a specific release** (behavior changes, new surfaces,
breaking changes), see [`CHANGELOG.md`](../CHANGELOG.md) — each version has its own
`## [X.Y.Z]` section. Check the CHANGELOG entries between your current version and the
target version before upgrading anything you depend on in production.

There are two things you might be upgrading:

1. **A local npm install** — the common case: `flair` running on your own machine or a
   VPS, installed via `npm install -g @tpsdev-ai/flair`.
2. **A Flair component deployed to a Harper Fabric cluster** — a different mechanism
   (`flair deploy` / `flair upgrade --target`), covered separately below.

## Standard upgrade (local install)

```bash
# 1. Back up first, always
flair backup > ~/flair-backup-$(date +%Y%m%d).json

# 2. Check what's outdated (doesn't install anything)
flair upgrade --check

# 3. Upgrade — installs, restarts, and verifies the new version is actually
#    serving, all in one step (see "Upgrade is a transaction" below)
flair upgrade

# 4. Verify
flair status
flair doctor
```

`flair upgrade` checks and upgrades the npm-global packages (`@tpsdev-ai/flair`,
`@tpsdev-ai/flair-mcp`) and, if present, the `openclaw-flair` plugin (via
`openclaw plugins install --force --pin`, not `npm install -g` — it needs OpenClaw's
own plugin loader). Pass `--all` to also see `flair-client` (normally hidden as a
transitive dependency). **Other integrations upgrade in their own ecosystem, not via
`flair upgrade`:** `pi-flair` (pi's plugin manager), `langgraph-flair` / `hermes-flair`
(pip / your Python package manager), `n8n-nodes-flair` (n8n's Community Nodes UI).

### Upgrade is a transaction

As of flair#635, `flair upgrade` is install → restart → verify →
rollback-on-failure, in one step — installing new code without restarting used
to leave the OLD process serving while the version on disk lied about what was
actually running:

- **Restart happens automatically** after install. Pass `--no-restart` to
  stage the new packages without bouncing the process yet (the old
  opt-in `--restart` flag still parses but is now a no-op — restart is the
  default).
- **Post-restart verification** (skip with `--no-verify`) confirms the
  restarted instance answers `/Health`, that an authenticated request
  round-trips, and that the reported running version matches what was just
  installed.
- **On verification failure**, `flair upgrade` automatically reinstalls the
  previously-running `@tpsdev-ai/flair` version, restarts again, and
  re-verifies — then exits nonzero with a clear report of what failed. If the
  rollback itself fails verification, it says so loudly and points at the
  concrete pre-upgrade snapshot path (see "Pre-upgrade snapshot" below)
  instead of retrying in a loop — see [Downgrade](#downgrade) for the
  restore procedure.

### Pre-upgrade snapshot (opt-in)

flair#637 added a **physical**, byte-exact snapshot of `~/.flair/data` — the whole
directory (RocksDB files, keys, config, `admin-pass`), not just the logical records a
`flair backup` JSON export covers. As of 2026-07-08 this is **opt-in**: pass
`--snapshot` to `flair upgrade` to take one before the package swap. It's off by
default — matching how Harper's own upgrade CLI behaves (it recommends a backup before
proceeding, but never auto-tars your data directory for you) — because the
tested-downgrade guarantee below already covers the failure mode a snapshot exists
for, and the old opt-out default meant every upgrade paid the cost (the data dir can
be 800MB+; keep-last-3 retention meant up to ~2.5GB of snapshots sitting around)
whether or not you wanted it.

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
- **Consistency:** when a snapshot is taken (`--snapshot`, or `flair snapshot create`),
  Flair is briefly stopped, snapshotted, and immediately restarted on the same version
  before anything else happens — a plain file copy of a *running* Harper's data
  directory isn't guaranteed point-in-time consistent (Harper 5.x stores tables in
  RocksDB — an LSM engine whose WAL, MANIFEST, and SST files can be
  mid-write/mid-compaction), so the snapshot always happens against a quiesced
  directory. During an upgrade this means a short stop/start blip even with
  `--no-restart` — the snapshot's correctness doesn't depend on whether you want a
  restart *after* the upgrade, those are separate questions. (A native Harper backup
  operation, `get_backup`, was evaluated and rejected here — see the code comment
  above `createDataSnapshot` in `src/cli.ts` for why: it backs up one table/schema at a
  time over the running HTTP API, not the whole data directory, and would be strictly
  less complete than a plain file copy.)
- **Failure is a hard stop when requested:** if you passed `--snapshot` and the
  snapshot itself fails (disk full, permissions, etc.), the upgrade aborts before any
  package changes — no packages are swapped, Flair is restarted on the version it was
  already running.

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
npm install -g @tpsdev-ai/flair-mcp@latest   # if installed
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
`@tpsdev-ai/flair`, or pin one with `--version`), stages a clean deployable with the
required `@harperfast/harper` version pin applied (`--harper-version` to override),
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
| 0 | All nodes verified: healthy, authenticated, and version-matched |
| 1 | Origin failed (unreachable, unauthenticated, or wrong version) |
| 2 | Origin OK, but a reachable peer is running a different version (skew) |
| 3 | Origin OK, no skew among reachable peers, but a peer couldn't be verified at all (unreachable, auth rejected, or no endpoint on file) |

**What "peer" means here — read before trusting a green sweep:** this checks
*Flair's own* federation peer table, not Harper Fabric's own cluster-replication
nodes. Harper's `cluster_status` operation (the one that would answer "what nodes are
in this cluster and are they in sync") is harper-pro-only and unavailable in the OSS
`@harperfast/harper` build this CLI ships — there is no way for this CLI to enumerate
Fabric's own replication topology, on the origin or anywhere else. A Fabric replica
that was never separately paired as a Flair federation peer (`flair federation pair`)
is invisible to this sweep: `0 peers known` means "0 peers on file," never "0 peers
exist." A peer with no usable endpoint is reported `unverifiable` — never silently
dropped, never shown green. The sweep also needs Basic-auth credentials
(`FABRIC_USER`/`FABRIC_PASSWORD` env, or the discouraged inline
`--fabric-user`/`--fabric-password`) to authenticate each peer probe; a token-only
(`--fabric-token`) deploy skips it with a note instead of a silent no-op.

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

## Rollback

If an upgrade causes problems immediately after upgrading (code-level, not data):

```bash
# Install a specific previous version (substitute your last known-good)
npm install -g @tpsdev-ai/flair@<previous-version>
flair restart

# If data looks wrong, restore from your pre-upgrade backup
flair restore < ~/flair-backup-<date>.json
```

`flair upgrade` does this automatically on a failed post-restart verification — see
"Upgrade is a transaction" above. This section is for doing it by hand, e.g. after
`--no-verify`, or after problems surface later than the automatic check catches.

### Known issue — upgrading *from* a pre-0.25.1 version can still report a false rollback

The 0.25.1 fix (see [`CHANGELOG.md`](../CHANGELOG.md)) makes `flair upgrade` resolve a
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

- [`CHANGELOG.md`](../CHANGELOG.md) — what actually changed, version by version.
- [`docs/releasing.md`](releasing.md) — how a release gets published in the first
  place (staged npm publish with 2FA approval), if you're curious why a new version
  shows up when it does.
- [`docs/deployment.md`](deployment.md) — initial install / deployment, as opposed to
  upgrading an existing one.
