/**
 * mcp-tools.ts — the 12 curated flair tools for the Model-2 custom /mcp handler.
 *
 * Curated BY CONSTRUCTION: this module implements a fixed set of tools, each a
 * thin wrapper over the existing flair Resource handler. No business logic is
 * re-implemented — the wrapped handlers (Memory / SemanticSearch /
 * BootstrapMemories / Soul / WorkspaceState / OrgEvent / AttentionQuery /
 * RecordUsage) enforce per-agent scoping/ownership via
 * `resolveAgentAuth(getContext())` (or, for `attention`, AttentionQuery's own
 * per-source scoping — see resources/AttentionQuery.ts's module doc), so the
 * MCP surface inherits the SAME security model as the signed-REST path. There
 * is no raw CRUD surface — the only way to reach the datastore through /mcp is
 * via one of these 12 semantic tools.
 *
 *   memory_search · memory_store · memory_update · memory_get · memory_delete ·
 *   bootstrap · soul_set · soul_get · flair_workspace_set · flair_orgevent ·
 *   attention · record_usage
 *
 * ── The scoping seam ────────────────────────────────────────────────────────
 * The /mcp handler resolves the OAuth token's `sub` → a flair `Agent` id, then
 * calls a tool with a `ResolvedAgent { agentId, isAdmin }`. Each tool builds a
 * flair-shaped Resource context (`delegationContext`) carrying `request.tpsAgent`
 * + `request.tpsAgentIsAdmin`, so the wrapped handler scopes to the verified
 * agent exactly as an Ed25519-signed REST call would. Identity ALWAYS comes from
 * the resolved agent, never from the tool arguments — an agent can only act as
 * itself (no forging of agentId / authorId in the body).
 *
 * NOTE (flair#677 scope call): the legacy `@tpsdev-ai/flair-mcp` stdio proxy
 * (packages/flair-mcp) is a SEPARATE, independently-published package that
 * talks to flair over HTTP via `FlairClient` — it is not wired through this
 * registry at all (its own tool list is hardcoded in packages/flair-mcp/src/
 * index.ts). Per the zero-install north star (retiring flair-mcp in favor of
 * this native /mcp handler), `attention` is added HERE only, not mirrored into
 * the legacy stdio proxy — adding it there would mean a separate package
 * version bump + a new FlairClient method, out of scope for this query-only
 * slice.
 */

/**
 * The delegated handler classes, held in a mutable registry, LAZILY loaded on
 * first use. Two reasons for the indirection:
 *
 *   1. Tests inject capture doubles via `__setHandlers` WITHOUT `mock.module`-ing
 *      the shared `resources/*.ts` files (a process-global bun mock that leaks
 *      into every other test file).
 *   2. The handler classes statically `import { Resource, databases } from
 *      "harper"`. Importing them lazily (dynamic import on first tool
 *      call, not at module top) keeps `mcp-tools`/`mcp-handler` free of a
 *      top-level Harper link, so importing the /mcp handler in a unit test never
 *      requires the full Harper module surface up front.
 *
 * Prod: first tool call loads the real classes against a fully-real Harper.
 */
import type { RecordTypeName } from "./record-types.js";
import { resolveVersion } from "./version.js";
import { agentContext, adminContext, collectionResource } from "./in-process.js";

type HandlerKey = "SemanticSearch" | "Memory" | "BootstrapMemories" | "Soul" | "WorkspaceState" | "OrgEvent" | "AttentionQuery" | "RecordUsage";
const H: Partial<Record<HandlerKey, any>> = {};

const LOADERS: Record<HandlerKey, () => Promise<any>> = {
  SemanticSearch: async () => (await import("./SemanticSearch.js")).SemanticSearch,
  Memory: async () => (await import("./Memory.js")).Memory,
  BootstrapMemories: async () => (await import("./MemoryBootstrap.js")).BootstrapMemories,
  Soul: async () => (await import("./Soul.js")).Soul,
  WorkspaceState: async () => (await import("./WorkspaceState.js")).WorkspaceState,
  OrgEvent: async () => (await import("./OrgEvent.js")).OrgEvent,
  AttentionQuery: async () => (await import("./AttentionQuery.js")).AttentionQuery,
  RecordUsage: async () => (await import("./RecordUsage.js")).RecordUsage,
};

/** Resolve a handler class — from the test override if set, else lazy-load + cache. */
async function handler(key: HandlerKey): Promise<any> {
  if (H[key]) return H[key];
  const cls = await LOADERS[key]();
  H[key] = cls;
  return cls;
}

/** TEST-ONLY: override the delegated handler classes. Returns a restore fn. */
export function __setHandlers(overrides: Partial<Record<HandlerKey, any>>): () => void {
  const prev = { ...H };
  Object.assign(H, overrides);
  return () => {
    for (const k of Object.keys(H) as HandlerKey[]) delete H[k];
    Object.assign(H, prev);
  };
}

/** The verified agent identity for an MCP tool call (resolved from the token sub). */
export interface ResolvedAgent {
  agentId: string;
  isAdmin: boolean;
  /**
   * flair#718 authorship-provenance: the OAuth token's verified `client_id`
   * claim (resources/mcp-handler.ts's handleToolCall — sourced from
   * `client_id`, NEVER `client_name`; see that stamp site for why). Optional
   * and absent when the token carries none. Threaded into the write tools
   * below as `claimedClient` on the POST/PUT body, which
   * resources/provenance.ts's buildProvenance folds into
   * `provenance.claimed.client` — records WHICH CLIENT authored the write,
   * grants ZERO authority, never read for access control/attribution/dedup.
   */
  clientId?: string;
}

/** MCP tool descriptor as returned by tools/list. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Build a flair-shaped Resource context for a delegated handler call. The
 * handlers read identity via `resolveAgentAuth(getContext())`, which checks
 * `context.request.tpsAgent` / `tpsAgentIsAdmin`. We construct exactly that shape
 * so the wrapped handler scopes to the verified agent — identical to the
 * signed-REST path. `headers.get("x-tps-agent")` is provided for handler paths
 * that read the header directly (e.g. MemoryBootstrap fallback).
 *
 * Critically: `tpsAnonymous` is NOT set and no Authorization header is present,
 * so `resolveAgentAuth` takes the `tpsAgent` annotation branch — a verified
 * agent, never anonymous, never a header re-verify.
 */
function delegationContext(agent: ResolvedAgent): any {
  // Shape single-sourced from resources/in-process.ts — the same context an
  // embedding Harper app builds to act as one of its agents — plus the
  // `x-tps-agent` header shim the delegated handlers' own header-reading paths
  // expect.
  //
  // The admin branch is spelled out rather than passed as a flag: adminContext()
  // is the greppable name for "this call carries flair-admin authority". Both
  // constructors THROW on an empty agent id, which is the outcome we want here —
  // a token that resolved to no principal must fail the tool call, never fall
  // through to flair's unfiltered `internal` verdict.
  const ctx = agent.isAdmin ? adminContext(agent.agentId) : agentContext(agent.agentId);
  ctx.request.headers = {
    get: (k: string) => (k.toLowerCase() === "x-tps-agent" ? agent.agentId : undefined),
  };
  ctx.user = undefined;
  return ctx;
}

/**
 * Unwrap a handler return value into a plain object/string for the MCP result.
 * Handlers may return a `Response` (the 401/403/400 guards) — surface its JSON
 * body (and status) so the client sees the structured error rather than an
 * opaque object. A thrown handler error propagates to the caller (the handler
 * maps it to a JSON-RPC error).
 */
async function unwrap(value: any): Promise<any> {
  if (value && typeof value === "object" && typeof value.json === "function" && "status" in value) {
    try {
      const body = await value.json();
      return { error: body?.error ?? "request failed", status: value.status, ...body };
    } catch {
      return { error: "request failed", status: (value as any).status };
    }
  }
  return value;
}

/**
 * flair#1188 — the internal, embedding-engine-owned fields a memory record
 * carries that must NEVER cross the MCP surface. Both are server-managed and
 * useless (or misleading) to a connector:
 *
 *   - `embedding`     — the raw 768-float HNSW vector; thousands of noise
 *                       tokens per record on a fixed-budget chat connector, and
 *                       the caller can do nothing with it (flair#1188).
 *   - `embeddingModel` — the model id stamped on every write
 *                       (resources/Memory.ts stamps `content.embeddingModel =
 *                       getModelId()`; schemas/memory.graphql declares it
 *                       @indexed). The WRITE wrappers already treat it as
 *                       internal — memory_update `delete`s it from both the
 *                       overwrite and the supersede record — so the READ path
 *                       must strip it too, or memory_get leaks an internal
 *                       field the write echoes hide (flair#1213, Sherlock #1).
 *
 * Exported so the flair#1213 conformance "no leaked internal fields" invariant
 * enumerates the SAME list this function strips: the strip and the assertion
 * cannot drift, and adding a field here automatically extends both.
 */
export const INTERNAL_MEMORY_FIELDS = ["embedding", "embeddingModel"] as const;

/**
 * flair#1188 / flair#1213 — remove the internal embedding-engine fields (see
 * `INTERNAL_MEMORY_FIELDS`) from a record before it is returned over the MCP
 * surface. Returns a shallow copy WITHOUT those fields (never mutates the
 * source record), and passes through anything that is not a plain record —
 * null, primitives, arrays, and the `{ error, status }` shapes `unwrap`
 * produces — untouched.
 *
 * `memory_search` already projects with an explicit select that omits
 * `embedding` (resources/semantic-retrieval-core.ts's DEFAULT_SELECT), and
 * `bootstrap` uses the same select-without-embedding pushdown, so this is only
 * needed on the FULL-record read/write paths (memory_get, and the write
 * responses that echo the stored row).
 */
function stripInternalFields(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  let out = value;
  let copied = false;
  for (const field of INTERNAL_MEMORY_FIELDS) {
    if (field in out) {
      if (!copied) { out = { ...out }; copied = true; }
      delete out[field];
    }
  }
  return out;
}

// ── Tool implementations (thin wrappers over existing handlers) ──────────────
//
// Each takes the resolved agent + the parsed tool arguments and returns a plain
// JSON-serializable value. Identity is taken from `agent`, never from `args`.

async function memorySearch(agent: ResolvedAgent, args: any) {
  const Cls = await handler("SemanticSearch");
  const h = new Cls(undefined, delegationContext(agent));
  const body: Record<string, unknown> = { q: args?.query, limit: args?.limit ?? 5 };
  // flair#744 slice 1 — opt-in inline trust block per result. Forwarded ONLY
  // when requested so a plain search delegates a byte-identical body.
  if (args?.includeTrust === true) body.includeTrust = true;
  // flair#744 slice 2 — opt-in abstention verdict. Forwarded ONLY when
  // requested so a plain search delegates a byte-identical body.
  if (args?.abstain === true) body.abstain = true;
  return unwrap(await h.post(body));
}

async function memoryStore(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Memory");
  const h: any = await collectionResource(Cls, delegationContext(agent));
  // agentId is the RESOLVED agent — Memory.post also re-checks ownership via
  // resolveAgentAuth, so a mismatched body agentId would 403 anyway; we set it
  // to the verified id so the write is correctly owned.
  const body: Record<string, unknown> = {
    agentId: agent.agentId,
    content: args?.content,
    type: args?.type ?? "session",
    durability: args?.durability ?? "standard",
    tags: args?.tags,
  };
  // flair#718 authorship-provenance: forward the resolved OAuth client_id
  // (never a tool argument — no forging) as claimedClient; Memory.post()
  // folds it into provenance.claimed.client and strips it from the row.
  // Omitted entirely when the token carried no client_id.
  if (agent.clientId) body.claimedClient = agent.clientId;
  // flair#744 slice A: citation-on-write — forward the optional
  // usedMemoryIds array only when the caller actually supplied it, so an
  // omitted citation list delegates a byte-identical body (Memory.post()
  // consumes-and-strips this before the row is written, then credits each
  // id post-commit through the shared usage ledger).
  if (Array.isArray(args?.usedMemoryIds)) body.usedMemoryIds = args.usedMemoryIds;
  // flair#991 writer-controlled sharing intent. Forwarded ONLY when the caller
  // actually supplied it, so an omitted visibility delegates a byte-identical
  // body and Memory.post() applies its durability-keyed default.
  //
  // ── Why an unrecognized value is REJECTED, not dropped and not passed on ──
  // `visibility` is a free-form String in schemas/memory.graphql, and the read
  // scope asks `isPrivateVisibility()` — an exact match on the literal
  // "private" — so EVERY other string, typos included, reads as non-private
  // and is returned to every agent on the instance. Both of the softer
  // options therefore fail in the unsafe direction:
  //   - forwarding it: `visibility: "prvate"` persists a row the caller
  //     believes is owner-only and that every agent can in fact read;
  //   - silently dropping it: falls back to the durability-keyed default,
  //     which for a permanent/persistent write is `shared` — same outcome,
  //     with no argument left in the record to explain it.
  // A misspelled argument must never widen who can read a memory, so the tool
  // call fails and says so. The allowlist is deliberately not derived from
  // isPrivateVisibility(): that predicate must stay "is it exactly private"
  // for the no-visibility-field migration invariant (see
  // resources/memory-visibility.ts), which is a READ-side rule and cannot
  // double as a WRITE-side allowlist.
  if (args?.visibility !== undefined && args?.visibility !== null) {
    if (args.visibility !== "private" && args.visibility !== "shared") {
      return {
        error: "invalid_visibility",
        status: 400,
        message: `visibility must be "private" or "shared" (got: ${JSON.stringify(args.visibility)}). Omit it to use the durability-keyed default: permanent/persistent -> shared, standard/ephemeral -> private.`,
      };
    }
    body.visibility = args.visibility;
  }
  // flair#1188 — memory_store's response goes through the same buildWriteResponse
  // echo as memory_update; strip the server-regenerated embedding so no write
  // tool ever inlines the vector. No-op when the response carries none.
  return stripInternalFields(await unwrap(await h.post(body)));
}

/**
 * memory_update — id-targeted, dedup-BYPASSED overwrite/version path (memory-
 * integrity fix). Mirrors flair-client's MemoryApi.update() (packages/
 * flair-client/src/client.ts), reimplemented against the resource instance
 * API instead of HTTP since this handler calls the Memory resource directly
 * (same pattern as memoryStore vs the flair-mcp stdio tool). Auth is enforced
 * by Memory.get()/Memory.put()/Memory.post()'s EXISTING ownership checks — no
 * parallel auth logic here.
 *
 * Default (preserveHistory unset/false): read the existing record, merge the
 * new content on top (Harper PUT is full-record replacement — never send a
 * bare partial), clear the stale embedding so the server regenerates it, and
 * PUT the merged record back to the SAME id.
 *
 * preserveHistory: true: write a NEW id with `supersedes: id`. Memory.post()
 * validates/authorizes the supersede (denying a cross-agent supersede without
 * a "write" MemoryGrant) and closes the old record's validTo AFTER the new
 * record is written (never the reverse — see resources/Memory.ts).
 */
async function memoryUpdate(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Memory");
  const id = args?.id;
  const content = args?.content;
  const preserveHistory = args?.preserveHistory === true;

  // flair#1181 — the existing-record fetch is a by-id READ and must use the
  // STATIC `Cls.get(id, context)` form (see memoryGet). The instance
  // `new Cls(undefined, ctx).get(id)` returned `undefined` for the caller's own
  // record (getProperty on an unloaded instance), so memory_update 404'd
  // ("memory not found") on the connector path before it ever reached a write.
  //
  // flair#1213 — the get MUST be `unwrap`ped (as memoryGet does), not consumed
  // raw. Memory.get()'s makeByIdReadGate returns a NOT_FOUND() *Response* (404)
  // for an absent or non-readable id — a TRUTHY object with no `id` — so the
  // bare `if (!existing)` guard never fired: the code fell through and PUT a
  // record whose id spread off the Response as `undefined`, throwing the
  // MISDIRECTING "Invalid primary key of null" instead of a clean 404. This is
  // the same by-id-read-on-the-connector-seam class as #1181, caught by the
  // conformance error contract (Kern #5). Unwrap, then treat a 404/error/absent
  // result as "not found".
  const existing = await unwrap(await Cls.get(id, delegationContext(agent)));
  if (!existing || (existing as any).error != null || (existing as any).status === 404) {
    return { error: "memory not found", status: 404 };
  }

  if (preserveHistory) {
    const newId = `${agent.agentId}-${crypto.randomUUID()}`;
    const record: Record<string, unknown> = {
      ...existing,
      id: newId,
      content,
      supersedes: id,
      createdAt: new Date().toISOString(),
    };
    delete record.updatedAt;
    delete record.embedding;
    delete record.embeddingModel;
    delete record.validFrom;
    delete record.validTo;
    delete record.archivedAt;
    // flair#1189 — retrievalCount and lastRetrieved are RECORD-scoped, not
    // lineage-scoped: a brand-new successor record has no retrieval history of
    // its OWN, so it must start with none. Inheriting them from the superseded
    // record via the `...existing` spread produced a successor whose
    // lastRetrieved PREDATED its own createdAt ("retrieved 8h before it
    // existed"), silently corrupting any recency/usage-based ranking that reads
    // these fields. Reset both here, at succession construction — NOT server-
    // side, because `supersedes` is a PERMANENT property of every successor and
    // legitimate later retrievalCount bumps route through put() on a record that
    // still carries it. Usage/citation-ledger counters (usageCount, the #1147
    // citation ledger) are a SEPARATE, arguably lineage-scoped question and are
    // deliberately left untouched here (#1147's usage loop is currently inert).
    record.retrievalCount = 0;
    delete record.lastRetrieved;
    // flair#718 authorship-provenance — see memoryStore's comment: forward
    // the resolved OAuth client_id (never forgeable via args) so the NEW
    // version's provenance records which client authored this update.
    if (agent.clientId) record.claimedClient = agent.clientId;
    // A create needs a COLLECTION-bound instance (see resources/in-process.ts).
    const coll: any = await collectionResource(Cls, delegationContext(agent));
    // flair#1188 — the write response echoes the stored row (Memory.post
    // regenerates the embedding server-side), so strip the vector before it
    // returns over the MCP surface. No-op when the response carries none.
    return stripInternalFields(await unwrap(await coll.post(record)));
  }

  const merged: Record<string, unknown> = { ...existing, content, updatedAt: new Date().toISOString() };
  delete merged.embedding;
  delete merged.embeddingModel;
  // flair#718 authorship-provenance — see memoryStore's comment above.
  if (agent.clientId) merged.claimedClient = agent.clientId;
  // flair#1181 — the default merge write must ALSO use the STATIC transactional
  // path, `Cls.put(merged, context)`, NOT an instance `new Cls(undefined, ctx).put(merged)`.
  // An unloaded instance has no primary key, so its put()/save() throws
  // "Invalid primary key type: undefined" (proven by the memory_update
  // round-trip integration test). The pre-#1181 code never hit this because the
  // broken by-id read above 404'd first — migrating the read to static exposed
  // the same unloaded-instance defect on the write. The static form loads the
  // row by `merged.id` and threads the context, then dispatches through
  // Memory.put()'s own ownership gate — no scope change, same as the read.
  // flair#1188 — strip the embedding from the echoed write response (Memory.put
  // regenerates the vector server-side); no-op when the response carries none.
  return stripInternalFields(await unwrap(await Cls.put(merged, delegationContext(agent))));
}

async function memoryGet(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Memory");
  // flair#1181 — by-id reads MUST use the STATIC `Cls.get(id, context)` form,
  // never an instance `new Cls(undefined, ctx).get(id)`. Harper routes an
  // instance `.get(<string>)` on an UNLOADED record (tables leave
  // `loadAsInstance` at its `undefined` default) to `getProperty()` — a field
  // accessor that returns `undefined` — so the read never loads the row and
  // `makeByIdReadGate`'s `!record` branch 404s the caller's OWN record (one
  // call after a successful store). The static form is the same transactional
  // path the Ed25519 REST route takes: it loads the row, hands the override a
  // `RequestTarget` (never a bare string), and still dispatches through
  // Memory.get() → makeByIdReadGate → resolveReadScope, so the scope model is
  // unchanged (own + org-non-private only). See resources/in-process.ts:223.
  //
  // flair#744 slice 1 — opt-in inline trust block. The instance call passed
  // `includeTrust` as a 2nd positional opts arg to get(); the static form has
  // no opts slot (arg 2 is the context), so fold it into the RequestTarget as
  // a plain `{ id, includeTrust }` property — Memory.get()'s wantsTrust() reads
  // it there (the in-process shape alongside the HTTP query-param shape).
  const target = args?.includeTrust === true ? { id: args?.id, includeTrust: true } : args?.id;
  const result = await unwrap(await Cls.get(target, delegationContext(agent)));
  // flair#1188 — a by-id get loads the FULL record, including the 768-float
  // `embedding` vector (search/bootstrap project it out; a raw get does not).
  // Strip it by default so a chat connector isn't flooded with thousands of
  // useless tokens per record; return it only when the caller explicitly opts
  // in via includeEmbedding.
  return args?.includeEmbedding === true ? result : stripInternalFields(result);
}

async function memoryDelete(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Memory");
  // flair#1181 — STATIC `Cls.delete(id, context)`, not an instance
  // `new Cls(undefined, ctx).delete(id)`. Memory.delete()'s override loads the
  // row via `super.get(id)` to enforce the permanent-memory admin guard; on an
  // unloaded instance that `super.get(<string>)` hit the same `getProperty()`
  // dead end (`undefined`), so the guard's `record.durability === "permanent"`
  // check was SILENTLY SKIPPED and the delete fell through to an unguarded
  // `super.delete(id)`. The static form loads the row first (RequestTarget,
  // not a bare string), so the override sees the real record and the
  // ownership/durability guard runs as intended.
  return unwrap(await Cls.delete(args?.id, delegationContext(agent)));
}

async function bootstrap(agent: ResolvedAgent, args: any) {
  const Cls = await handler("BootstrapMemories");
  const h = new Cls(undefined, delegationContext(agent));
  const body: Record<string, unknown> = {
    agentId: agent.agentId,
    maxTokens: args?.maxTokens ?? 4000,
    currentTask: args?.currentTask,
    channel: args?.channel,
    surface: args?.surface,
    subjects: args?.subjects,
    entities: args?.entities,
    // flair#1199 — a /mcp connector consumes the STRUCTURED containers
    // (soul/memories/predicted/teammateFindings), so the prose `context` mirror
    // is OFF by default here: shipping both doubled the payload past maxTokens
    // (the reported ~2× overrun). The resource itself defaults includeContext
    // true (the REST/CLI prose path); this wrapper flips it for the connector,
    // and forwards an explicit true when a caller wants the prose anyway.
    includeContext: args?.includeContext === true,
  };
  // flair#744 slice 1 — opt-in per-memory trust block array. Forwarded ONLY
  // when requested so a plain bootstrap delegates a byte-identical body.
  if (args?.includeTrust === true) body.includeTrust = true;
  // flair#744 slice 2 — opt-in task-relevance abstention verdict. Forwarded
  // ONLY when requested so a plain bootstrap delegates a byte-identical body.
  if (args?.abstain === true) body.abstain = true;
  // flair#1199 — org-event knobs. `includeEventDetail` opts the verbose per-event
  // `detail` JSON back in (default OFF: a connector reads lean events); `maxEvents`
  // overrides the default cap. Both forwarded ONLY when set, so a plain bootstrap
  // delegates a byte-identical body.
  if (args?.includeEventDetail === true) body.includeEventDetail = true;
  if (args?.maxEvents !== undefined) body.maxEvents = args.maxEvents;
  // flair#831 — attach the running Flair version to the RESPONSE (not the
  // delegated request body) so the calling agent learns the server version
  // on its very first call.
  //
  // flair#1182 — `unwrap` is async: it must be AWAITED before the result is
  // spread, exactly as every sibling tool does (`await unwrap(...)` in
  // memory_store / memory_update / memory_get). Without the await, `result` is
  // the still-pending PROMISE, and `{ ...aPromise }` copies no own-enumerable
  // keys — so the entire computed payload (resolved agentId, scope, soul,
  // memories, predicted, the #1182.1 containers, the abstention verdict) was
  // silently discarded and the caller saw ONLY the injected `flairVersion`.
  const result = await unwrap(await h.post(body));
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, flairVersion: resolveVersion() };
  }
  return result;
}

async function soulSet(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Soul");
  // flair#1181 — this write MUST go through a COLLECTION-bound instance
  // (`collectionResource(Cls, ctx).post(...)`), the same create path the sibling
  // write tools use (memoryStore / workspaceSet / orgEvent). The previous
  // `new Cls(undefined, ctx).put({ id, ... })` was a PUT on an UNLOADED instance:
  // an unloaded instance has no primary key, so Harper's instance put()/save()
  // threw `Invalid primary key type: undefined` (the same defect class the
  // memoryGet/update/delete/soulGet by-id READS were migrated off of — see those
  // wrappers, and resources/in-process.ts's header: "flair itself got [collection
  // binding] wrong in four MCP tool paths"). soul_set's only prior test drove a
  // MOCKED handler, so the real instance-put never ran and it shipped broken on
  // the connector path.
  //
  // A COLLECTION post (not a static `Cls.put(record, ctx)`) is the right form:
  // it routes through Soul.post(), which stamps createdAt (a schema-required,
  // non-null field). Static `Cls.put` reaches Soul.put(), which does NOT stamp
  // createdAt on a create, so it fails a "Property createdAt is required"
  // validation. Soul.post honors the explicit body `id`, so the record is still
  // keyed `id = agentId:key` and soul_get's `${agentId}:${key}` lookup finds it —
  // a random-id create would orphan the entry from get(). Soul.post enforces
  // write ownership via resolveAgentAuth (non-admin can only write agentId === self).
  const id = `${agent.agentId}:${args?.key}`;
  const h: any = await collectionResource(Cls, delegationContext(agent));
  return unwrap(await h.post({
    id,
    agentId: agent.agentId,
    key: args?.key,
    value: args?.value,
  }));
}

async function soulGet(agent: ResolvedAgent, args: any) {
  const Cls = await handler("Soul");
  // flair#1181 — STATIC by-id read (see memoryGet). Soul has no get() override
  // and no read-scope gate; its ids are `${agentId}:${key}`, built here from
  // the RESOLVED agent, so a caller can only ever address its OWN soul — the
  // static migration does not change that. The instance `h.get(<string>)`
  // returned `undefined` (getProperty on an unloaded record), which is why
  // soul_get came back empty on the connector path even though the entries
  // exist and load fine via the Ed25519 static route.
  return unwrap(await Cls.get(`${agent.agentId}:${args?.key}`, delegationContext(agent)));
}

async function workspaceSet(agent: ResolvedAgent, args: any) {
  const Cls = await handler("WorkspaceState");
  const h: any = await collectionResource(Cls, delegationContext(agent));
  // No agentId in the body — WorkspaceState.post attributes the record to the
  // authenticated identity (from the context), never the body. Same no-forge
  // contract as the flair-mcp stdio tool.
  const body: Record<string, unknown> = {
    id: `${agent.agentId}:${args?.ref}`,
    ref: args?.ref,
    provider: args?.provider ?? "mcp",
    timestamp: new Date().toISOString(),
  };
  if (args?.label) body.label = args.label;
  if (args?.task) body.taskId = args.task;
  if (args?.phase) body.phase = args.phase;
  if (args?.summary) body.summary = args.summary;
  return unwrap(await h.post(body));
}

async function orgEvent(agent: ResolvedAgent, args: any) {
  const Cls = await handler("OrgEvent");
  const h: any = await collectionResource(Cls, delegationContext(agent));
  // No authorId in the body — OrgEvent.post attributes to the authenticated
  // identity, never the body (no forging as another agent).
  const body: Record<string, unknown> = { kind: args?.kind, summary: args?.summary };
  if (args?.detail) body.detail = args.detail;
  if (args?.scope) body.scope = args.scope;
  if (Array.isArray(args?.targets) && args.targets.length > 0) body.targetIds = args.targets;
  return unwrap(await h.post(body));
}

async function attention(agent: ResolvedAgent, args: any) {
  const Cls = await handler("AttentionQuery");
  const h = new Cls(undefined, delegationContext(agent));
  return unwrap(await h.post({ entity: args?.entity, days: args?.days }));
}

/**
 * record_usage (flair#683) — report that memory(ies) were actually used
 * (cited/grounded an answer or decision), driving the usage-feedback signal
 * (Memory.usageCount → usageBoost → compositeScore). Distinct from search:
 * calling memory_search does NOT count as usage — this tool is the explicit,
 * verified-use report resources/RecordUsage.ts's module doc describes.
 * Identity is the RESOLVED agent (delegationContext), never forgeable via
 * args — same no-forge contract as every other write tool here.
 */
async function recordUsage(agent: ResolvedAgent, args: any) {
  const Cls = await handler("RecordUsage");
  const h = new Cls(undefined, delegationContext(agent));
  const memoryIds = Array.isArray(args?.memoryIds)
    ? args.memoryIds
    : typeof args?.memoryId === "string" ? [args.memoryId] : undefined;
  return unwrap(await h.post({ memoryIds, attribution: args?.attribution }));
}

type ToolImpl = (agent: ResolvedAgent, args: any) => Promise<any>;

// ── flair#1213 — the connector CONSUMER CONTRACT, co-located with each tool ──
//
// Each ToolEntry below carries a declarative `contract`: the SHAPE and
// SEMANTICS a /mcp connector is entitled to rely on from that tool. It lives
// RIGHT NEXT TO the tool's def+impl (Kern #2) so a response-shape change to the
// wrapper prompts a contract update in the same diff — the completeness check
// catches a MISSING contract, co-location is what keeps a present one from going
// STALE. The conformance suite
// (test/integration/mcp-connector-conformance-suite.test.ts) reads these,
// drives each tool's REAL `.impl` against a seeded store, and asserts every
// declared field/type/invariant. The historical connector bugs
// (#1181/#1188/#1182/#1199/#1200/#1206) each map to an invariant below, proven
// by the mutation-validation log in the PR: revert the fix ⇒ a conformance test
// goes red.

type FieldType = "string" | "number" | "boolean" | "object" | "array";

/** Semantic invariants — the class each historical connector bug lived in. */
export interface ToolInvariants {
  /**
   * A self-describing COUNT field must equal the TOTAL length of the
   * container(s) it describes: counted == delivered (flair#1199
   * memoriesIncluded/teammateFindingsIncluded; flair#1206 sections.events).
   * `count` may be a dotted path (e.g. "sections.events"); `containers` are
   * top-level arrays whose lengths SUM to the count.
   *
   * `containers` is a list, not a single name, because `memoriesIncluded`
   * legitimately spans TWO delivered own-memory containers: `memories`
   * (permanent/recent/relevant) AND `predicted` (subject-matched) — both are
   * own memories, both are counted (resources/MemoryBootstrap.ts increments
   * memoriesIncluded at the predicted push too). Asserting it against
   * `memories` alone would false-fail whenever predicted is non-empty; the
   * correct invariant is memoriesIncluded === memories.length + predicted.length.
   */
  countEqualsDelivered?: Array<{ count: string; containers: string[] }>;
  /**
   * Containers that must be PRESENT and correctly typed even when the caller
   * has none — an empty `[]`/`{}` with a hint, never a bare `{}`, a missing
   * key, or `undefined` (self-describing empty, flair#1182).
   */
  selfDescribingEmpty?: Array<{ path: string; type: "array" | "object" }>;
  /**
   * No two entries in `container` share the same tuple of `signatureFields`
   * (flair#1200 dedup). The signature is the SEMANTIC content key the tool
   * actually dedups on — for org-events `kind+summary+detail+targetIds`
   * (resources/MemoryBootstrap.ts's eventBySignature), the exact fields that
   * stay EQUAL across physical duplicate rows. It deliberately excludes `id`
   * and `createdAt`, which VARY between those rows (OrgEvent.post keys the id
   * off a millisecond timestamp), so keying on either would miss the dupe the
   * fixture seeds. See the conformance suite's fixture note.
   */
  dedupSignature?: { container: string; signatureFields: string[] };
  /**
   * `tokenEstimate` must equal the wrapper's OWN estimator applied to the
   * delivered payload: estimateTokens(JSON.stringify(result minus excludeKeys))
   * (flair#1199 double-serialization; Kern #1 / Sherlock #2). Same estimator,
   * not a byte length or a different tokenizer — so it catches the class
   * without being brittle to a future estimator change. `excludeKeys` are the
   * fields added AFTER the estimate was taken (tokenEstimate itself, and the
   * wrapper-injected flairVersion).
   */
  tokenEstimate?: { field: string; excludeKeys: string[] };
  /**
   * The reported serialized-payload estimate must not blow the requested budget:
   * `result[estimate] <= result[budget] * (1 + tolerance)` (flair#1199 — the
   * events blowout: a maxTokens=4000 request serialized at 6286 because the
   * org-events array was assembled but NEVER charged against the budget). Both
   * fields are read off the RESULT (bootstrap echoes `maxTokens`), so the
   * invariant is self-contained. `tolerance` absorbs the FIXED structural JSON
   * scaffolding (container keys/braces, counters, the sections map) and the
   * per-item gap between the prose-line cost the memory sections charge and the
   * larger structured object they deliver — the deliberate #1207 measurement/
   * budgeting decoupling (memories are charged at prose-line cost to preserve
   * recall; tokenEstimate honestly measures the structured payload). It is sized
   * so a healthy connector payload passes but uncounted CONTENT (the events
   * regression) does not — against the suite's controlled seed store, not as a
   * universal runtime bound for an arbitrarily memory-heavy store.
   */
  budgetCap?: { estimate: string; budget: string; tolerance: number };
  /**
   * Count coherence (flair#1207): for each triple, `included + truncated <=
   * available`. 0.44.9 reported available:3 included:2 truncated:2 (2+2 > 3)
   * because a memory budget-skipped in one section was re-counted in the
   * task-relevant loop, and a predicted memory could be admitted twice. Included
   * and truncated must be DISJOINT subsets of the available pool. Applied to the
   * own-memory triple (memoriesIncluded/Truncated/Available) and the teammate
   * triple (teammateFindingsIncluded/Truncated/Matched).
   */
  countCoherence?: Array<{ included: string; truncated: string; available: string }>;
  /**
   * At the /mcp default the prose `field` (context) must be a compact POINTER,
   * never a second copy of the structured bodies — the structured containers
   * are canonical; prose is opt-in via includeContext (flair#1199). The suite
   * asserts it carries none of the delivered event summaries / memory contents.
   */
  proseContextIsPointerAtDefault?: { field: string };
  /**
   * Per-element rules for a named array container: every element carries
   * `requiredFields` and leaks none of `forbiddenFields`. Lets the leaked-
   * internal-fields invariant (#1188) bite on bootstrap's `memories` and the
   * shape invariant on its `events`, not just the flat record tools.
   */
  containerRules?: Array<{ container: string; requiredFields?: string[]; forbiddenFields?: readonly string[] }>;
  /**
   * Documents that the suite's UNIVERSAL structural check applies here (it runs
   * on every tool regardless): no field value is a JSON-stringified object/
   * array, and nothing serialized to a pending Promise or `[object Object]`
   * (flair#1199/#1182 — the payload is fully resolved and structured).
   */
  fullyResolved?: boolean;
}

/**
 * The declarative consumer contract for one /mcp tool. `requiredFields`,
 * `fieldTypes` and `forbiddenFields` describe the RESULT OBJECT the tool
 * returns; `invariants` carry the cross-field semantics; `errorShape` pins the
 * one error case a connector must be able to parse (Kern #5).
 */
export interface ToolContract {
  /** One line: what a connector gets back from this tool. */
  summary: string;
  /** Fields that MUST be present (and not undefined) on the result object. */
  requiredFields?: string[];
  /** Expected JS type per field on the result object. */
  fieldTypes?: Record<string, FieldType>;
  /**
   * Fields that must NEVER appear on the result object. For the memory record
   * tools this is `INTERNAL_MEMORY_FIELDS` — BOTH `embedding` and
   * `embeddingModel` (flair#1188 + flair#1213 Sherlock #1), so the invariant
   * bites on either leak.
   */
  forbiddenFields?: readonly string[];
  invariants?: ToolInvariants;
  /**
   * One error case: the shape a connector must be able to parse when the tool
   * refuses. `trigger` is a human note on how the suite provokes it; the
   * response must carry every field in `fields` and leak none in `mustNotLeak`
   * (no stack traces / internal paths).
   */
  errorShape?: { trigger: string; fields: string[]; mustNotLeak?: readonly string[] };
}

/**
 * The tool registry: definition (for tools/list) + implementation (for
 * tools/call) + the connector CONTRACT (for the flair#1213 conformance suite),
 * keyed by tool name. The single source of truth for the advertised surface,
 * the dispatch table, AND the consumer contract — so none of the three can
 * drift (a tool listed but not callable, or shipped without a contract, is
 * impossible: `contract` is required by the type and by
 * `checkContractCompleteness` at runtime).
 */
interface ToolEntry {
  def: McpToolDef;
  impl: ToolImpl;
  contract: ToolContract;
}

/** The result of the flair#1213 completeness gate. */
export interface CompletenessResult {
  ok: boolean;
  /** How many tools the gate actually enumerated. `> 0` on any non-vacuous run. */
  examined: number;
  /** Tool names shipped with no contract. */
  missing: string[];
  reason?: string;
}

/**
 * flair#1213 completeness gate — FAIL-CLOSED (the flair#953 lesson, Sherlock
 * #3). Every tool shipped in `tools` must carry a `.contract`; a new /mcp tool
 * without one fails the build.
 *
 * The fail-closed part is the point: if the registry cannot be enumerated — it
 * is not a plain object (a broken import left it `undefined`), or it is empty —
 * this returns `ok:false` with `examined:0`, NEVER a vacuous "0 tools examined,
 * 0 missing, pass". A check that could not run must not render as passed. The
 * conformance suite asserts both `ok` AND `examined > 0` so the vacuous path
 * cannot masquerade as coverage; the fail-closed unit test exercises every
 * branch.
 */
export function checkContractCompleteness(
  tools: Record<string, ToolEntry> | Record<string, { contract?: unknown }> | undefined | null,
): CompletenessResult {
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
    return {
      ok: false,
      examined: 0,
      missing: [],
      reason: "TOOLS registry is not an enumerable object (unloadable import?) — refusing to pass vacuously",
    };
  }
  const names = Object.keys(tools);
  if (names.length === 0) {
    return {
      ok: false,
      examined: 0,
      missing: [],
      reason: "TOOLS registry is empty — refusing to pass vacuously (a new tool must carry a conformance contract)",
    };
  }
  const missing = names.filter((n) => {
    const entry = (tools as Record<string, { contract?: unknown }>)[n];
    return !entry || !entry.contract || typeof entry.contract !== "object";
  });
  return {
    ok: missing.length === 0,
    examined: names.length,
    missing,
    reason: missing.length
      ? `${missing.length} tool(s) shipped with no conformance contract: ${missing.join(", ")}. `
        + "Add a `contract` to each in resources/mcp-tools.ts (co-located with its def+impl)."
      : undefined,
  };
}

/**
 * Verb→tool-name overrides — the three naming quirks where the shipped tool
 * name isn't record-types.ts's default `${toolPrefix}_${verb}` shape (see
 * that module's `mcp` header doc, and RECORD_TYPES.<Table>.mcp itself,
 * record-types slice 3, flair#520). Keyed by table name + verb; consumed by
 * `mcpToolName()` below and by test/unit/mcp-surface-tripwire.test.ts to
 * compute the expected tool name for every declared registry verb.
 *
 * Placement here (not in record-types.ts) is deliberate — per Kern/
 * Sherlock's unanimous slice-3 verdict, the registry declares WHAT is
 * exposed (capability: toolPrefix + verbs); this map declares HOW that
 * capability's tool is actually named (presentation). Coupling names into
 * the registry would mix the policy layer with the presentation layer,
 * exactly what the registry's separation is meant to avoid.
 */
export const TOOL_NAME_OVERRIDES: Partial<
  Record<RecordTypeName, Partial<Record<"get" | "search" | "store" | "delete" | "update", string>>>
> = {
  Soul: { store: "soul_set" },
  WorkspaceState: { store: "flair_workspace_set" },
  OrgEvent: { store: "flair_orgevent" },
};

/**
 * Resolve the actual `TOOLS` key for a declared (table, verb) pair: the
 * `TOOL_NAME_OVERRIDES` entry if one exists, else the default
 * `${toolPrefix}_${verb}` shape. `toolPrefix` is passed in (rather than
 * looked up from RECORD_TYPES here) so this stays a pure naming function —
 * both this module and the tripwire test call it with the registry's own
 * `toolPrefix` value, keeping the naming rule in exactly one place.
 */
export function mcpToolName(table: RecordTypeName, toolPrefix: string, verb: string): string {
  const override = TOOL_NAME_OVERRIDES[table]?.[verb as "get" | "search" | "store" | "delete" | "update"];
  return override ?? `${toolPrefix}_${verb}`;
}

export const TOOLS: Record<string, ToolEntry> = {
  memory_search: {
    def: {
      name: "memory_search",
      description:
        "Search memories by meaning. Understands temporal queries like 'what happened today'. Scoped to your agent's own + granted memories.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query — natural language, semantic matching" },
          limit: { type: "number", description: "Max results (default 5)" },
          includeTrust: { type: "boolean", description: "Attach a per-result trust-evidence block (provenance, author, usage, freshness, supersession). Default false." },
          abstain: { type: "boolean", description: "Opt into first-class abstention: when the best match is below a global confidence threshold, return { abstained: true, reason, bestScore } with no weak matches instead of the N weakest results. Default false." },
        },
        required: ["query"],
      },
    },
    impl: memorySearch,
    contract: {
      summary: "{ results: MemoryRecord[] } — semantic hits scoped to the caller's own + granted memories; each hit carries content, never the raw embedding.",
      requiredFields: ["results"],
      fieldTypes: { results: "array" },
      invariants: {
        selfDescribingEmpty: [{ path: "results", type: "array" }],
        containerRules: [{ container: "results", requiredFields: ["id", "content"], forbiddenFields: INTERNAL_MEMORY_FIELDS }],
        fullyResolved: true,
      },
    },
  },
  memory_store: {
    def: {
      name: "memory_store",
      description:
        "Save information to persistent memory. Use for lessons, decisions, preferences, facts. Attributed to your authenticated agent.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "What to remember" },
          type: { type: "string", enum: ["session", "lesson", "decision", "preference", "fact", "goal"], description: "Memory type (default session)" },
          durability: { type: "string", enum: ["permanent", "persistent", "standard", "ephemeral"], description: "permanent > persistent > standard > ephemeral (default standard)" },
          tags: { type: "array", items: { type: "string" }, description: "Tag strings" },
          visibility: {
            type: "string",
            enum: ["private", "shared"],
            description:
              "Writer-controlled sharing intent. Omit to use the server's durability-keyed default: " +
              "permanent/persistent -> shared, standard/ephemeral -> private. " +
              "private — owner-only, never visible to another agent, even one holding a memory grant. " +
              "shared — visible to the owner and every other agent on this instance. " +
              "The visibility the write actually landed on is returned in the result.",
          },
          usedMemoryIds: { type: "array", items: { type: "string" }, description: "IDs of memories that informed this write (citation-on-write). Credited via the same deduped usage ledger as record_usage. Optional." },
        },
        required: ["content"],
      },
    },
    impl: memoryStore,
    contract: {
      summary: "Write echo { id, written:true, deduplicated } — the new id + confirmation. No internal embedding fields; round-trips via memory_get.",
      requiredFields: ["id", "written"],
      fieldTypes: { id: "string", written: "boolean", deduplicated: "boolean" },
      forbiddenFields: INTERNAL_MEMORY_FIELDS,
      invariants: { fullyResolved: true },
      errorShape: { trigger: "an unrecognized visibility value (e.g. \"prvate\")", fields: ["error", "status"], mustNotLeak: INTERNAL_MEMORY_FIELDS },
    },
  },
  memory_update: {
    def: {
      name: "memory_update",
      description:
        "Update an existing memory by ID. Dedup-bypassed (this is an intentional overwrite, not a new write). " +
        "Default: overwrites the same id in place. Pass preserveHistory=true to instead write a new version " +
        "linked via `supersedes`, closing the old one's validity window.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "ID of the memory to update" },
          content: { type: "string", description: "New content" },
          preserveHistory: { type: "boolean", description: "Write a new version (supersedes-linked) instead of overwriting in place (default false)" },
        },
        required: ["id", "content"],
      },
    },
    impl: memoryUpdate,
    contract: {
      summary: "Write echo { id, written:true } for the in-place overwrite (or supersede). No internal embedding fields; the change round-trips via memory_get.",
      requiredFields: ["id", "written"],
      fieldTypes: { id: "string", written: "boolean" },
      forbiddenFields: INTERNAL_MEMORY_FIELDS,
      invariants: { fullyResolved: true },
      errorShape: { trigger: "updating a non-existent id", fields: ["error", "status"] },
    },
  },
  memory_get: {
    def: {
      name: "memory_get",
      description:
        "Retrieve a specific memory by ID. The record's raw embedding vector is omitted by default (it is large and not useful to a caller); pass includeEmbedding=true to include it.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory ID" },
          includeTrust: { type: "boolean", description: "Attach a trust-evidence block (provenance, author, usage, freshness, supersession) to the record. Default false." },
          includeEmbedding: { type: "boolean", description: "Include the raw embedding vector (hundreds of floats) in the returned record. Omitted by default because it is large and rarely useful to a caller. Default false." },
        },
        required: ["id"],
      },
    },
    impl: memoryGet,
    contract: {
      summary: "The full memory record { id, agentId, content, durability, createdAt, ... } for the caller's own id — embedding + embeddingModel stripped by default.",
      requiredFields: ["id", "agentId", "content", "createdAt"],
      fieldTypes: { id: "string", agentId: "string", content: "string" },
      forbiddenFields: INTERNAL_MEMORY_FIELDS,
      invariants: { fullyResolved: true },
      errorShape: { trigger: "get a non-existent / unowned id (makeByIdReadGate 404)", fields: ["error", "status"] },
    },
  },
  memory_delete: {
    def: {
      name: "memory_delete",
      description: "Delete a memory by ID. You can only delete your own memories.",
      annotations: { destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Memory ID to delete" } },
        required: ["id"],
      },
    },
    impl: memoryDelete,
    contract: {
      summary: "Deletes the caller's own memory (success echo is thin). The permanent-memory guard returns { error, status:403 } for a non-admin; the row round-trips as gone via memory_get.",
      invariants: { fullyResolved: true },
      errorShape: { trigger: "a non-admin deletes a permanent memory", fields: ["error", "status"] },
    },
  },
  bootstrap: {
    def: {
      name: "bootstrap",
      description:
        "Get session context: soul + memories + predicted context. Run at session start. Pass subjects for predictive loading.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          maxTokens: { type: "number", description: "Content-selection budget in tokens (default 4000): the hard cap on how much soul/memory/finding CONTENT is selected. The actual serialized response (reported by tokenEstimate) may exceed this by the structured-container JSON scaffolding — maxTokens bounds what is selected, not the raw output size. Raise it to include more content." },
          currentTask: { type: "string", description: "Current task — enables semantic search for relevant memories" },
          channel: { type: "string", description: "Channel name (discord, tps-mail, claude-code)" },
          surface: { type: "string", description: "Surface name (tps-build, tps-review, cli-session)" },
          subjects: { type: "array", items: { type: "string" }, description: "Entity names to preload context for" },
          entities: {
            type: "array",
            items: { type: "string" },
            description:
              "Your declared attention-plane vocabulary strings (e.g. \"issue:owner/repo#123\") for collision surfacing's 'Others in the room' block — teammates with overlapping active work. Falls back to your own most-recent workspace-state entities when omitted.",
          },
          includeTrust: { type: "boolean", description: "Also return a `trust` array with a per-included-memory trust-evidence block (provenance, author, usage, freshness, supersession). Default false." },
          abstain: { type: "boolean", description: "Opt into a task-relevance abstention verdict: also return an `abstention` object ({ abstained, bestScore, threshold }) reporting whether any memory covered `currentTask` above a global confidence threshold. Default false." },
          includeContext: { type: "boolean", description: "Also return the prose `context` string — a human-readable mirror of the structured soul/memories/predicted/teammateFindings containers (which are the canonical payload). Default false here: the structured fields already carry everything, so shipping the prose too would double the payload." },
          maxEvents: { type: "number", description: "Cap on how many recent org events to return (default 10). Events are counted against maxTokens like every other content section." },
          includeEventDetail: { type: "boolean", description: "Also include each org event's verbose `detail` JSON (migration internals, etc.). Default false: bootstrap ships lean events (id/kind/summary/createdAt/targetIds/scope); `detail` mostly restates the summary and is pure bloat for a connector." },
        },
      },
    },
    impl: bootstrap,
    contract: {
      summary:
        "Session context: { agentId, soul, memories, predicted, teammateFindings, events, sections, tokenEstimate, memoriesIncluded, ..., context, flairVersion }. "
        + "Structured containers are canonical and always present; prose `context` is a pointer at the /mcp default (includeContext opt-in).",
      requiredFields: [
        "agentId", "soul", "memories", "predicted", "teammateFindings", "events",
        "sections", "tokenEstimate", "maxTokens", "memoriesIncluded", "memoriesAvailable",
        "memoriesTruncated", "teammateFindingsIncluded", "teammateFindingsTruncated",
        "teammateFindingsMatched", "context", "flairVersion",
        // flair#1270 — the payload token LEDGER: every token-charged content
        // class has a counter, so tokenEstimate ≈ scaffoldTokens + soulTokens +
        // memoryTokens + trustTokens + eventsTokens decomposes from the payload
        // alone (see the identity block in MemoryBootstrap's response tail).
        "soulTokens", "memoryTokens", "trustTokens", "eventsTokens", "scaffoldTokens",
      ],
      fieldTypes: {
        agentId: "string", soul: "object", memories: "array", predicted: "array",
        teammateFindings: "array", events: "array", sections: "object",
        tokenEstimate: "number", maxTokens: "number", memoriesIncluded: "number",
        memoriesAvailable: "number", memoriesTruncated: "number",
        teammateFindingsIncluded: "number", teammateFindingsTruncated: "number",
        teammateFindingsMatched: "number", context: "string", flairVersion: "string",
        soulTokens: "number", memoryTokens: "number", trustTokens: "number",
        eventsTokens: "number", scaffoldTokens: "number",
      },
      invariants: {
        // count == delivered — the historical count/charge/deliver drift.
        countEqualsDelivered: [
          // memoriesIncluded spans BOTH own-memory containers (see the type doc).
          { count: "memoriesIncluded", containers: ["memories", "predicted"] },     // #1199
          { count: "teammateFindingsIncluded", containers: ["teammateFindings"] },  // #1199
          { count: "sections.events", containers: ["events"] },                     // #1206
        ],
        // present + typed even when empty — never a bare {} / missing key (#1182).
        selfDescribingEmpty: [
          { path: "soul", type: "object" }, { path: "memories", type: "array" },
          { path: "predicted", type: "array" }, { path: "teammateFindings", type: "array" },
          { path: "events", type: "array" }, { path: "sections", type: "object" },
        ],
        // #1200 — dedup by the SEMANTIC content key (excludes id/createdAt, which
        // vary across physical duplicate rows). See ToolInvariants.dedupSignature.
        dedupSignature: { container: "events", signatureFields: ["kind", "summary", "detail", "targetIds"] },
        // #1199 — tokenEstimate via the wrapper's own estimator over the delivered
        // payload (minus the two fields added after it was measured).
        tokenEstimate: { field: "tokenEstimate", excludeKeys: ["tokenEstimate", "flairVersion"] },
        // #1199 — the reported estimate must respect the requested budget: the
        // events blowout (uncounted org events) drove maxTokens=4000 → 6286. The
        // tolerance covers the fixed JSON scaffolding + the #1207 prose-vs-
        // structured charge gap; uncounted content does not fit under it.
        budgetCap: { estimate: "tokenEstimate", budget: "maxTokens", tolerance: 0.25 },
        // #1207 — count arithmetic: included + truncated <= available, for own
        // memories AND teammate findings (each a disjoint split of its pool).
        countCoherence: [
          { included: "memoriesIncluded", truncated: "memoriesTruncated", available: "memoriesAvailable" },
          { included: "teammateFindingsIncluded", truncated: "teammateFindingsTruncated", available: "teammateFindingsMatched" },
        ],
        // #1199 — prose is a pointer at the default, not a second copy.
        proseContextIsPointerAtDefault: { field: "context" },
        // shape of the structured containers a connector reads; #1188 leak bites on memories.
        containerRules: [
          { container: "events", requiredFields: ["id", "kind", "summary", "createdAt"] },
          { container: "memories", requiredFields: ["id", "content"], forbiddenFields: INTERNAL_MEMORY_FIELDS },
        ],
        fullyResolved: true, // #1182 — never a spread pending Promise collapsing to {flairVersion}.
      },
    },
  },
  soul_set: {
    def: {
      name: "soul_set",
      description: "Set a personality or project context entry. Included in every bootstrap.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Entry key (e.g. 'role', 'standards', 'project')" },
          value: { type: "string", description: "Entry value" },
        },
        required: ["key", "value"],
      },
    },
    impl: soulSet,
    contract: {
      summary: "Writes a soul entry keyed `${agentId}:${key}`, attributed to the caller. Correctness is proven by the soul_get round-trip — this is the write flair#1181 broke on the connector path.",
      invariants: { fullyResolved: true },
    },
  },
  soul_get: {
    def: {
      name: "soul_get",
      description: "Get a personality or project context entry.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", description: "Entry key" } },
        required: ["key"],
      },
    },
    impl: soulGet,
    contract: {
      summary: "The soul entry { id, agentId, key, value, createdAt } for the caller's own `${agentId}:${key}`.",
      requiredFields: ["id", "agentId", "key", "value", "createdAt"],
      fieldTypes: { id: "string", agentId: "string", key: "string", value: "string" },
      invariants: { fullyResolved: true },
    },
  },
  flair_workspace_set: {
    def: {
      name: "flair_workspace_set",
      description:
        "Set your agent's current workspace state in the Office Space coordination layer. Attributed to you — you can only write your own state.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Workspace ref — branch, worktree, or task ref" },
          label: { type: "string", description: "Human-readable label" },
          provider: { type: "string", description: "Provider/runtime (default mcp)" },
          task: { type: "string", description: "Task/issue id" },
          phase: { type: "string", description: "Current phase (design, implement, review)" },
          summary: { type: "string", description: "Short summary of current state" },
        },
        required: ["ref"],
      },
    },
    impl: workspaceSet,
    contract: {
      summary: "Writes the caller's workspace state keyed `${agentId}:${ref}`, attributed to the caller (never the body). The echo is thin; persistence is verified in storage.",
      invariants: { fullyResolved: true },
    },
  },
  flair_orgevent: {
    def: {
      name: "flair_orgevent",
      description:
        "Publish an org-wide coordination event (claim/release/status) to the Office Space. Attributed to you — you cannot publish as another agent.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", description: "Event kind (coord.claim, coord.release, status)" },
          summary: { type: "string", description: "Short summary of the event" },
          detail: { type: "string", description: "Longer detail payload" },
          scope: { type: "string", description: "Scope (an agent id, repo, or 'org')" },
          targets: { type: "array", items: { type: "string" }, description: "Recipient agent ids" },
        },
        required: ["kind", "summary"],
      },
    },
    impl: orgEvent,
    contract: {
      summary: "Publishes an org event attributed to the caller (authorId from identity, never the body). The echo is thin; persistence is verified in storage.",
      invariants: { fullyResolved: true },
    },
  },
  attention: {
    def: {
      name: "attention",
      description:
        "What's touching entity E in the last N days? A unified, grouped-by-source view across memories, " +
        "relationships, active work (WorkspaceState), teammate presence, and org events. Entity must be a " +
        "vocabulary string (e.g. 'repo:owner/name', 'issue:owner/repo#123', 'subsystem:embeddings').",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Vocabulary string, exact match (type:value — e.g. 'repo:tpsdev-ai/flair')" },
          days: { type: "number", description: "Window size in days (default 7)" },
        },
        required: ["entity"],
      },
    },
    impl: attention,
    contract: {
      summary: "Grouped-by-source view { entity, windowDays, since, groups:{memory,relationship,workspaceState,presence,orgEvent}, counts } for entity E over N days.",
      requiredFields: ["entity", "windowDays", "groups", "counts"],
      fieldTypes: { entity: "string", windowDays: "number", groups: "object", counts: "object" },
      invariants: {
        selfDescribingEmpty: [{ path: "groups", type: "object" }, { path: "counts", type: "object" }],
        fullyResolved: true,
      },
    },
  },
  record_usage: {
    def: {
      name: "record_usage",
      description:
        "Report that one or more memories were actually USED — cited or relied on to ground an answer or decision. " +
        "Distinct from search (surfacing a memory is not usage). Drives the recall-quality usage signal; dedup'd " +
        "(you can only count once per memory) and rate-limited.",
      inputSchema: {
        type: "object",
        properties: {
          memoryIds: { type: "array", items: { type: "string" }, description: "IDs of the memories that were used (max 20 per call)" },
          memoryId: { type: "string", description: "Convenience alias for a single memory id (use memoryIds for multiple)" },
          attribution: { type: "string", description: "Optional free-text note on what used it (opaque — stored for audit only, max 500 chars)" },
        },
      },
    },
    impl: recordUsage,
    contract: {
      summary: "Invariant acknowledgement { recorded:true } — byte-identical regardless of how many ids counted (no id enumeration, Sherlock).",
      requiredFields: ["recorded"],
      fieldTypes: { recorded: "boolean" },
      invariants: { fullyResolved: true },
    },
  },
};

/** The tool definitions for a tools/list response (exactly the 12 curated tools). */
export function listToolDefs(): McpToolDef[] {
  return Object.values(TOOLS).map((t) => t.def);
}
