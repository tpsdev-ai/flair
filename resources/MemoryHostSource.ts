/**
 * MemoryHostSource.ts — the resource class for the host-pointer table
 * (flair#1940 slice 1 / A1' item 3). The pointer lives in its own table,
 * keyed by memoryId; Memory rows never carry it.
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
 * WRITE — authorId is SERVER-STAMPED from the authenticated principal, NEVER
 * taken from the body (a body-supplied authorId is ignored), and hostSource is
 * validated with the same A2 validator Memory.post()/put() use. Memory.post()/
 * put() write the row directly (bypassing this resource) in the SAME request
 * transaction as the Memory row.
 */
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { resolveAuthGate, FORBIDDEN, UNAUTH, NOT_FOUND } from "./record-type-kit.js";
import { validateHostSource } from "./host-source.js";

const VISIBILITIES = new Set(["private", "shared"]);

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

  /** Stamp authorId from the authenticated principal (never the body) and
   *  validate hostSource + the write-time scope rule. */
  async post(content: any) {
    const denial = await this.stampAndValidate(content);
    if (denial) return denial;
    return super.post(content);
  }

  async put(content: any) {
    const denial = await this.stampAndValidate(content);
    if (denial) return denial;
    return super.put(content);
  }

  private async stampAndValidate(content: any): Promise<Response | null> {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") return UNAUTH();
    if (!content || typeof content !== "object") return FORBIDDEN("forbidden: MemoryHostSource body required");
    // authorId is the principal's, never the body's.
    if (auth.kind === "internal") delete content.authorId;
    else content.authorId = auth.agentId;

    const hs = validateHostSource(content.hostSource);
    if (!hs.ok) {
      return new Response(JSON.stringify({ error: "invalid_host_source", message: hs.error }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    content.hostSource = hs.canonical;
    // The scope rule: scopeAtWrite is the record's visibility at write, or null
    // (author-only). Anything that is not a known visibility is refused.
    if (content.scopeAtWrite !== undefined && content.scopeAtWrite !== null && !VISIBILITIES.has(content.scopeAtWrite)) {
      return new Response(JSON.stringify({ error: "invalid_host_source_scope", message: "scopeAtWrite must be a visibility or null" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (content.scopeAtWrite === undefined) content.scopeAtWrite = null;
    if (content.receivedAt === undefined || content.receivedAt === null) content.receivedAt = new Date().toISOString();
    return null;
  }
}
