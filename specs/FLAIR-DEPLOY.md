# FLAIR-DEPLOY: One-Command Fabric Deployment

> Zero-install deploy of Flair as a component onto an existing Harper Fabric cluster.

**Status:** Draft
**Depends on:** Harper Fabric + `deploy_component` API
**Audience:** 1.0 — anyone with a Fabric cluster wanting Flair in a minute

---

## § 1 Problem

Getting Flair onto Harper Fabric today requires:

1. Read Harper's deploy_component docs
2. Install Flair locally (or clone the repo)
3. Figure out the right `harperdb deploy_component` invocation with project/target/username/password flags
4. Hope the runtime env matches

That's a 20-minute first-run with several cliffs. We want the **one command demo**:

```bash
npx @tpsdev-ai/flair deploy --fabric-org acme --fabric-cluster prod
```

Someone who just read the README has Flair running on their Fabric cluster before their coffee is cold. Zero local Flair install, zero prior `flair init`, zero manual tarball handling.

## § 2 What `flair deploy` Is

A Flair CLI subcommand that:

1. Resolves the currently-installed `@tpsdev-ai/flair` package (including via `npx`, which extracts the tarball to a temporary location)
2. Packages `dist/` + `schemas/` + `config.yaml` + `ui/` as a Harper component
3. Calls Harper's `deploy_component` API against the target Fabric cluster
4. Reports the public URL + next-step command to the user

It is **not** a Fabric cluster provisioner. Nathan confirmed 2026-04-20 that Fabric doesn't yet expose an API for org/cluster creation. Users bring their own cluster.

## § 3 Command Surface

```
flair deploy [options]

Required:
  --fabric-org <org>            Fabric org identifier
  --fabric-cluster <cluster>    Fabric cluster name within the org

Required (one of):
  --fabric-user <user>          Fabric admin username
  --fabric-password <pass>      Fabric admin password
  --fabric-token <token>        OAuth bearer token (preferred once available)

Or via environment:
  FABRIC_ORG, FABRIC_CLUSTER, FABRIC_USER, FABRIC_PASSWORD, FABRIC_TOKEN

Optional:
  --project <name>              Component name in Fabric (default: "flair")
  --version <semver>            Pinned version (default: installed package version)
  --replicated                  Replicate to every node in the cluster (default: true)
  --restart                     Restart the component after deploy (default: true)
  --dry-run                     Pack + validate, do NOT call Fabric API
  --yes                         Skip the pre-deploy confirmation prompt
```

## § 4 Zero-State Requirements

The command must work with **no local Flair state**. That means:

- No `.flair/keys`, no `~/.flair/*`, no `~/.tps/secrets` lookup
- No running daemon check (`flair status` is irrelevant for remote deploy)
- No local config file lookup (`config.yaml` comes from the installed package itself)
- No interactive prompts unless the user explicitly invoked a TTY

All inputs come from CLI flags or environment variables. This makes `npx @tpsdev-ai/flair deploy ...` work in a CI job, a Dockerfile, or a fresh dev box.

## § 5 Flow

```
1. Parse + validate args
2. Resolve source package root:
   - Prefer process.argv[1] resolution (where npx dropped us)
   - Fallback: require.resolve("@tpsdev-ai/flair/package.json")
3. Verify package contains dist/, schemas/, config.yaml, ui/
4. Build component tarball:
   - Tar the four dirs (+ package.json) in memory (or tmpdir)
   - Name: flair-<version>.tgz
5. Resolve Fabric target URL:
   - https://<cluster>.<org>.harperfabric.com (default template)
   - Or --target <url> override (for non-standard hosts)
6. Call Harper deploy_component API (POST with Basic auth or Bearer)
7. Poll component status until RUNNING (timeout 3 min)
8. Print success payload:
   - Public URL
   - Admin seed command (next step)
   - "flair agent add --remote <url>" hint
```

## § 6 Next-Step UX (the part users see)

```
$ npx @tpsdev-ai/flair deploy --fabric-org acme --fabric-cluster prod
✓ Flair 0.6.0 packaged (1.2 MB)
✓ Deploying to https://prod.acme.harperfabric.com
✓ Component running (2.4s)

Your Flair is live:  https://prod.acme.harperfabric.com
Admin username:      admin
Admin password:      <prompt: set via Fabric Studio>

Seed your first agent:
  npx @tpsdev-ai/flair agent add --remote https://prod.acme.harperfabric.com --name my-agent

Next time, skip npx:
  npm install -g @tpsdev-ai/flair
```

## § 7 Out of Scope (for 1.0)

- **Cluster provisioning.** If Nathan's user doesn't have a Fabric cluster, they create one manually in Fabric Studio. We don't attempt to orchestrate cluster birth.
- **Credential storage.** `flair deploy` reads credentials from flags/env but doesn't cache them. Re-running takes them again. A future `flair login --fabric` can cache short-lived tokens.
- **Remote admin bootstrap.** The command deploys the code; it does not create an admin agent on the remote. That happens in `flair agent add --remote` (existing flow, minor extension).
- **Rollback / multi-version management.** `deploy` replaces whatever's running. Version pinning via `--version` is enough for 1.0.

## § 8 Dependencies

- Harper's `deploy_component` API must accept the arguments we send. We use the documented shape: `project`, `target`, `username`, `password`, `restart`, `replicated`, and either a file upload or git URL source. Native tarball upload is the cleanest path for Flair since the package is self-contained.
- `harper-fabric-embeddings` is already proven on Fabric (2026-04-20 confirmation) — the embedding path is not a blocker.

## § 9 Risks + Open Questions

- **Fabric auth flow.** Docs show Basic auth; OAuth bearer is the preferred path once Fabric exposes it. Design the deploy client to accept either from day one.
- **Tarball vs. git deploy.** Fabric Studio's "Import Application" flow uses a git URL. `deploy_component` CLI uses file upload. Our `flair deploy` goes file-upload — keeps us zero-network-dependency (user might be offline re: GitHub, or running from a forked Flair).
- **package.json `files` array at deploy time.** We already ship `dist/`, `schemas/`, `config.yaml`, `ui/`, and the LICENSE/README. The deploy command tars the same set — keep the list in a shared constant so we don't drift.
- **First-deploy admin credentials.** Fabric's admin credentials aren't always knowable ahead of time if the cluster was created via Studio UI. The error message when `--fabric-password` is wrong should tell the user to check Fabric Studio → Cluster Settings → Admin. Small detail, big UX impact.

## § 10 Test Plan

- [ ] `flair deploy --dry-run --fabric-org x --fabric-cluster y --fabric-user u --fabric-password p` packs successfully, does NOT call Fabric
- [ ] `npx @tpsdev-ai/flair deploy ...` works from a fresh directory with no `@tpsdev-ai/flair` installed
- [ ] Missing required flags produce an actionable error (not a stack trace)
- [ ] Wrong Fabric password produces "check Cluster Settings → Admin"
- [ ] CI smoke: pack-smoke adds a `deploy --dry-run` call to guarantee the packaging never silently regresses
- [ ] Integration-test new command surface with a Fabric START-tier target (real deploy, then teardown) — can be a manual checklist for 1.0 cut, not CI

## § 11 Open Questions for Review

**For Kern (arch):** Is there value in making `deploy` a generic Harper-component deploy primitive (`tpscomp deploy flair --fabric-org ...`) vs. baking it into the Flair CLI? The former sets up a reusable pattern if we ever ship other Harper components; the latter keeps the 1.0 surface tight. My instinct: bake it in, extract later if we actually ship a second component.

**For Sherlock (sec):** The command holds admin credentials in memory briefly during the HTTP call. Any concern with how we accept them (flag vs env vs prompt)? My default: prefer env + prompt, warn when `--fabric-password` is passed via flag (leaks to shell history).
