# Embedding Flair in a Harper app

Flair is a Harper component. If your app already runs on Harper, load Flair into the same instance and call it **in-process** — no HTTP, no second process, and **no shell on the node**.

Everything below is code you run inside your own component. The CLI is an alternative for local development, not a requirement — see [If you have shell access](#if-you-have-shell-access).

| | Embedded | Standalone ([deployment.md](deployment.md)) |
|---|---|---|
| Latency | A method call | HTTP round trip |
| Agent identity | You assert it per call | Ed25519 signature, verified server-side |
| Trust boundary | Callers are **inside** it | Callers are outside it, and must authenticate |

Embedding *adds* the in-process path; `rest: true` keeps serving MCP clients and remote agents as before.

---

## Quickstart

**1. Add Flair to your instance.** Deploy `@tpsdev-ai/flair` as a component the way you deploy your own — Fabric's component deploy, Studio, or your pipeline. Its tables are declared `@table(database: "flair")`, so they never collide with yours.

**2. Resolve the resource and write a memory.**

```javascript
import { server } from "harper";

// The RESOURCE — carries auth, scoping, visibility, embedding.
// NOT databases.flair.Memory: that is the raw table, and enforces none of it.
// Resolve lazily; Harper registers resources asynchronously.
const flair = (path) => server.resources.get(path).Resource;

// This context says WHICH agent is acting. Never omit it.
const asAgent = (agentId, { isAdmin = false } = {}) => ({
  request: { tpsAgent: agentId, tpsAgentIsAdmin: isAdmin },
});

export async function remember(agentId, content, opts = {}) {
  const h = new (flair("Memory"))(undefined, asAgent(agentId));
  h.isCollection = true;                    // collection POST
  return h.post({
    agentId,                                // required — an absent one is never filled in
    content,
    durability: opts.durability ?? "standard",
  });
}
```

> ### ⚠️ `new Memory()` with no context is an administrator
>
> A resource built without a context resolves to Flair's trusted `internal` verdict and runs **unfiltered** — every read unscoped, every write unowned. Silently. No error, no warning, no trace.
>
> Correct for Flair's own maintenance passes. In your app it is a data leak you find months later.
>
> **Make `agentId` a required argument, as above.** Never export a version that defaults it.

**3. Read it back, scoped to that agent.**

```javascript
export async function recall(agentId, query, limit = 5) {
  const h = new (flair("SemanticSearch"))(undefined, asAgent(agentId));
  return h.post({ q: query, limit });
}
```

**4. Verify it worked, still in-process.**

```javascript
await remember("agent-alpha", "deploy runs at 0200 UTC");
console.log(await recall("agent-alpha", "deploy schedule"));
console.log([...server.resources.keys()].sort());   // what Flair registered
```

> **Confirm the step-2 lookup on your own instance before building on it.** `server.resources` is a process-global registry keyed by REST path, leading slash stripped. That is read from Harper 5.1.22's source — not from a two-component integration we have run end to end. If `get` returns `undefined`, print the keys as above, or try `server.resources.getMatch("/Memory")`.

Handlers return a `Response` for `401`/`403`/`400` rather than throwing — check for one. `Memory.post()` is in-process only; over HTTP the schema exposes `PUT`.

---

## N agents in one process

**Acting as an agent needs nothing but the context.** Identity resolves per call from `request.tpsAgent`, so one process serves any number of agents — no client to construct, no key to load, no per-agent setup:

```javascript
for (const id of ["planner", "researcher", "reviewer"]) {
  await remember(id, `${id} came online`);
}
```

`tpsAgent` is **not** checked against the `Agent` table, so this works with no registration at all. Register agents anyway — the admin UI, federation, and the HTTP path all read those records.

### Registering agents, no CLI

Provisioning is the one place you write the **table** rather than the resource. Agent records are infrastructure, not agent-scoped data, and Flair's own just-in-time provisioning does exactly this (`resources/mcp-handler.ts`). The table applies no defaults, so supply the whole shape:

```javascript
import { databases } from "harper";

export async function registerAgent(id, { publicKey = "pending", admin = false } = {}) {
  const now = new Date().toISOString();
  await databases.flair.Agent.put({
    id, name: id, displayName: id,
    kind: "agent", type: "agent", status: "active",
    publicKey,                            // a placeholder is fine — see below
    defaultTrustTier: "unverified",
    admin,
    ...(admin ? { role: "admin" } : {}),  // role is what actually grants admin
    createdAt: now, updatedAt: now,
  });
}
```

> **`isAdmin()` reads `role === "admin"`, not the `admin` boolean.** They are separate fields and only `role` grants admin rights; set both to keep the record self-consistent. Admin lookups are cached for 60 seconds, so a newly-created admin is not effective immediately.

`publicKey` is non-nullable in the schema, but it does not have to be a real key. An agent that only ever acts in-process never authenticates, and Flair's own paths write placeholders — `"pending"` when seeding, `mcp-oauth:<sub>` for token-authenticated agents. Give an agent a real key only if it must also authenticate **over HTTP**, which your app can do without any CLI:

```javascript
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
await registerAgent("remote-worker", { publicKey: raw.toString("hex") });
// keep `privateKey` in your own secret store — Flair never sees it
```

Flair accepts the public key as 64-char hex, or base64 of the raw 32 bytes.

> **Two traps.** `Agent.put()` on the *resource* strips `publicKey` — key rotation goes through a dedicated path that today needs shell access, so set the key when you create the record. And do **not** call `AgentSeed` in-process: its `post()` requires `request.tpsAgent` to name a real admin, so a context-less internal call gets a 403.

---

## The table is not the resource

Flair declares `Memory` as a table, then exports a **subclass** as the resource. Harper's loader registers exported classes in the routing map only, never back into `databases`, so the two stay distinct:

| Import | What you get |
|---|---|
| `server.resources.get("Memory").Resource` | **The resource.** Auth, read-scoping, private-memory exclusion, no-forge attribution, embedding generation, default visibility, rate limiting. |
| `databases.flair.Memory` | **The table.** Raw storage. None of the above. |

Flair uses the raw table where it *wants* to bypass its own rules — the federation merge path writes through it so a synced record's origin stamp survives. Use it only for work you have authorised yourself: provisioning, migrations, admin sweeps, reporting. Never for a memory written on an agent's behalf.

---

## Identity

| Context | Verdict | Effect |
|---|---|---|
| `{ request: { tpsAnonymous: true } }` | `anonymous` | Denied everywhere |
| `{ request: { tpsAgent: "mybot" } }` | `agent` | Scoped to that agent — **use this** |
| `{ request: { tpsAgent: "mybot", tpsAgentIsAdmin: true } }` | admin | Unfiltered reads, cross-agent writes |
| **Nothing** | `internal` | **Trusted. Unfiltered.** See the warning above. |

**In-process callers are inside the trust boundary.** Ed25519 is how agents *outside* the process prove identity; a co-located component is trusted to declare it truthfully, so map your app's authenticated identity onto `tpsAgent` at the boundary. Treat `tpsAgentIsAdmin: true` as you would a root shell — reserve it for provisioning.

---

## Coexisting with your components

Flair's instance-wide middleware runs first but is **non-rejecting** — unrecognised requests pass through rather than 401'ing, so your component's auth keeps working. Two collisions to check:

- **`/Admin` is a prefix match.** Flair 401s any unauthenticated path *starting with* `/Admin` — including an app route like `/AdminPanel`. Rename yours.
- **Top-level paths.** Flair claims ~53, including `Memory`, `Agent`, `Instance`, `Integration`, `Credential`, `Health`, `Presence`, `Relationship`, `Soul`, `SemanticSearch`. `server.resources.keys()` lists them.

---

## Federation

Pairing an embedded instance to an external hub as a spoke **requires shell access today** — the pairing and sync commands are CLI-only. If your deployment has no shell, federation is not available to it yet.

> **Sync is push-only — one direction per call.** A spoke pushes its records up and **receives nothing back**. There is no pull endpoint, and nothing initiates a hub-to-spoke push. Do not plan on reading another instance's memories through the hub.
>
> For records both ways, each instance must pair **as a spoke of the other** — two pairings, each side running its own sync.

Private memories are never pushed. Full walkthrough: [federation.md](federation.md).

---

## If you have shell access

Local development and self-hosted installs can drive the same things from the CLI:

```bash
flair doctor
flair agent add mybot          # registers + generates and stores a keypair
flair agent list
flair memory search "deploy schedule" --agent mybot
```

Federation, which has no in-process equivalent:

```bash
flair federation token --admin-pass <hub-admin-pass> > triple.json
flair federation pair <hub-url> --token-from ./triple.json
flair federation sync enable --interval 300
flair federation status
```

`sync enable` landed **after 0.30.0**; on an older install, schedule the one-shot yourself.

A `SyncLog` row reads `direction: "pull"` — the receiver's label for a push it accepted. `"push"` is never written. Not a pull path.

---

## Choosing a surface

| Surface | Use when |
|---|---|
| **In-process resource** | Your app's agents, same instance. No round trip — and no auth safety net. |
| **[`@tpsdev-ai/flair-client`](https://www.npmjs.com/package/@tpsdev-ai/flair-client)** | Out of process: another host, runtime or sidecar. One client per `agentId`. |
| **Native `/mcp`** | MCP clients against this instance. Identity from the OAuth token. |
| **`@tpsdev-ai/flair-mcp`** (stdio) | Local MCP clients. Talks HTTP via `FlairClient`. |
| **`flair` CLI** | Pairing and key generation. Needs a shell. |

**Trust-graded recall (`includeTrust`)** — provenance, author, usage, freshness, supersession — works in-process (`SemanticSearch.post({ q, includeTrust: true })`, `Memory.get(id, { includeTrust: true })`), over REST, and on the native `/mcp` handler. It is **not** exposed by the CLI, the stdio MCP server, or `FlairClient`'s typed methods.

---

## See also

[Integrations](integrations.md) · [Deployment](deployment.md) · [Federation](federation.md) · [Auth](auth.md) · [Architecture](../DESIGN.md)
