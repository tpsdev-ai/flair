# Fabric Quick Start

From zero to a **reachable** Flair URL — so Cursor, Grok Bot, and cloud agents can actually hit it.

Laptop Flair from [`docs/quickstart.md`](quickstart.md) listens on `127.0.0.1:19926`. That loopback origin is not reachable from Grok Bot or Cursor cloud agents. This page is the start path when you need a public HTTPS origin.

Fabric is **Harper-hosted**, not a Flair-operated cloud. You deploy Flair as a component onto [Harper Fabric](https://www.harperdb.io/).

## 0. Prerequisites

**Node.js 22 or newer**, a user-writable npm global prefix (do not install with `sudo` — same rule as the [local Quick Start](quickstart.md#0-prerequisites)), and **a Harper Fabric account** ([harperdb.io](https://www.harperdb.io/)). You need the org name, cluster name, and admin credentials for that account.

```bash
node --version   # v22.x.x or newer
npm i -g @tpsdev-ai/flair
```

Lead with environment credentials so they stay out of `ps` and shell history:

```bash
export FABRIC_USER=<admin>
export FABRIC_PASSWORD=<pass>
```

Scripting? Use `--fabric-password-file <path>` (mode `0600`) instead of `FABRIC_PASSWORD`. Inline `--fabric-password` works and leaks — do not lead with it.

`FABRIC_ORG` / `FABRIC_CLUSTER` can stand in for the flags below. `--fabric-token` is accepted but **fails** — Fabric `deploy_component` is Basic-auth only.

## 1. Deploy

```bash
# Validate args and package layout without deploying
flair deploy --fabric-org <org> --fabric-cluster <cluster> --dry-run

flair deploy --fabric-org <org> --fabric-cluster <cluster>
```

The target defaults to `https://<cluster>.<org>.harperfabric.com`. Override with `--target` if your instance URL is different. `flair deploy` writes `FLAIR_PUBLIC_URL` to that same origin so OAuth and A2A discovery do not advertise loopback.

## 2. What success looks like

```
→ Deploying flair to https://<cluster>.<org>.harperfabric.com

✓ Flair vX.Y.Z deployed and verified serving

  URL:     https://<cluster>.<org>.harperfabric.com
  Project: flair
```

A fleet-verify table follows. That HTTPS origin is your `FLAIR_URL`.

Then set an admin password in Fabric Studio (Cluster Settings → Admin). `flair agent add` against a remote instance requires `--admin-pass` — it will not reuse `~/.flair/admin-pass` or `FLAIR_ADMIN_PASS` from your laptop.

## 3. Register an agent against the remote instance

`flair agent add` takes a positional id and `--target`. There is no `--remote` flag on this command (`--remote` belongs to `flair init`).

On Fabric, ops lives on the **same hostname at port 9925**, not the CLI's default "data port − 1" derivation (that would be `:442`, where nothing answers). Pass `--ops-target` explicitly: <!-- docs-freshness-allow: Fabric ops API port, not legacy data port -->

```bash
export FLAIR_URL=https://<cluster>.<org>.harperfabric.com

# Fabric ops is :9925 on the same host, not derived :442. docs-freshness-allow: Fabric ops API
flair agent add mybot --target "$FLAIR_URL" --ops-target https://<cluster>.<org>.harperfabric.com:9925 --admin-pass <fabric-admin-password>
```

```
Keypair written: ~/.flair/keys/mybot.key
✅ Agent 'mybot' (mybot) registered (ops: https://<cluster>.<org>.harperfabric.com:9925) <!-- docs-freshness-allow: Fabric ops API -->
   Private key: ~/.flair/keys/mybot.key
```

The private key stays on **this machine**. The Fabric node stores only the public key.

## 4. Point the Cursor plugin at it

This is why Fabric is the recommended start for **Grok Bot / Cursor cloud agents**: they cannot see your laptop's `127.0.0.1:19926`.

In Cursor: **Plugins → Configure**

| Variable | Value |
|---|---|
| `FLAIR_URL` | `https://<cluster>.<org>.harperfabric.com` |
| `FLAIR_AGENT_ID` | `mybot` (the id you just added) |

Those are the two plugin schema fields. Local Cursor's `npx` can use the key from step 3 at `~/.flair/keys/mybot.key`. A cloud agent's `npx` runs on a different machine — that VM needs the key (or host-env admin credentials). See [`packages/cursor-flair/README.md`](../packages/cursor-flair/README.md).

## 5. Verify

```bash
flair status --target "$FLAIR_URL"
FLAIR_URL="$FLAIR_URL" flair memory add --agent mybot "Fabric Quick Start is reachable"
```

`flair memory add` has no `--target`; it honors `FLAIR_URL`. Then in Cursor:

> Load my Flair bootstrap, then store a test memory

You should see `bootstrap` return soul + memories, then `memory_store` confirm an id.

## What's next

Federation, pairing spokes, upgrades (`flair upgrade --target`), ports, and what you can observe without a shell on the node: **[docs/deploying-on-fabric.md](deploying-on-fabric.md)**.

Still on a laptop only, no public URL needed: **[docs/quickstart.md](quickstart.md)**.
