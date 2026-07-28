/**
 * ─── The in-process call seam (one incantation, one place) ───────────────────
 *
 * How code running INSIDE the Harper process invokes a flair resource AS a
 * specific agent — flair's own native MCP handler (resources/mcp-tools.ts), and
 * any co-located application component that loads flair as a sub-component and
 * calls it directly instead of over HTTP.
 *
 * Two things an in-process caller has to get right, both of which are invisible
 * from a resource's own source and neither of which fails in a way that points
 * at the cause:
 *
 * 1. **Identity.** Every flair resource resolves its caller through
 *    resources/agent-auth.ts's `resolveAgentAuth()`, whose FIRST hop is the
 *    `tpsAgent` annotation the HTTP auth middleware stamps on a verified
 *    request. There is no HTTP request in-process, so the caller supplies that
 *    annotation itself — that is `agentContext()` below. A caller that supplies
 *    NOTHING resolves to the trusted `internal` verdict, which reads and writes
 *    UNFILTERED (see `agentContext`'s doc — this is the whole hazard).
 *
 * 2. **Collection binding.** A resource's `post()` — the create path — only
 *    works on a resource instance Harper has marked as a COLLECTION. That mark
 *    is a PRIVATE field (`#isCollection`) set inside Harper's own
 *    `getResource()`; the public `isCollection` is a GETTER WITH NO SETTER on
 *    `Resource.prototype`. So the obvious `new Cls(undefined, ctx)` +
 *    `h.isCollection = true` does not "not work" quietly — under ESM (always
 *    strict mode) the assignment throws
 *    `TypeError: Cannot set property isCollection ... which has only a getter`,
 *    and dropping the assignment instead yields
 *    `405 The <X> does not have a post method implemented` from Harper's base
 *    `Resource.post()`. `collectionResource()` below is the one supported way
 *    in: hand `getResource()` an `{ isCollection: true }` option and let Harper
 *    set its own private field.
 *
 * This module exists so those two facts live in ONE place. flair itself got (2)
 * wrong in four MCP tool paths before this module existed — the same mistake a
 * consumer reading only the resource classes would make.
 *
 * ── Deliberately dependency-free ─────────────────────────────────────────────
 * No `import { databases } from "harper"` (see resources/memory-visibility.ts
 * for why that import is load-bearing to avoid): these helpers are pure shape,
 * and an embedding app may want them before any table is resolved.
 */

/**
 * ─── THE CONTEXT OBJECT IS A SECURITY BOUNDARY ───────────────────────────────
 *
 * In-process identity is **asserted, not verified**. `resolveAgentAuth()` reads
 * `context.request.tpsAgent` and returns that agent — there is no signature
 * check, no lookup against the `Agent` table, and no registration requirement.
 * `tpsAgentIsAdmin: true` is asserted the same way, and grants unfiltered
 * cross-agent reads and writes.
 *
 * That is the right design, not a gap: a co-located caller is already inside
 * the trust boundary and could write `databases.flair.Memory` directly, so
 * demanding a signature from same-process code would be theatre. Ed25519 exists
 * for callers OUTSIDE the process.
 *
 * The consequence is the single most important thing to get right in an
 * embedding app:
 *
 *   **Build the context from your own server-side state. NEVER from request
 *   data.** If an agent id can reach `agentContext()` from user input — a body
 *   field, a query param, a header your app did not itself verify — that is
 *   privilege escalation with no error, no 403 and no trace. Resolve the caller
 *   with your own authentication first, then map the identity YOU established
 *   onto `tpsAgent`.
 *
 * The two ways to lose the whole model, from opposite ends:
 *   - **By omission** — no context at all resolves to `internal`, which is
 *     admin-equivalent (see {@link agentContext}).
 *   - **By assertion** — an attacker-influenced `agentId`, or a stray
 *     `isAdmin: true`, is honoured verbatim.
 * Both are pinned as tests in test/integration/in-process-agents.test.ts.
 *
 * ── Prefer individual agent identities over one app identity ─────────────────
 * A per-agent context costs nothing: no client to construct, no key to load, no
 * per-agent setup, and (per the above) not even a registration. Collapsing N
 * agents onto one shared identity buys nothing and loses the two things that
 * make the memory model work — per-agent attribution, which is what trust
 * grading and provenance are computed from, and N separate blast radii, which
 * become one. Register the agents anyway: the admin surfaces, federation, and
 * the HTTP path all read those records.
 *
 * ── In a cluster ────────────────────────────────────────────────────────────
 * Harper replicates every table in a replicated database unless the table opts
 * out with `@table(replicate: false)`; none of flair's do. So:
 *   - **The registry replicates.** An agent registered on node A is visible on
 *     node B with no coordination. (Replication comes from the DATABASE being
 *     replicated — not from `@export`, which only controls REST exposure.
 *     `Memory` has no `@export` and still replicates.)
 *   - **Authority is local.** The context is constructed per call, in whichever
 *     process handles it. No node consults another to decide who a caller is.
 *   - **Attribution travels.** `agentId` is a field ON the record, so a memory
 *     written on node A reads back correctly attributed — and correctly scoped
 *     — anywhere the record lands.
 *
 * Therefore **every node running the app is equally trusted**, because each one
 * can assert any identity. That is fine for one application spread across
 * regions — it is a single trust domain by construction. It is NOT fine for
 * running this component beside untrusted co-tenants on the same instance:
 * co-location IS the grant.
 */

/** Options for {@link agentContext}. */
export interface AgentContextOptions {
  /**
   * Grant flair-admin authority to this call: unfiltered cross-agent reads and
   * writes attributed to other agents. Asserted, never checked — nothing
   * validates that the named agent is actually an admin. Treat exactly as you
   * would a root shell: provisioning and maintenance only, never a request
   * handler's default, and never derived from anything a caller supplied.
   */
  isAdmin?: boolean;
}

/**
 * The resource context that makes an in-process call act as ONE SPECIFIC agent.
 *
 * **`agentId` is asserted, not proven — see the security-boundary block above.
 * It must come from your own server-side state, never from request data.**
 *
 * Pass the result as the `context` argument of {@link collectionResource}, or as
 * the trailing `context` argument of a Harper static resource method
 * (`Cls.get(id, context)`, `Cls.put(id, record, context)`, …). Every flair
 * resource resolves it through `resolveAgentAuth()`, so the call is scoped,
 * attributed and rate-limited exactly as an Ed25519-signed REST call from that
 * agent would be — including the no-forge check that 403s a write whose
 * `agentId` names a different agent.
 *
 * ── OMITTING THE CONTEXT IS NOT A WEAKER CALL, IT IS AN ADMIN CALL ───────────
 * A resource built with no context at all resolves to `{ kind: "internal" }` —
 * flair's trusted in-process verdict — and runs UNFILTERED: every read sees
 * every agent's private records, every write is unattributed. That is correct
 * for flair's own maintenance passes (consolidation, migrations) and it is a
 * silent cross-agent data leak in an application. There is no error, no warning
 * and no log line to find it by.
 *
 * So in an embedding app: make the agent id a REQUIRED argument of whatever
 * wraps this, and never export a wrapper that defaults it.
 */
export function agentContext(agentId: string, opts: AgentContextOptions = {}): any {
  return {
    request: {
      tpsAgent: agentId,
      tpsAgentIsAdmin: opts.isAdmin === true,
    },
  };
}

/**
 * A resource instance bound to `context` and marked as a COLLECTION, so its
 * `post()` (the create path) works — see this module's header for why that mark
 * cannot be applied from outside Harper.
 *
 * Use it for every in-process CREATE:
 *
 * ```ts
 * const Memory = server.resources.get("Memory").Resource;
 * const h = await collectionResource(Memory, agentContext("planner"));
 * const { id } = await h.post({ agentId: "planner", content: "…" });
 * ```
 *
 * `context` is optional ONLY because flair's own maintenance paths legitimately
 * want the trusted `internal` verdict; omitting it in an application is the
 * admin hazard documented on {@link agentContext}.
 *
 * Reads do not need this — `Cls.get(id, context)` and `Cls.search(query,
 * context)` (Harper's static resource methods) already thread the context and
 * start their own transaction.
 */
export async function collectionResource<T = any>(Cls: any, context?: any): Promise<T> {
  // `{}` is a sufficient RequestTarget here: getResource() reads only `.id` off
  // it (undefined ⇒ Harper mints the primary key), and takes the collection
  // mark from the options argument.
  return (await Cls.getResource({}, context ?? {}, { isCollection: true })) as T;
}
