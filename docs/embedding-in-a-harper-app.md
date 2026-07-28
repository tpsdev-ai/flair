# Embedding Flair in a Harper app

Flair *is* a Harper component. If your application already runs on Harper, you can load Flair into the same instance and reach it **in-process** — a direct method call, no HTTP, no second process, no network hop.

This guide covers the embedded case. For the standalone install (`flair init`, its own Harper, reached over HTTP) see [deployment.md](deployment.md); for the harness integrations that all speak HTTP, see [integrations.md](integrations.md).

> **The one thing to get right.** `databases.flair.Memory` is the **table**. The exported `Memory` class is the **resource**, and the resource is where authentication, read-scoping, visibility defaults and embedding generation live. Calling the table gets you storage without the rules, and nothing will tell you — see [The table is not the resource](#the-table-is-not-the-resource).

---

## When to embed

| | Embedded (in-process) | Standalone (HTTP) |
|---|---|---|
| **Your app runs on Harper** | Yes — this is the case for it | Works, but you pay a network hop to your own box |
| **Latency** | A method call | HTTP round trip per operation |
| **Agent identity** | You assert it per call (see [Multi-agent identity](#multi-agent-identity-in-one-app)) | Ed25519 signature per request, verified server-side |
| **Trust boundary** | In-process callers are **inside** it | Every caller is outside it and must authenticate |
| **Operational surface** | One process, one lifecycle | Two processes to supervise |
| **Other clients (MCP, n8n, other hosts)** | Still work — `rest: true` serves them | Same |

Embedding is the right call when your app already owns a Harper instance and its agents are in the same process. It is the wrong call when memory needs to outlive or scale independently of your app, when you want agents on other hosts as first-class writers, or when you'd rather not couple your deploy cadence to Flair's — take the [HTTP client](#the-other-surfaces) then.

**Embedding does not turn the HTTP surface off.** Flair's `config.yaml` sets `rest: true`, so the same instance still serves `/Memory`, `/SemanticSearch`, `/mcp` and the rest to external clients. Embedding adds an in-process path; it removes nothing.

---

## Adding Flair to an existing Harper instance

Flair ships as an ordinary Harper component. Its `config.yaml` declares:

```yaml
name: flair
rest: true

graphqlSchema:
  files: schemas/*.graphql

jsResource:
  files: dist/resources/*.js
```

Its tables are declared `@table(database: "flair")`, so they land in a **`flair` database** of their own and never collide with your app's tables.

**On Harper Fabric**, push it as a component:

```bash
flair deploy --fabric-org <org> --fabric-cluster <cluster>
```

See [deployment.md — Harper Fabric](deployment.md#harper-fabric) and [upgrade.md](upgrade.md) for the in-place upgrade path.

**On a self-hosted Harper**, install `@tpsdev-ai/flair` as a component of the instance by the same mechanism you use for your own components (Harper's `deploy_component` operation, or a component entry in the instance-root config).

### Coexistence is designed for, not incidental

Flair registers one instance-wide HTTP middleware with `{ runFirst: true }`. It is deliberately **non-rejecting**: a request it does not recognise is annotated anonymous and passed through rather than 401'd, precisely so a sibling component's own auth keeps working on a shared Harper. Enforcement lives in each Flair resource's `allow*` method, not in the gate. From `resources/auth-middleware.ts`:

> the gate no longer 401s instance-wide, which was breaking sibling components on a shared Harper / composite hub

Two things to check against your app before you deploy:

**1. Resource path collisions.** Flair claims these top-level REST paths, one per exported resource class:

`Admin` · `AdminConnectors` · `AdminDashboard` · `AdminIdp` · `AdminInstance` · `AdminMemory` · `AdminPrincipals` · `Agent` · `AgentCard` · `AgentSeed` · `AttentionQuery` · `BootstrapMemories` · `ConsolidateMemories` · `Credential` · `FederationInstance` · `FederationPair` · `FederationPeers` · `FederationSync` · `FeedMemories` · `FeedSouls` · `Health` · `HealthDetail` · `IdpConfig` · `Instance` · `Integration` · `MCPClientMetadata` · `Memory` · `MemoryCandidate` · `MemoryDedupStats` · `MemoryGrant` · `MemoryMaintenance` · `MemoryReindex` · `MemoryUsage` · `OAuthAuthorize` · `OAuthClient` · `OAuthMetadata` · `OAuthRegister` · `OAuthRevoke` · `OAuthToken` · `OrgEvent` · `OrgEventCatchup` · `OrgEventMaintenance` · `PairingToken` · `Peer` · `Presence` · `RecordUsage` · `ReflectMemories` · `Relationship` · `SemanticSearch` · `SkillScan` · `Soul` · `WorkspaceLatest` · `WorkspaceState`

When two components register different tables at the same path, Harper logs the conflict and installs an error resource there — so a collision usually fails loudly rather than silently. It still fails your route, so rename first.

**2. The `/Admin` prefix.** Flair's middleware returns `401` with a `WWW-Authenticate: Basic` challenge for any unauthenticated request whose path *starts with* `/Admin`. That is a prefix match, so an app route like `/AdminPanel` is caught by it. Rename such routes, or put your admin surface on a different prefix.

---

## In-process access

### The table is not the resource

This is the sharpest edge in the whole integration, and getting it wrong is silent.

Flair declares `Memory` as a Harper table and then exports a **subclass** of it as the resource:

```typescript
// resources/Memory.ts
export class Memory extends (databases as any).flair.Memory { … }
```

Harper's `jsResource` loader takes each exported class and registers it in the **routing map** only. It never writes back into `databases` or `tables`. So after load:

- `databases.flair.Memory` — still the **base table**. Raw storage.
- the exported `Memory` class — the **resource**, registered at path `Memory`.

They are two different class objects, and Flair depends on that. It uses the raw table on purpose where it wants to bypass its own rules — the federation merge path writes incoming records via `databases.flair.Memory.put(...)` specifically so a synced record's origin stamp is not clobbered.

What you lose by calling the table directly:

| Enforced by the resource class | Not enforced by the table |
|---|---|
| Anonymous callers denied (`allowRead`, and inline checks in `post`/`put`/`delete`) | — |
| Read scoping — own memories plus granted owners' shared ones | — |
| `visibility: private` exclusion on cross-agent reads | — |
| No-forge attribution (a mismatched `agentId` is rejected) | — |
| Embedding generation on write | — |
| Default visibility by durability | — |
| Rate limiting, content-safety scan, entity-vocabulary gate | — |
| Duplicate-signal computation | — |

Flair's own schema records what happens when a table gets a REST surface without its resource class. `MemoryCandidate` shipped without `@export`, and the fix note explains why `@export` alone was not the answer:

> `@export` alone would have reopened the exact P0 leak the memory-soul-read-gate family fix closed for every other agent-facing table (anonymous read/write of every row); see `resources/MemoryCandidate.ts` for the paired identity-gated, owner-scoped resource class that makes `@export` here safe.

`Memory` itself carries **no** `@export` for the same reason — its entire public surface is the resource class.

**Use the table only for genuinely unscoped work you have authorised yourself** — bulk reporting, a migration, an admin sweep. For anything acting on behalf of an agent, use the resource.

### Getting the resource class

Harper's module surface has no `databases.flair.<Resource>` lookup for resource classes — `databases` and `tables` are data handles. Resource classes live in the server's resource registry, keyed by **REST path**:

```javascript
import { server } from "harper";

const entry = server.resources.get("Memory");   // note: no leading slash
const Memory = entry.Resource;                  // Flair's resource subclass
```

Two rules for this lookup:

- **Resolve it lazily, at call time — not at module load.** Harper registers resources asynchronously, and its own source notes there is no reliable "all resources registered" moment to hook. A sibling component that grabs the class at import time may well run before Flair has registered.
- **The key is the path, leading slash stripped.** `Resources.set()` normalises `/Memory` to `Memory`. If a lookup returns `undefined`, enumerate `server.resources.keys()` to see what actually registered.

> **Verify this lookup once on your instance.** The registry is a Harper-internal singleton shared across components, and the reasoning above is drawn from Harper 5.1.22's source rather than from a cross-component integration we have run end to end. The in-process *call* pattern below is production code inside Flair; the cross-component *lookup* is the part to confirm on your own deployment before you build on it. `server.resources.getMatch("/Memory")` is the routing-aware alternative if the plain `get` surprises you.

### A worked example

Flair calls its own resources this way in production — the native `/mcp` handler (`resources/mcp-tools.ts`) is the reference implementation, and every snippet below mirrors it.

```javascript
import { server } from "harper";

/**
 * Build the context a Flair resource reads identity from.
 * A plain object with no getContext() method: Harper's Resource
 * constructor stores it directly, so getContext() returns it as-is.
 */
function flairContext(agentId, { isAdmin = false } = {}) {
  return {
    request: {
      tpsAgent: agentId,
      tpsAgentIsAdmin: isAdmin,
      headers: {
        get: (k) => (k.toLowerCase() === "x-tps-agent" ? agentId : undefined),
      },
    },
    user: undefined,
  };
}

const resource = (path) => {
  const entry = server.resources.get(path);
  if (!entry) throw new Error(`Flair resource '${path}' is not registered yet`);
  return entry.Resource;
};

// ── Write a memory as a specific agent ──────────────────────────────
async function remember(agentId, content, opts = {}) {
  const Memory = resource("Memory");
  const h = new Memory(undefined, flairContext(agentId));
  h.isCollection = true;                    // collection POST, as mcp-tools does
  return h.post({
    agentId,                                // required — see below
    content,
    type: opts.type ?? "session",
    durability: opts.durability ?? "standard",
    tags: opts.tags,
  });
}

// ── Semantic search, scoped to that agent ───────────────────────────
async function recall(agentId, query, limit = 5) {
  const SemanticSearch = resource("SemanticSearch");
  const h = new SemanticSearch(undefined, flairContext(agentId));
  return h.post({ q: query, limit });
}

// ── Read one memory by id (404s if it isn't readable by this agent) ─
async function getMemory(agentId, id) {
  const Memory = resource("Memory");
  const h = new Memory(undefined, flairContext(agentId));
  return h.get(id);
}
```

Notes that will save you a debugging session:

- **`agentId` must be in the write body.** Flair's attribution mode for `Memory.post` is *validate-truthy*: a **present and mismatched** `agentId` is rejected, but an **absent** one is never filled in — the caller is expected to set it. Omit it on a trusted internal call and you write a memory with no owner.
- **`Memory.post()` is in-process only.** The schema exposes `PUT` over HTTP; a raw `POST /Memory` returns *"Memory does not have a post method implemented"*. `post()` is reachable exactly the way shown above.
- **Handlers may return a `Response`.** The `401`/`403`/`400` guards return one rather than throwing. Check for it — `mcp-tools.ts`'s `unwrap()` is the pattern.
- **Default visibility is keyed to durability.** `permanent` and `persistent` default to `shared`; `standard`, `ephemeral` and absent default to `private`. Set `visibility` explicitly to override.

---

## Multi-agent identity in one app

Over HTTP, identity is cryptographic: each agent holds an Ed25519 key and signs every request, and `FlairClient` carries a `readonly agentId` — **one client instance, one agent**. For many agents you construct many clients.

In-process there is no signature to verify, because there is no request to sign. Identity is **asserted by the context you pass**, and Flair resolves it in this order:

| Context you pass | Verdict | Effect |
|---|---|---|
| `{ request: { tpsAnonymous: true } }` | `anonymous` | **Denied** on every agent-facing path |
| `{ request: { tpsAgent: "<id>" } }` | `agent` | Scoped to that agent — **this is the one you want** |
| `{ request: { tpsAgent: "<id>", tpsAgentIsAdmin: true } }` | `agent` (admin) | Unfiltered reads, cross-agent writes |
| A real HTTP request with an `Authorization` header | `agent` | Signature verified, as over the network |
| **Nothing at all** | **`internal`** | **Trusted. Unfiltered. Rules skipped.** |

> **Read that last row twice.** A resource instantiated with no context — `new Memory()` — resolves to `internal`, which Flair treats as a trusted in-process call and runs **unfiltered**, exactly as it treats an admin. Flair's own test suite states the invariant directly: *"ctxRequest === undefined simulates a true internal call: `getContext()` itself returns `undefined`, which `resolveAgentAuth(undefined)` resolves to `{ kind: "internal" }`."* This is correct and deliberate for Flair's internal maintenance passes. It is a trap for an embedding application: forget the context and every agent in your app reads and writes as if it were an administrator, with no error, no warning, and no trace. Months later the memories turn out never to have been scoped.
>
> Make the context non-optional in your own wrapper — the `remember`/`recall` helpers above take `agentId` as their first positional argument for exactly this reason. Do not export a version that defaults it.

So the honest statement of the model: **in-process callers are inside Flair's trust boundary.** Ed25519 is what agents *outside* the process use to prove who they are; a co-located component is trusted to declare it truthfully, the same way the native `/mcp` handler is trusted to pass through the agent it resolved from a verified OAuth token. If your app's agents are separately authenticated to *your* app, map that identity to `tpsAgent` at the boundary and you keep per-agent attribution end to end. If they are not, you do not have per-agent identity to assert, and every memory in the instance is effectively written by one principal.

**Agents still need `Agent` records** for the things that read them — admin listings, federation, and the HTTP path if any agent also connects that way. Register them with `flair agent add <id>` or by writing the `Agent` resource. Note that a purely in-process `tpsAgent` assertion is *not* checked against the `Agent` table by `resolveAgentAuth`.

Attribution, once asserted, behaves exactly as it does over HTTP: memories carry their author, read scoping is open-within-org for non-private memories, and `visibility: private` stays owner-only. See [auth.md](auth.md#auth-across-surfaces-read-this-first) for the full cross-surface model.

---

## Federation: contributing to an external hub

An embedded instance can pair to an external Flair hub as a **spoke** and contribute its memories upward. Pairing and sync are unchanged by embedding — see [federation.md](federation.md) for the full walkthrough and [spoke-bringup.md](spoke-bringup.md) for a checklist.

```bash
# On the hub: mint a one-time pairing token triple
flair federation token --admin-pass <hub-admin-pass> > triple.json

# On the embedded instance: pair as a spoke, then sync
flair federation pair <hub-url> --token-from ./triple.json --admin-pass "$FLAIR_ADMIN_PASS"
flair federation sync --admin-pass "$FLAIR_ADMIN_PASS"
```

> **Federation sync is push-only — one direction per call.** A spoke pushes its own new and updated records to its hub. The hub's response carries counters, never records. **There is no pull endpoint anywhere in Flair**, and nothing initiates a hub→spoke push: the sync driver targets only the peer it has recorded with `role: "hub"`, and a hub has no such peer among its spokes.
>
> So an embedded instance paired as a spoke **contributes memories up and receives nothing down**. Do not plan on reading another instance's memories through the hub.
>
> If you need records flowing both ways, each instance must pair **as a spoke of the other** — two pairings, two tokens, each side running its own sync. That is how Flair's own mixed-version compatibility suite drives a bidirectional round trip.

Two further limits worth knowing before you design around it:

- **Private memories are never pushed.** The sync filter excludes them by visibility. Federation is the hard trust boundary; intra-instance reads are not.
- **Sync needs a driver.** `flair federation sync` is one-shot and `flair federation watch` only lives as long as its terminal. `flair federation sync enable` installs a scheduled periodic one-shot (launchd on macOS, a systemd user timer on Linux; default 300s, `--interval` to change), and `flair federation status` will tell you whether anything is actually driving sync. **`sync enable` landed after 0.30.0** — on an older install, check `flair federation sync --help` and schedule `flair federation sync` yourself until you upgrade.

Also note that a `SyncLog` row records `direction: "pull"`. That is the **receiver's** label for a push it accepted — every row in the system carries it, and `"push"` is never written. It is not evidence of a pull path.

---

## The other surfaces

Embedding does not replace the other ways in. Pick per caller, not per deployment:

| Surface | Transport | Use it when |
|---|---|---|
| **In-process resource class** | Method call | Your app runs on the same Harper instance. Lowest latency, no auth round trip — and no auth safety net. |
| **`FlairClient`** ([`@tpsdev-ai/flair-client`](https://www.npmjs.com/package/@tpsdev-ai/flair-client)) | HTTP + Ed25519 | Anything out of process: another host, another runtime, a sidecar, an agent that must authenticate as itself. One client per `agentId`. |
| **Native `/mcp` handler** | HTTP JSON-RPC, OAuth | MCP clients talking to this instance directly. 12 curated tools; identity resolved from the token, never from tool arguments. |
| **`@tpsdev-ai/flair-mcp`** (stdio) | stdio → HTTP | Local MCP clients. A separate published package that talks to Flair over HTTP via `FlairClient`. |
| **`flair` CLI** | HTTP | Operations, pairing, agent registration, maintenance. |

Rule of thumb: **in-process for your own app's agents, `FlairClient` for everything else.** Reaching your own instance over HTTP from inside it works and is easier to reason about — take that as a starting point if you want the auth model enforced rather than asserted, and move to in-process when the round trip actually costs you.

### Trust-graded recall (`includeTrust`)

The opt-in trust-evidence block — provenance, author, usage, freshness, supersession — is **not available on every surface**. As shipped it is reachable from:

- the **in-process resource path** — `SemanticSearch.post({ q, includeTrust: true })`, and `Memory.get(id, { includeTrust: true })`
- **REST** — `GET /Memory/<id>?includeTrust=true`, and `includeTrust` in the `POST /SemanticSearch` body
- the **native `/mcp` handler** — `includeTrust` on `memory_search`, `memory_get` and `bootstrap`

It is **not** exposed by the `flair` CLI, by the stdio `@tpsdev-ai/flair-mcp` server, or by `FlairClient`'s typed methods. If trust-graded recall matters to your app, that is an argument for the in-process path.

---

## See also

- [Integrations](integrations.md) — every harness Flair already runs in
- [Deployment](deployment.md) — standalone installs, Fabric, configuration
- [Federation](federation.md) — pairing, sync driver, security model
- [Auth](auth.md) — the identity model across every surface
- [Architecture](../DESIGN.md) — how the pieces fit
