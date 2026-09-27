/**
 * MemoryHostSource.ts — the resource class for the host-pointer table
 * (flair#1940 slice 1 / A1' item 3). The pointer lives in its own table,
 * keyed by memoryId. Supported writes store host pointers only in `MemoryHostSource`:
 * a pointer reaches a non-admin reader only through the gated join, and reads remove
 * any `hostSource` stored inline on a Memory row.
 *
 * READ — ADMIN-ONLY. Bare `@export` (schemas/memory.graphql) would otherwise
 * reach Harper's default allow-decision (super_user passthrough), reachable by
 * the forged-loopback super_user and, once the global gate is non-rejecting, by
 * a genuinely anonymous remote caller. So allowRead/get/search gate on the
 * authenticated principal: internal calls and admin agents pass; a non-admin
 * agent gets NOTHING (get/search), never a 403 existence oracle. The author
 * reads their own pointer only through the gated join INTO Memory results
 * (resources/Memory.ts) — never from this table directly.
 *
 * WRITE — there are NO REST write verbs. post/put/patch and delete are refused
 * for EVERY caller (admin included), with a message naming the Memory write
 * path (A1'' item 3) — proved over real HTTP for non-admin AND admin (r4-http).
 * A pointer row is written ONLY by Memory's write path (POST/PUT /Memory),
 * through the table object, in the SAME transaction as the Memory row (a
 * request's open one, or one created when an internal caller has no request
 * context), so the two commit together or not at all (real-Harper t1/t2);
 * authorId is stamped there from the authenticated principal, never the body.
 * A superuser Harper operation against the table (an operator export, backup
 * or reseed) is the operator path, not gated by this resource.
 */
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { resolveAuthGate, FORBIDDEN, UNAUTH, NOT_FOUND } from "./record-type-kit.js";

/** The admin-only read gate: internal calls and admin agents pass; every
 *  non-admin agent is denied. Wired as a genuine prototype method. */
async function adminOnlyReadGate(this: any): Promise<boolean> {
  const auth = await resolveAgentAuth((this as any).getContext?.());
  return auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin);
}

export class MemoryHostSource extends (databases as any).flair.MemoryHostSource {
  allowRead() {
    return adminOnlyReadGate.call(this);
  }

  /** A by-id read: admin/internal pass; a non-admin agent gets NOT_FOUND
   *  (never a 403 existence oracle for "does this memory have a pointer"). */
  async get(target?: any) {
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }
    const gate = await resolveAuthGate((this as any).getContext?.(), UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.get(target);
    return NOT_FOUND();
  }

  /** A collection read/search: admin/internal pass; a non-admin agent is
   *  refused (403). */
  async search(query?: any) {
    const gate = await resolveAuthGate((this as any).getContext?.(), UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.search(query);
    return FORBIDDEN("forbidden: MemoryHostSource is admin-only");
  }

  /**
   * A1'' item 3 — MemoryHostSource has NO REST write verbs. A pointer row is
   * written ONLY by Memory's own write path (POST/PUT /Memory), through the
   * table object, inside the same request transaction. Every caller is refused
   * here — admin included — with the same message naming that path, so no REST
   * caller can plant a pointer on another agent's memory (which is what item 3
   * replaces: the old resource-side stamp had no business existing).
   */
  async post(_content: any) {
    return writelessRefusal();
  }

  async put(_content: any) {
    return writelessRefusal();
  }

  async patch(_content: any, _query?: any) {
    return writelessRefusal();
  }

  async delete(_id: any) {
    return writelessRefusal();
  }
}

/** The fixed refusal every REST write verb on MemoryHostSource returns. */
function writelessRefusal(): Response {
  return FORBIDDEN(
    "forbidden: MemoryHostSource has no REST write verbs; a pointer row is written only by the Memory write path (POST/PUT /Memory)",
  );
}

