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

# 3. Upgrade
flair upgrade
# — or, to upgrade and restart in one step:
flair upgrade --restart

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
flair upgrade --target https://<fabric-node>/<instance-name> \
  --fabric-user <admin> --fabric-password <pass>
```

This resolves the target version (latest published `@tpsdev-ai/flair`, or pin one with
`--version`), stages a clean deployable with the required `@harperfast/harper` version
pin applied (`--harper-version` to override), confirms the staged Harper build before
deploying, then reuses `flair deploy` to push it and verifies the result. `--check`
shows the version diff and plan without deploying anything; `--yes` skips the
confirmation prompt for scripted use. Credentials can come from `FABRIC_USER` /
`FABRIC_PASSWORD` env vars instead of flags.

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

If an upgrade causes problems:

```bash
# Install a specific previous version (substitute your last known-good)
npm install -g @tpsdev-ai/flair@<previous-version>
flair restart

# If data looks wrong, restore from your pre-upgrade backup
flair restore < ~/flair-backup-<date>.json
```

Downgrading more than a minor version back is not a supported, tested path — restoring
from backup on the older version is the reliable route if you need to go back further.

## See also

- [`CHANGELOG.md`](../CHANGELOG.md) — what actually changed, version by version.
- [`docs/releasing.md`](releasing.md) — how a release gets published in the first
  place (staged npm publish with 2FA approval), if you're curious why a new version
  shows up when it does.
- [`docs/deployment.md`](deployment.md) — initial install / deployment, as opposed to
  upgrading an existing one.
