/**
 * resources/MemoryUsage.ts — the dedup ledger for the usage-feedback signal
 * (flair#683). One row per (agentId, memoryId) contribution; see
 * schemas/memory.graphql's MemoryUsage type doc for the full field/design
 * rationale.
 *
 * This file is a LOCKED-DOWN table guard, not the public write surface: the
 * actual "record that a memory was used" action lives in
 * resources/RecordUsage.ts (POST /RecordUsage) — see that file's module doc
 * for why the action lives on a SEPARATE, non-table-backed resource (a
 * confirmed-live Harper gotcha: the base TableResource has no default
 * `post()` for a static-style raw-table call outside an
 * `isCollection`-instantiated resource — resources/Memory.ts documents the
 * HTTP-facing shape of this same limitation for the Memory table).
 * RecordUsage writes ledger rows via `.put()` on the RAW table object
 * (`databases.flair.MemoryUsage` — an upsert against the deterministic
 * composite id, not a `.post()`), the same "call the other table directly,
 * bypass its resource class's own auth wrapper" pattern resources/Memory.ts
 * already uses for MemoryGrant (hasWriteGrant()) — so nothing below is
 * bypassed by that internal path; it only gates the DIRECT `/MemoryUsage`
 * HTTP route.
 *
 * Why agents get READ but NOT UPDATE/DELETE here (mirrored in
 * src/cli.ts's FLAIR_AGENT_PERMISSION native-role grant): the ledger IS the
 * dedup/anti-gaming primitive — Sherlock's "(agent, memory) contributes ≤ 1"
 * rule is enforced by RecordUsage checking for an EXISTING ledger row before
 * bumping usageCount. If an agent could DELETE its own row over HTTP, it
 * could re-trigger RecordUsage for the same memory indefinitely (create row
 * → count once → delete row → count again → repeat), completely defeating
 * the dedup cap. Locking put()/delete() to admin/internal here is therefore
 * LOAD-BEARING, not just defense in depth — it's the only thing enforcing
 * this in an environment where the native Harper role hasn't been
 * (re-)provisioned yet (auth-middleware.ts's documented pre-migration
 * admin-fallback — and every ephemeral test Harper spawned via
 * test/helpers/harper-lifecycle.ts, which never runs `flair init`'s role
 * provisioning at all).
 *
 * Read scope is deliberately narrower than Memory's "open-within-org" model:
 * an agent sees only ITS OWN contributions (or admin sees everything). The
 * ledger is an audit trail, not a shared surface — there is no product need
 * to expose "which agent used which memory" cross-agent, and narrowing this
 * costs nothing.
 *
 * And within its own contributions, a non-admin agent sees a row only while
 * the memory the row names exists and is in its Memory read scope
 * (resolveReadScope — the rule Memory.get() applies). A row about a memory
 * the reader cannot read reads exactly like a row that does not exist: 404 by
 * id, absent from a collection read. A ledger row is therefore never evidence
 * about a memory its reader cannot otherwise see. The rule lives in
 * ./usage-recording.ts (isLedgerRowVisible / readableLedgerRows), next to the
 * write-side gate. Like Memory's reads, a non-admin read here ignores the
 * caller's `select`/`property`, so the decision always sees the stored
 * `memoryId`. A collection read filters after the owner-scoped query, so a
 * `limit` can return fewer rows than it names.
 */
import { databases } from "harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { makeByIdReadGate, makeReadScope, makeScopedSearch } from "./record-type-kit.js";
import { isLedgerRowVisible, readableLedgerRows } from "./usage-recording.js";

// Owner-only read scope through the shared by-id gate and scoped search.
const usageReadScope = makeReadScope("owner-only", "agentId");
const usageByIdReadGate = makeByIdReadGate(usageReadScope);
const usageScopedSearch = makeScopedSearch(usageReadScope);

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

/** The caller's query without its `select`/`property` (a key deletion, not a
 *  selection parser — the same rule resources/Memory.ts applies to a
 *  non-admin read, so the read decision sees the stored row). */
function withoutCallerSelection(query: any): any {
  if (!query || typeof query !== "object") return query;
  if ((query as any).select === undefined && (query as any).property === undefined) return query;
  const copy: any = Array.isArray(query) ? query.slice() : { ...query };
  delete copy.select;
  delete copy.property;
  return copy;
}

export class MemoryUsage extends (databases as any).flair.MemoryUsage {
  /** Self-authorize now that the global gate is non-rejecting — same pattern
   *  as every other table resource in this codebase (Memory.ts/MemoryGrant.ts
   *  etc.). Per-record scoping happens in get()/search() below. */
  allowRead() { return allowVerified((this as any).getContext?.()); }

  async get(target?: any) {
    // Collection / query reads are governed by search() below.
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    // Anonymous (404), trusted internal and admin (unfiltered): the shared gate.
    if (auth.kind !== "agent" || auth.isAdmin) {
      return usageByIdReadGate.call(this, target, (t: any) => super.get(t));
    }
    // Non-admin agent: the owner-only gate on the stored row (read by a plain
    // id-only target, so the caller's select/property never shapes it), then
    // the memory that row names must be readable by this agent. Both denials
    // are the same 404 as a missing row.
    const targetId = typeof target === "string" ? target : (target as any)?.id;
    const row = await usageByIdReadGate.call(this, targetId != null ? { id: targetId } : {}, (t: any) => super.get(t));
    if (!row || row instanceof Response) return row ?? NOT_FOUND();
    return (await isLedgerRowVisible(ctx, auth.agentId, row)) ? row : NOT_FOUND();
  }

  async search(query?: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return super.search(query);
    // Owner-only query (outermost AND), then only the rows about memories this
    // agent can read — see the module doc.
    const rows = await usageScopedSearch(auth.agentId, withoutCallerSelection(query), (q: any) => super.search(q));
    return readableLedgerRows(ctx, auth.agentId, rows);
  }

  // Append-only ledger: rows are created via RecordUsage's RAW table call
  // (bypasses this class entirely — see module doc), never via this
  // instance-level HTTP route, for non-admin callers.
  async post(content: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return super.post(content);
    return FORBIDDEN("forbidden: MemoryUsage rows are written by the /RecordUsage endpoint, not directly");
  }

  async put(content: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return super.put(content);
    return FORBIDDEN("forbidden: MemoryUsage rows are immutable once written");
  }

  /**
   * PATCH — same rule as put(), because this ledger's invariant is IMMUTABILITY,
   * not ownership.
   *
   * The shared record-ownership guard (resources/record-owner-guard.ts) covers
   * this table for cross-agent writes, but it cannot express this rule: it
   * permits an agent to modify a row it owns, and here even the OWNER must not.
   * Measured before this override existed: the owning agent rewrote its own
   * row's attribution with a PATCH and got 204, because Harper routes PATCH to
   * patch() and put()'s check never ran. A resource whose rule is stricter than
   * "you own it" still has to say so on every verb.
   */
  async patch(content: any, query?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return super.patch(content, query);
    return FORBIDDEN("forbidden: MemoryUsage rows are immutable once written");
  }

  async delete(id: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return super.delete(id);
    return FORBIDDEN("forbidden: MemoryUsage rows cannot be deleted by non-admins (dedup-integrity invariant — see module doc)");
  }
}
