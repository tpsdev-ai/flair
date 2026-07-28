- **Docs: `docs/deploying-on-fabric.md` — running Flair on Harper Fabric.** The hosted
  counterpart to `docs/deployment.md`: when the managed shape is the right trade, how
  `flair deploy` + `flair init --target … --remote` differ from a local install,
  connecting over a `443` endpoint, pairing local spokes to a hosted hub, and what is
  and is not observable on a node you have no shell on.

  Three things it states that were previously only operator knowledge. **Ops-port
  derivation breaks on a managed Fabric URL** — the CLI derives the ops API as
  `HTTP port − 1`, so an `https` target with no explicit port resolves to `:442`; pass
  `--ops-target` (or `FLAIR_OPS_TARGET`) explicitly. **Federation is push-only** —
  `POST /FederationSync` is one-directional per call with no pull endpoint anywhere, so
  a spoke contributes up and cannot consume down, and bidirectional flow requires two
  reciprocal pairings. **The scheduled sync driver is local-only** — it installs a
  launchd job or systemd timer on the machine running the CLI and cannot be installed on
  a Fabric node.

  Also documents the observability floor for a shell-less instance: `flair doctor` takes
  no `--target` and cannot be pointed at a hosted instance at all; there is no free-space,
  quota, or disk-warning telemetry on any surface; and the unbounded npm cache left by
  repeated deploys ([#886](https://github.com/tpsdev-ai/flair/issues/886), open) has no
  in-product mitigation. Cross-linked from `docs/deployment.md`, `docs/federation.md`,
  and the README.
