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
 */
import { databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";

const FORBIDDEN = (msg: string) =>
  new Response(JSON.stringify({ error: msg }), { status: 403, headers: { "Content-Type": "application/json" } });
const UNAUTH = () =>
  new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
const NOT_FOUND = () =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

export class MemoryUsage extends (databases as any).flair.MemoryUsage {
  /** Self-authorize now that the global gate is non-rejecting — same pattern
   *  as every other table resource in this codebase (Memory.ts/MemoryGrant.ts
   *  etc.). Per-record scoping happens in get()/search() below. */
  allowRead() { return allowVerified((this as any).getContext?.()); }

  async get(target?: any) {
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") return NOT_FOUND();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return super.get(target);
    const record = await super.get(target);
    if (!record || record.agentId !== auth.agentId) return NOT_FOUND();
    return record;
  }

  async search(query?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return super.search(query);
    const scope = { attribute: "agentId", comparator: "equals", value: auth.agentId };
    if (query && typeof query === "object" && !Array.isArray(query)) {
      const existing = query.conditions ?? [];
      query.conditions = Array.isArray(existing) ? [scope, ...existing] : [scope, existing];
      return super.search(query);
    }
    const conditions = Array.isArray(query) && query.length > 0 ? [scope, ...query] : [scope];
    return super.search(conditions);
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

  async delete(id: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return super.delete(id);
    return FORBIDDEN("forbidden: MemoryUsage rows cannot be deleted by non-admins (dedup-integrity invariant — see module doc)");
  }
}
