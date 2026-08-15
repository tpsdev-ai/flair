/**
 * ─── Reference implementation: N agents, in-process, no CLI and no shell ──────
 *
 * This is a component of a SEPARATE Harper application that loads Flair as a
 * sub-component (see ../config.yaml). Everything below runs inside the Harper
 * process; nothing shells out, nothing goes over HTTP to Flair, and nothing
 * touches the filesystem. It is the shape a Fabric deployment has, where there
 * is no shell on the node at all.
 *
 * Copy the three helpers at the top — `flair()`, `registerAgent()`,
 * `remember()`/`recall()` — into your own component and you have the whole
 * integration. `test/integration/in-process-agents.test.ts` drives this file
 * and asserts the properties that make it safe: registration lands a complete
 * Principal record, every call is attributed to ONE agent, an agent cannot
 * write as another, and an agent cannot read another's private memories.
 *
 * Kept as plain JS (no build step) so it loads through the `jsResource` glob
 * exactly as a hand-written application component would.
 */
import { Resource, server } from "harper";
// The in-process call seam. Deep-imported from the installed package the same
// way an application would — Flair ships `dist/`, and this module has no
// dependencies of its own.
import { agentContext, adminContext, internalContext, collectionResource } from "@tpsdev-ai/flair/server";

/**
 * Resolve a Flair RESOURCE by its REST path.
 *
 * NOT `databases.flair.Memory` — that is the raw table, and enforces none of
 * Flair's auth, read-scoping, attribution or embedding. Flair exports a
 * SUBCLASS of each table as the resource, and Harper registers exported classes
 * in the routing map only, never back into `databases`.
 *
 * Resolved lazily, per call. Measured on Harper 5.1.22: Flair's entries are in
 * fact already present when THIS module's top level runs (the sub-component
 * loads first; the only entry missing at that moment is this component's own).
 * Lazy resolution is kept anyway — it costs one Map lookup and does not depend
 * on component load order staying that way.
 *
 * Registry keys carry NO leading slash: get("Memory"), never get("/Memory").
 * The same holds for getMatch — getMatch("Memory") hits, getMatch("/Memory")
 * misses.
 */
const flair = (path) => {
  const entry = server.resources.get(path);
  if (!entry) throw new Error(`Flair resource '${path}' is not registered (loaded: ${[...server.resources.keys()].sort().join(", ")})`);
  return entry.Resource;
};

/**
 * Register an agent. No CLI, no keystore, no shell.
 *
 * Goes through Flair's `Agent` resource (not the raw table) so the record gets
 * the full Principal shape — kind/status/displayName/admin/defaultTrustTier and
 * the federation originator stamp — from one source instead of a hand-copied
 * literal that drifts.
 *
 * `publicKey` is required by the schema. An agent that only ever acts
 * in-process never authenticates, so a placeholder is honest there; supply a
 * real Ed25519 public key (raw 32 bytes, base64 or hex) when the same agent
 * must ALSO authenticate over HTTP. Generating that key needs nothing but
 * `node:crypto` — see the test.
 */
async function registerAgent({ id, publicKey = "pending", displayName, runtime = "headless" }) {
  // No context ⇒ Flair's trusted `internal` verdict. Correct for provisioning,
  // which is infrastructure work your app has already authorised; never use a
  // context-less call to read or write on an agent's behalf (see below).
  const h = await collectionResource(flair("Agent"), internalContext());
  return h.post({ id, name: id, displayName: displayName ?? id, publicKey, runtime });
}

/**
 * Test-only: pick the identity constructor. An application writes
 * `agentContext(id)` and nothing else — `adminContext()` is a separate, more
 * alarming name precisely so a flag from elsewhere can never turn an agent call
 * into an admin one. This fixture branches only so the test can prove that
 * admin, like identity, is ASSERTED rather than checked.
 */
const actingAs = (agentId, asAdmin) => (asAdmin === true ? adminContext(agentId) : agentContext(agentId));

/**
 * Write a memory AS a specific agent.
 *
 * ─── WHERE `agentId` COMES FROM IS THE SECURITY BOUNDARY ─────────────────────
 * In-process identity is ASSERTED, not verified: Flair reads `tpsAgent` off the
 * context and acts as that agent. No signature, no lookup, no registration
 * required. So `agentId` must be resolved from YOUR OWN server-side state — the
 * session your app authenticated, the job record it dequeued — and NEVER from
 * request data. An agent id that reaches this function from a body field or a
 * header your app did not itself verify is privilege escalation with no error
 * and no trace.
 *
 * In THIS fixture it comes straight off the request body, because the test's
 * whole job is to drive specific identities and prove what each one can and
 * cannot do. That is the one context in which it is correct. Do not copy that
 * part.
 *
 * `agentContext()` refuses a missing or empty id rather than defaulting, so
 * "I forgot the id" fails loudly instead of resolving to Flair's unfiltered
 * `internal` verdict. An application never has to remember that rule — but it
 * should still resolve `agentId` before it gets here, not hope for the throw.
 */
async function remember(agentId, { content, durability = "standard", visibility, ownerAgentId, asAdmin }) {
  const h = await collectionResource(flair("Memory"), actingAs(agentId, asAdmin));
  // `ownerAgentId` exists only so the test can attempt a forgery — acting as
  // one agent while claiming another owns the record. Flair 403s that; an
  // application would simply pass `agentId` and never expose the distinction.
  const body = { agentId: ownerAgentId ?? agentId, content, durability };
  if (visibility) body.visibility = visibility;
  return h.post(body);
}

/**
 * Everything `agentId` is allowed to see: its own records, plus every other
 * agent's non-private ones. Same boundary as `remember` — see its doc for where
 * `agentId` may and may not come from.
 */
async function recall(agentId, { asAdmin } = {}) {
  const rows = await flair("Memory").search({ conditions: [] }, actingAs(agentId, asAdmin));
  return collect(rows);
}

/**
 * Semantic recall, scoped to `agentId`. Same boundary as `remember`. This is the
 * path a real agent loop actually reads through, so it is the one that matters:
 * a vector index is global, and the scope has to be applied to the results.
 */
async function semanticRecall(agentId, q, limit = 20) {
  const h = await collectionResource(flair("SemanticSearch"), agentContext(agentId));
  const r = await h.post({ q, limit });
  if (r instanceof Response) return { status: r.status };
  const list = r?.results ?? r?.memories ?? r;
  return Array.isArray(list) ? list.map(summarise) : list;
}

/** The same semantic read with NO context — see `recallUnscoped`. */
async function semanticRecallUnscoped(q, limit = 20) {
  const h = await collectionResource(flair("SemanticSearch"), internalContext());
  const r = await h.post({ q, limit });
  if (r instanceof Response) return { status: r.status };
  const list = r?.results ?? r?.memories ?? r;
  return Array.isArray(list) ? list.map(summarise) : list;
}

/** A single record by id, scoped to `agentId` — another agent's private record reads as absent. */
async function recallById(agentId, id) {
  const record = await flair("Memory").get(id, agentContext(agentId));
  return record && typeof record === "object" && !(record instanceof Response) ? summarise(record) : null;
}

// ─── flair#1181 — the by-id read access-pattern bug, reproduced on real Harper ─
//
// `recallById` above is the CORRECT static form — `Cls.get(id, context)` — the
// one resources/mcp-tools.ts's fixed by-id reads use, the same transactional
// path the Ed25519 REST route takes. The three ops below drive the exact
// divergence #1181 was about, against a real Memory resource + makeByIdReadGate:

/**
 * The PRE-FIX mcp-tools pattern: an INSTANCE by-id read,
 * `new Cls(undefined, ctx).get(id)`. Harper routes `.get(<string>)` on an
 * unloaded instance (loadAsInstance at its default) to `getProperty()` — a
 * field accessor — so the row never loads and makeByIdReadGate 404s the
 * caller's OWN record. This op exists ONLY to reproduce the bug; do not copy it.
 */
async function recallByIdInstance(agentId, id) {
  const Cls = flair("Memory");
  const record = await new Cls(undefined, agentContext(agentId)).get(id);
  return record && typeof record === "object" && !(record instanceof Response) ? summarise(record) : null;
}

/**
 * The FIXED static by-id read WITH includeTrust folded into the RequestTarget
 * as a plain property (mcp-tools memory_get; static `Cls.get` has no opts slot).
 * Proves the trust block still attaches end-to-end through the real Memory.get()
 * → wantsTrust() path after the migration.
 */
async function recallByIdTrust(agentId, id) {
  const record = await flair("Memory").get({ id, includeTrust: true }, agentContext(agentId));
  if (!record || record instanceof Response) return null;
  return { ...summarise(record), hasTrust: record.trust !== undefined, trust: record.trust ?? null };
}

/**
 * The FIXED memory_delete path: static `Cls.delete(id, context)`. Memory.delete()
 * loads the row via `super.get(id)` to run the permanent-memory admin guard; the
 * static form makes that load see the real record (the instance form getProperty'd
 * to undefined and skipped the guard). Returns whether the row is gone afterward.
 */
async function deleteById(agentId, id) {
  await flair("Memory").delete(id, agentContext(agentId));
  const after = await flair("Memory").get(id, agentContext(agentId));
  return { deleted: !after || after instanceof Response };
}

/**
 * The FIXED memory_update DEFAULT path, mirrored exactly (mcp-tools memoryUpdate):
 * static existing-read, then a STATIC `Cls.put(merged, ctx)` write leg. The
 * instance write leg `new Cls(undefined, ctx).put(merged)` throws
 * "Invalid primary key type: undefined" on an unloaded instance — this op
 * proves the static write round-trips end-to-end.
 */
async function updateById(agentId, id, content) {
  const Cls = flair("Memory");
  const existing = await Cls.get(id, agentContext(agentId));      // static by-id read (the #1181 fix)
  if (!existing || existing instanceof Response) return { updated: false, reason: "not-found" };
  const merged = { ...existing, content, updatedAt: new Date().toISOString() };
  delete merged.embedding;
  delete merged.embeddingModel;
  await Cls.put(merged, agentContext(agentId));                  // static write leg (the #1181 fix)
  const after = await Cls.get(id, agentContext(agentId));
  return { updated: after && after.content === content, content: after?.content ?? null };
}

// ─── flair#1182 (part 2) — the /mcp `bootstrap` wrapper drops the payload ──────
//
// resources/mcp-tools.ts's `bootstrap` tool wrapper builds its response as
// `{ ...unwrap(await h.post(body)), flairVersion }`. `unwrap` is an ASYNC
// function, so the sibling write/read tools spell it `await unwrap(...)`;
// `bootstrap` omitted the await, so `result` was the unresolved PROMISE. Object-
// spreading a Promise copies no own-enumerable keys (`{...aPromise}` === `{}`),
// so the entire rich payload BootstrapMemories.post computed — agentId, scope,
// soul, memories, predicted, the #1182.1 containers, the abstention verdict —
// was discarded and only the injected `flairVersion` survived. This op drives
// the REAL `resources/mcp-tools.ts` bootstrap wrapper (not a mirror) against the
// real BootstrapMemories resource + real store, so the fix — and its mutation
// proof — land on the shipped line. Imported dynamically (a relative path that
// bypasses the package `exports` gate) so nothing else that loads this fixture
// pays for the import.
async function bootstrapViaMcp(agentId, args) {
  const { TOOLS } = await import("../node_modules/@tpsdev-ai/flair/dist/resources/mcp-tools.js");
  return TOOLS.bootstrap.impl({ agentId, isAdmin: false }, args ?? {});
}

/**
 * The DELIBERATELY unfiltered read — every agent's private records, by name.
 * `internalContext()` is what an infrastructure sweep asks for on purpose; an
 * application must never reach this verdict, and since it now has to type this
 * function to get there, it cannot reach it by accident.
 */
async function recallUnscoped() {
  return collect(await flair("Memory").search({ conditions: [] }, internalContext()));
}

// ── Guard probes ────────────────────────────────────────────────────────────
// Not things an application does — the test drives these to prove that the
// forgot-the-argument paths fail closed, and to pin the hazard they exist for.

/** `agentContext(<bad id>)` must throw rather than return a usable context. */
function buildContextWith(agentId) {
  const ctx = agentContext(agentId);           // expected to throw
  return { threw: false, ctx };                // reached only if the guard is gone
}

/** `collectionResource(Cls)` with the context argument left off must throw. */
async function createWithNoContext() {
  const h = await collectionResource(flair("Memory"));   // expected to throw
  return { threw: false, isCollection: h?.isCollection };
}

/**
 * THE HAZARD THE GUARD EXISTS FOR — bypasses `agentContext()` and hands the
 * resolver the raw shape a forgotten id used to produce. If this stops
 * returning other agents' private records, the guard has become unnecessary and
 * this fixture (and the warnings around it) should be revisited. Until then it
 * is the evidence that "I forgot the id" really did mean "I am an administrator".
 */
async function recallWithRawMissingId() {
  const forgotten = { request: { tpsAgent: undefined, tpsAgentIsAdmin: false } };
  return collect(await flair("Memory").search({ conditions: [] }, forgotten));
}

const summarise = (r) => ({ id: r?.id, agentId: r?.agentId, visibility: r?.visibility, content: r?.content });

async function collect(rows) {
  const out = [];
  if (!rows) return out;
  if (rows instanceof Response) return out;
  if (typeof rows[Symbol.asyncIterator] === "function") { for await (const r of rows) out.push(summarise(r)); return out; }
  if (typeof rows[Symbol.iterator] === "function") { for (const r of rows) out.push(summarise(r)); return out; }
  return [summarise(rows)];
}

/**
 * Flair handlers return a `Response` for 401/403/400 rather than throwing.
 * Surface status + body so the caller sees the real refusal.
 */
async function run(fn) {
  try {
    const value = await fn();
    if (value instanceof Response) {
      return { ok: false, status: value.status, body: await value.text().catch(() => "") };
    }
    return { ok: true, value: value ?? null };
  } catch (err) {
    // Surfaced rather than thrown so a failing assertion in the test reads as
    // the real cause instead of an opaque 500.
    return { ok: false, error: String(err?.message ?? err), errorName: err?.name };
  }
}

/** POST /AgentFleet {"op": …} — the test's remote control over the code above. */
export class AgentFleet extends Resource {
  async post(body) {
    const op = body?.op;
    switch (op) {
      case "registered":
        return run(() => [...server.resources.keys()].sort());
      case "register":
        return run(() => registerAgent(body));
      case "remember":
        return run(() => remember(body.agentId, body));
      case "recall":
        return run(() => recall(body.agentId, body));
      case "recallById":
        return run(() => recallById(body.agentId, body.id));
      case "recallByIdInstance":
        return run(() => recallByIdInstance(body.agentId, body.id));
      case "recallByIdTrust":
        return run(() => recallByIdTrust(body.agentId, body.id));
      case "deleteById":
        return run(() => deleteById(body.agentId, body.id));
      case "updateById":
        return run(() => updateById(body.agentId, body.id, body.content));
      case "semanticRecall":
        return run(() => semanticRecall(body.agentId, body.q, body.limit));
      case "semanticRecallUnscoped":
        return run(() => semanticRecallUnscoped(body.q, body.limit));
      case "recallUnscoped":
        return run(() => recallUnscoped());
      case "bootstrapViaMcp":
        return run(() => bootstrapViaMcp(body.agentId, body.args));
      case "buildContextWith":
        return run(() => buildContextWith(body.agentId));
      case "createWithNoContext":
        return run(() => createWithNoContext());
      case "recallWithRawMissingId":
        return run(() => recallWithRawMissingId());
      default:
        return new Response(JSON.stringify({ error: `unknown op '${op}'` }), { status: 400 });
    }
  }
}
