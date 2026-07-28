# Embedding Flair in a Harper app

Flair is a Harper component. If your app already runs on Harper, load Flair into the same instance and call it **in-process** — no HTTP, no second process.

| | Embedded | Standalone ([deployment.md](deployment.md)) |
|---|---|---|
| Latency | A method call | HTTP round trip to your own box |
| Agent identity | You assert it per call | Ed25519 signature, verified server-side |
| Trust boundary | Callers are **inside** it | Callers are outside it, and must authenticate |

Embedding *adds* the in-process path. `rest: true` keeps serving MCP clients, the CLI and remote agents as before.

---

## Quickstart

**1. Add Flair to your instance.** On Fabric:

```bash
flair deploy --fabric-org <org> --fabric-cluster <cluster>
```

Self-hosted: install `@tpsdev-ai/flair` as a component the way you install your own. Its tables are declared `@table(database: "flair")`, so they never collide with yours.

**2. Check it loaded.**

```bash
curl -s localhost:19926/Health
flair doctor
```

**3. Register an agent.**

```bash
flair agent add mybot
flair agent list
```

**4. Write a memory from your component.**

```javascript
import { server } from "harper";

// The RESOURCE — carries auth, scoping, visibility, embedding.
// NOT databases.flair.Memory: that is the raw table, and enforces none of it.
// Resolve lazily; Harper registers resources asynchronously.
const flair = (path) => server.resources.get(path).Resource;

// This context says WHICH agent is acting. Never omit it.
const asAgent = (agentId) => ({ request: { tpsAgent: agentId } });

const Memory = flair("Memory");
const h = new Memory(undefined, asAgent("mybot"));
h.isCollection = true;                     // collection POST
await h.post({
  agentId: "mybot",                        // required — an absent one is never filled in
  content: "deploy runs at 0200 UTC",
  durability: "standard",
});
```

> ### ⚠️ `new Memory()` with no context is an administrator
>
> A resource built without a context resolves to Flair's trusted `internal` verdict and runs **unfiltered** — every read unscoped, every write unowned. Silently. No error, no warning, no trace.
>
> Correct for Flair's own maintenance passes. In your app it is a data leak you find months later.
>
> **Make the context a required argument in your wrapper.** Never export a version that defaults it.

**5. Read it back, scoped to that agent.**

```javascript
const SemanticSearch = flair("SemanticSearch");
const hits = await new SemanticSearch(undefined, asAgent("mybot"))
  .post({ q: "deploy schedule", limit: 5 });
```

**6. Confirm from outside the process.**

```bash
flair memory search "deploy schedule" --agent mybot
```

> **Confirm the step-4 lookup on your own instance before building on it.** `server.resources` is a process-global registry keyed by REST path, leading slash stripped. That is read from Harper 5.1.22's source — not from a two-component integration we have run end to end. If `get` returns `undefined`:
>
> ```javascript
> console.log([...server.resources.keys()]);   // or: server.resources.getMatch("/Memory")
> ```

Handlers return a `Response` for `401`/`403`/`400` rather than throwing — check for one. `Memory.post()` is in-process only; over HTTP the schema exposes `PUT`.

---

## The table is not the resource

Flair declares `Memory` as a table, then exports a **subclass** as the resource. Harper's loader registers exported classes in the routing map only, never back into `databases`, so the two stay distinct:

| Import | What you get |
|---|---|
| `server.resources.get("Memory").Resource` | **The resource.** Auth, read-scoping, private-memory exclusion, no-forge attribution, embedding generation, default visibility, rate limiting. |
| `databases.flair.Memory` | **The table.** Raw storage. None of the above. |

Flair uses the raw table where it *wants* to bypass its own rules — the federation merge path writes through it so a synced record's origin stamp survives. Use it only for work you have authorised yourself: migrations, admin sweeps, reporting.

---

## Identity

Flair resolves the acting agent from the context you pass:

| Context | Verdict | Effect |
|---|---|---|
| `{ request: { tpsAnonymous: true } }` | `anonymous` | Denied everywhere |
| `{ request: { tpsAgent: "mybot" } }` | `agent` | Scoped to that agent — **use this** |
| `{ request: { tpsAgent: "mybot", tpsAgentIsAdmin: true } }` | admin | Unfiltered reads, cross-agent writes |
| **Nothing** | `internal` | **Trusted. Unfiltered.** See the warning above. |

Many agents in one app: pass a different context per call, not a client per agent. (Over HTTP the unit is `FlairClient`, one `readonly agentId` each.)

**In-process callers are inside the trust boundary.** Ed25519 is how agents *outside* the process prove identity; a co-located component is trusted to declare it truthfully, so map your app's authenticated identity onto `tpsAgent` at the boundary. `tpsAgent` is not checked against the `Agent` table — register agents anyway, since federation and the HTTP path read those records.

---

## Coexisting with your components

Flair's instance-wide middleware runs first but is **non-rejecting** — unrecognised requests pass through rather than 401'ing, so your component's auth keeps working. Two collisions to check:

- **`/Admin` is a prefix match.** Flair 401s any unauthenticated path *starting with* `/Admin` — including an app route like `/AdminPanel`. Rename yours.
- **Top-level resource paths.** Flair claims ~53, including `Memory`, `Agent`, `Instance`, `Integration`, `Credential`, `Health`, `Presence`, `Relationship`, `Soul`, `SemanticSearch`. Conflicts usually surface as an error resource at the contested path, but rename first. List them after Flair loads:

```javascript
console.log([...server.resources.keys()].sort());
```

---

## Federation

Pair an embedded instance to an external hub as a spoke and contribute upward:

```bash
flair federation token --admin-pass <hub-admin-pass> > triple.json
flair federation pair <hub-url> --token-from ./triple.json
flair federation sync --admin-pass "$FLAIR_ADMIN_PASS"
```

> **Sync is push-only — one direction per call.** A spoke pushes its records up and **receives nothing back**. There is no pull endpoint, and nothing initiates a hub-to-spoke push. Do not plan on reading another instance's memories through the hub.
>
> For records both ways, each instance must pair **as a spoke of the other** — two pairings, each side running its own sync.

Private memories are never pushed. `flair federation sync` is one-shot, so install a driver:

```bash
flair federation sync enable --interval 300
flair federation status
flair federation reachability
```

`sync enable` landed **after 0.30.0**; on an older install, schedule the one-shot yourself. Full walkthrough: [federation.md](federation.md).

A `SyncLog` row reads `direction: "pull"` — the receiver's label for a push it accepted. `"push"` is never written. Not a pull path.

---

## Choosing a surface

| Surface | Use when |
|---|---|
| **In-process resource** | Your app's agents, same instance. No round trip — and no auth safety net. |
| **[`@tpsdev-ai/flair-client`](https://www.npmjs.com/package/@tpsdev-ai/flair-client)** | Out of process: another host, runtime or sidecar. One client per `agentId`. |
| **Native `/mcp`** | MCP clients against this instance. Identity from the OAuth token, never tool arguments. |
| **`@tpsdev-ai/flair-mcp`** (stdio) | Local MCP clients. Talks HTTP via `FlairClient`. |
| **`flair` CLI** | Operations, pairing, agent registration. |

**Trust-graded recall (`includeTrust`)** — provenance, author, usage, freshness, supersession — works in-process (`SemanticSearch.post({ q, includeTrust: true })`, `Memory.get(id, { includeTrust: true })`), over REST, and on the native `/mcp` handler. It is **not** exposed by the CLI, the stdio MCP server, or `FlairClient`'s typed methods.

---

## See also

[Integrations](integrations.md) · [Deployment](deployment.md) · [Federation](federation.md) · [Auth](auth.md) · [Architecture](../DESIGN.md)
