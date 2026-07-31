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

**2. Import the facade and write a memory.**

```javascript
import { server } from "harper";
import { Flair } from "@tpsdev-ai/flair";

const flair = new Flair(server);
const planner = flair.as("planner");

await planner.memory.write("deploy runs at 0200 UTC", { durability: "standard" });
```

That is the whole API. No deep import, no `server.resources`, no `.Resource`, no `collectionResource()`, no double-passing `agentId`. The facade stamps `agentId` from the handle's context onto the body internally — you pass it once, at `flair.as(id)`.

**3. Read it back, scoped to that agent.**

```javascript
const hits = await planner.recall("deploy schedule", { limit: 5 });
const record = await planner.memory.get(hits[0].id);
```

**4. Register an agent, no CLI.**

```javascript
await flair.admin.registerAgent("planner", { publicKey: "pending" });
```

> **`flair.admin` is a root shell.** Every call site is greppable via `git grep "flair.admin"`. Use for provisioning and maintenance only, never as a request handler's default.

**5. Verify it worked.**

```javascript
console.log(await planner.memory.search({ limit: 10 }));
console.log([...server.resources.keys()].sort());   // what Flair registered
```

---

## The facade

### `new Flair(server)`

One handle per Harper instance. Resolves resources lazily on first use — no lookup at construction time.

**The handle owns nothing.** It holds a reference to the Harper server the caller already owns and acquires no timers, connections, or file handles. There is no `close()` or `dispose()` method. If a future version acquires something releasable, that is a breaking change and will be versioned as one.

### `flair.as(agentId)`

Returns an `AgentHandle` scoped to that agent. The `agentId` is runtime-validated: missing, empty, blank, or non-string throws `InProcessContextError`.

```javascript
const planner = flair.as("planner");
planner.agentId;  // "planner"
```

**Security:** In-process identity is asserted, not verified — co-location IS the grant. Build the `agentId` from your own server-side state, never from request data. If an agent id can reach `flair.as()` from user input — a body field, a query param, a header you did not verify yourself — that is privilege escalation with **no error, no 403 and no trace**.

### `AgentHandle`

| Method | Description |
|---|---|
| `handle.memory.write(content, opts?)` | Write a memory as this agent. `agentId` is stamped from the handle — the caller never passes it. |
| `handle.memory.get(id)` | Read a memory by id, scoped to this agent. |
| `handle.memory.search(opts?)` | Search memories scoped to this agent. |
| `handle.recall(query, opts?)` | Semantic search scoped to this agent. |

### `flair.admin`

Admin operations — unfiltered reads, cross-agent writes. Every call site is greppable via `git grep "flair.admin"`.

**The handle is cached** — `flair.admin === flair.admin` is `true`. Access it once and reuse the reference, or access it inline; either is fine.

| Method | Description |
|---|---|
| `flair.admin.registerAgent(id, opts?)` | Register an agent through the Agent resource (full Principal shape). |
| `flair.admin.memory.get(id)` | Read any memory by id, unfiltered. |
| `flair.admin.memory.write(asAgentId, content, opts?)` | Write a memory attributed to another agent. |

### `flair.internal`

Trusted, unattributed, unfiltered operations — Flair's `internal` verdict. Every call site is greppable via `git grep "flair.internal"`.

| Method | Description |
|---|---|
| `flair.internal.agentTable.put(record)` | Write directly to the Agent resource (bypasses admin gate). |

---

## N agents in one process

**Acting as an agent needs nothing but the context.** Identity resolves per call from `request.tpsAgent`, so one process serves any number of agents — no client to construct, no key to load, no per-agent setup:

```javascript
for (const id of ["planner", "researcher", "reviewer"]) {
  const agent = flair.as(id);
  await agent.memory.write(`${id} came online`);
}
```

`tpsAgent` is **not** checked against the `Agent` table, so this works with no registration at all. Register agents anyway — the admin UI, federation, and the HTTP path all read those records.

### Registering agents, no CLI

Go through `flair.admin.registerAgent()` — it goes through the `Agent` **resource**, which fills in the whole Principal shape for you:

```javascript
await flair.admin.registerAgent("researcher", {
  publicKey: "pending",
  displayName: "Research Agent",
  admin: false,
});
```

Verified against a real instance: that lands `kind: "agent"`, `status: "active"`, `displayName`, `admin: false`, `defaultTrustTier: "unverified"`, `type: "agent"`, `createdAt`/`updatedAt` and the federation `originatorInstanceId` stamp — without you naming any of them.

> **Prefer this to `databases.flair.Agent.put()`.** The raw table applies **no** defaults, so a hand-written literal has to reproduce every field above and then stay in step with Flair as the Principal model grows. Records written that way are missing `kind`/`status`/`defaultTrustTier` and read as under-specified Principals in the admin surfaces.

> **Admin is one meaning with one answer.** `role === "admin"` is the authority; the `admin` boolean is a mirror of it that the server maintains. Write **either** through the `Agent` resource and both are set — you no longer have to know which one is real, and a record cannot be stored saying one thing in one field and the opposite in the other. Nothing reads the mirror to make an authorization decision, and a promotion applied through the resource takes effect on the next request rather than after the 60-second admin-lookup cache expires.
>
> A record written straight to the table (`databases.flair.Agent.put()`, an ops-API insert, a federation merge) skips that reconciliation and can still carry a mismatch. `flair principal show` and the admin dashboard flag such a record rather than silently picking a side; re-issuing the grant repairs it.

`publicKey` is non-nullable in the schema, but it does not have to be a real key. An agent that only ever acts in-process never authenticates, and Flair's own paths write placeholders — `"pending"` when seeding, `mcp-oauth:<sub>` for token-authenticated agents. Give an agent a real key only if it must also authenticate **over HTTP**, which your app can do without any CLI:

```javascript
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
await flair.admin.registerAgent("remote-worker", { publicKey: raw.toString("hex") });
// keep `privateKey` in your own secret store — Flair never sees it
```

Flair accepts the public key as 64-char hex, or base64 of the raw 32 bytes.

Both verified end to end: an agent registered this way, with a key its app minted, then authenticated over HTTP with a real `TPS-Ed25519` signature — and a request signed with the *wrong* key was rejected.

> **Two traps.** `Agent.put()` on the *resource* silently strips `publicKey`, so set the key when you **create** the record; to rotate one later, write `databases.flair.Agent.put({ ...existing, publicKey })` on the raw table (which is what `flair agent rotate-key` does through the admin ops API — there is no dedicated endpoint today). And do **not** call `AgentSeed` in-process: although its `allowCreate()` explicitly permits the trusted `internal` verdict, its `post()` then re-checks for a named admin and returns `403 forbidden: admin only` — confirmed by running it.

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
| **Nothing**, or an empty/missing `tpsAgent` | `internal` | **Trusted. Unfiltered.** See the warning above. |

Build these with `agentContext(id)`, `adminContext(id)` and `internalContext()` rather than by hand — see [below](#the-api-is-built-so-omission-cannot-happen-quietly) for why the hand-written form is a trap.

### The context object is a security boundary

**In-process identity is asserted, not verified.** Flair reads `request.tpsAgent` and acts as that agent. There is no signature check, no lookup against the `Agent` table, and no registration requirement — an id that has never been registered acts as an agent immediately. `tpsAgentIsAdmin: true` is asserted exactly the same way, and nothing checks that the named agent is really an admin.

That is deliberate. A co-located caller is already inside the trust boundary and could write `databases.flair.Memory` directly, so demanding a signature from same-process code would be theatre. Ed25519 is how agents *outside* the process prove identity.

The consequence is the single most important line in this guide:

> **Build the context from your own server-side state. Never from request data.**
>
> If an agent id can reach `agentContext()` from user input — a body field, a query param, a header you did not verify yourself — that is privilege escalation with **no error, no 403 and no trace**. Authenticate the caller with your own mechanism first, then map the identity *you* established onto `tpsAgent`.

There are exactly two ways to lose the model, from opposite ends. Both are pinned as tests in the Flair repo:

| | |
|---|---|
| **By omission** | No usable agent id ⇒ `internal` ⇒ admin-equivalent, unfiltered. |
| **By assertion** | An attacker-influenced `agentId` is honoured verbatim. |

### The API is built so omission cannot happen quietly

`resolveAgentAuth` tests `tpsAgent` for *truthiness*, so a missing or empty id is indistinguishable from "no identity supplied" — which is the trusted, unfiltered verdict. Measured:

```
resolveAgentAuth({ request: { tpsAgent: undefined } })  ->  { kind: "internal" }
allowAdmin({ request: { tpsAgent: undefined } })        ->  true
```

That would turn the most ordinary bug there is — `agentContext(session.agentId)` where the field came back undefined — into silent administrator access. So the helpers refuse rather than default:

| | |
|---|---|
| `agentContext(id)` | **Throws** `InProcessContextError` on a missing, empty or blank id. Takes **no options**, so no object spread into it can escalate. |
| `adminContext(id)` | The *only* way to get admin authority. Same id guard. |
| `internalContext()` | The *only* way to get the unfiltered verdict. |
| `collectionResource(Cls, context)` | Context is **required**; omitting it throws rather than granting `internal`. |

The privileged paths are now the longest ones to type, and `git grep "adminContext\|internalContext"` enumerates every deliberate escalation in your codebase. These are runtime guards, not type annotations — a plain-JavaScript embedder gets exactly the same protection.

### Individual identities, not one app identity

Give every agent its own. A per-agent context costs nothing — no client to construct, no key to load, no per-agent setup, not even a registration. Collapsing N agents onto one shared identity buys you nothing and loses the two things that make the memory model work: **per-agent attribution**, which is what trust grading and provenance are computed from, and **N separate blast radii**, which become one.

### In a cluster

Harper replicates every table in a replicated database unless the table opts out with `@table(replicate: false)`. None of Flair's do. So:

- **The registry replicates.** An agent registered on node A is visible on node B with no coordination. (Replication comes from the *database* being replicated — not from `@export`, which only controls REST exposure. `Memory` carries no `@export` and still replicates.)
- **Authority is local.** The context is constructed per call, in whichever process handles it. No node asks another who a caller is.
- **Attribution travels.** `agentId` is a field *on the record*, so a memory written on node A reads back correctly attributed — and correctly scoped — wherever it lands. Verified as far as this can be without a cluster: a fresh Harper process over the same storage resolves identical per-agent scope, so none of it lives in the process that did the writing.

The consequence, stated plainly because someone will ask: **every node running the app is equally trusted**, since each one can assert any identity. That is fine for one application spread across regions — it is a single trust domain by construction. It is **not** fine for running this component beside untrusted co-tenants on the same instance. Co-location *is* the grant.

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

## Appendix: the primitives layer

The facade wraps a lower-level API that is still available for callers who need direct access. Import it from `@tpsdev-ai/flair/server`:

```javascript
import { agentContext, adminContext, internalContext, collectionResource } from "@tpsdev-ai/flair/server";
```

This is the same seam Flair's own MCP handler and internal tooling use. **You should not need it for ordinary agent operations** — the facade covers those. Reach for the primitives when you are building your own abstraction on top of Flair's resources, or when you need the context helpers (`agentContext`, `adminContext`, `internalContext`) to pass into a resource call directly.

### Resolving a resource

```javascript
// The RESOURCE — carries auth, scoping, visibility, embedding.
// NOT databases.flair.Memory: that is the raw table, and enforces none of it.
// Keys carry NO leading slash: get("Memory"), never get("/Memory").
const flair = (path) => server.resources.get(path).Resource;
```

### Writing a memory (primitives)

```javascript
export async function remember(agentId, content, opts = {}) {
  // A create needs a COLLECTION-bound instance. `new Cls(...)` does not give
  // you one, and cannot be made to — see the note below.
  const h = await collectionResource(flair("Memory"), agentContext(agentId));
  return h.post({
    agentId,                                // required — an absent one is never filled in
    content,
    durability: opts.durability ?? "standard",
  });
}
```

> ### Why `collectionResource`, and not `new Memory()`
>
> A resource's `post()` only works on an instance Harper has marked as a **collection**, and that mark is a *private* field only Harper's own `getResource()` can set. The public `isCollection` is a getter with no setter, so the obvious spelling fails two different ways, neither of which names the cause:
>
> ```javascript
> const h = new (flair("Memory"))(undefined, agentContext(agentId));
> h.isCollection = true;   // TypeError: Cannot set property isCollection ... which has only a getter
> h.post({ ... });         // without the line above: 405 "The Memory does not have a post method implemented"
> ```
>
> `collectionResource(Cls, context)` is a two-line wrapper over the supported call — `Cls.getResource({}, context, { isCollection: true })` — and exists so this is written once. **Reads do not need it:** `Cls.get(id, context)` and `Cls.search(query, context)` thread the context themselves.
>
> They do still need the **context**. Only the collection binding is unnecessary for a read, never the identity — `Cls.search(query)` with the second argument left off resolves to the trusted `internal` verdict when it runs outside a request scope (a boot hook, a timer, a queue worker, a detached promise) and returns every agent's private records. On that path the resource's `allow*` gate is not consulted at all. Pass the context to every call, read and write.

> ### ⚠️ A resource with no context is an administrator
>
> A resource built without a context resolves to Flair's trusted `internal` verdict and runs **unfiltered** — every read unscoped, every write unowned. Silently. No error, no warning, no trace.
>
> Measured, not inferred: a context-less `Memory.search()` returns every agent's `private` records, and so does a context-less `SemanticSearch`.
>
> Correct for Flair's own maintenance passes. In your app it is a data leak you find months later.
>
> **Make `agentId` a required argument, as above.** Never export a version that defaults it.

### Reading back (primitives)

```javascript
export async function recall(agentId, query, limit = 5) {
  const h = await collectionResource(flair("SemanticSearch"), agentContext(agentId));
  return h.post({ q: query, limit });
}
```

### Registering agents (primitives)

```javascript
export async function registerAgent(id, { publicKey = "pending", admin = false } = {}) {
  const h = await collectionResource(flair("Agent"), internalContext());   // provisioning is infrastructure, not an agent's write
  return h.post({
    id, name: id, displayName: id,
    publicKey,                            // a placeholder is fine — see below
    runtime: "headless",
    ...(admin ? { admin: true } : {}),    // sets role:"admin" too — see below
  });
}
```

### What we measured, so you do not have to

Run end to end on **Harper 5.1.22**, from a second component loaded into the same instance — the exact shape above. `test/integration/in-process-agents.test.ts` in the Flair repo is that run, and `test/fixtures/inproc-app` is the component it drives.

| Claim | Result |
|---|---|
| `server.resources.get("Memory")` from another component | Returns an **entry object** `{ Resource, path, exportTypes, hasSubPaths, relativeURL }` — `.Resource` is required, it is not the class itself |
| `.Resource` is Flair's resource, not the raw table | Confirmed: prototype chain `Memory → Memory → Resource`, and it is **not** `databases.flair.Memory` |
| Key format | **No leading slash.** `get("Memory")` hits; `get("/Memory")` returns `undefined` |
| `getMatch` | `getMatch("Memory")` hits. **`getMatch("/Memory")` misses** — do not use the slashed form |
| When the lookup becomes valid | Flair's resources were already registered at the app component's **module top level** (55 entries, `Memory` and `Agent` present). The only entry missing at that moment was the app's *own*, still mid-registration. Resolving lazily, as above, is still the advice — it costs nothing and does not depend on component load order |
| Per-agent scoping through `SemanticSearch` | Holds. Querying as `agent-beta` for a topic only `agent-alpha` has written returns **beta's own** memory, never alpha's private one — with real 768-dim embeddings attached, not a degraded path |
| Cross-agent by-id read | `Memory.get(<beta's private id>)` as alpha returns **404**, never 403 — a denied caller cannot enumerate ids |
| Context-less call | Unfiltered across all agents, via both `search` and `SemanticSearch` (see the warning above) |

Handlers return a `Response` for `401`/`403`/`400` rather than throwing — check for one. `Memory.post()` is in-process only; over HTTP the schema exposes `PUT`.

---

## See also

[Integrations](integrations.md) · [Deployment](deployment.md) · [Federation](federation.md) · [Auth](auth.md) · [Architecture](../DESIGN.md)
