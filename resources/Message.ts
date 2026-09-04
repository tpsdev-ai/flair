/**
 * Message.ts — Flair Relay S1 resource surface (point-to-point, single host).
 *
 * A signed, principal-addressed, durably-queued message with an explicit ack
 * and a VISIBLE dead-letter — a DIFFERENT primitive from memory and OrgEvent
 * (whose expiresAt is a silent dead-letter). See relay-ops.ts for the
 * orchestration and relay-lib.ts for the pure primitives; this file is the thin
 * Harper adapter that resolves auth and injects the real table accessors.
 *
 * Auth (self-enforced, mirroring OrgEvent/MemoryGrant now that the global gate
 * is non-rejecting): reads gated to verified agents; every write path resolves
 * the three-way verdict and fails closed on anonymous. Direct REST mutation of
 * the table (PUT/DELETE) is admin/internal only — agents SEND via post() and
 * ACK via MessageAck, never by writing state fields directly. relay-ops' own
 * writes use the static table accessor and bypass these instance gates (the
 * same raw-put seam Federation.ts relies on).
 */

import { Resource, databases } from "harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { makeAuthGate, makeScopedSearch, FORBIDDEN, UNAUTH, NOT_FOUND } from "./record-type-kit.js";
import { localInstanceId } from "./instance-identity.js";
import {
  relaySend,
  relayInbox,
  relayConsume,
  relayDeadLetters,
  relaySweepDeadlines,
  type RelayDeps,
} from "./relay-ops.js";

function relayDeps(): RelayDeps {
  return {
    messages: (databases as any).flair.Message,
    agents: (databases as any).flair.Agent,
    resolveOrg: localInstanceId,
  };
}

function ctxOf(self: any): any {
  return self.getContext?.();
}

function pathId(pathInfo: any): string | undefined {
  const id =
    (typeof pathInfo === "object" && pathInfo !== null ? pathInfo.id : undefined) ??
    (typeof pathInfo === "string" ? pathInfo : undefined);
  return id ? String(id) : undefined;
}

// ─── Message table resource — post() sends a message ────────────────────────

const messageAuthGate = makeAuthGate();

// P0-1 collection read-scope: a non-admin agent's collection read is limited to
// the messages it is a PARTY to — `from === self` OR `to === self`. Composed as
// the OUTERMOST `and` block (makeScopedSearch) so a caller-supplied
// `operator: "or"` cannot boolean-inject past the scope — the exact
// injection-safe shape Memory.search() uses. Without this, super.get() on a
// collection returns EVERY row in the table to any verified agent (the
// cross-principal read leak Kern P0-1 flagged). Admin/internal are unfiltered.
const messageScopedSearch = makeScopedSearch(async (agentId: string) => ({
  condition: {
    operator: "or",
    conditions: [
      { attribute: "from", comparator: "equals", value: agentId },
      { attribute: "to", comparator: "equals", value: agentId },
    ],
  },
  isAllowed: (r: any) => !!r && (r.from === agentId || r.to === agentId),
}));

export class Message extends (databases as any).flair.Message {
  allowRead() {
    return messageAuthGate.call(this);
  }

  /** Send (POST) self-authorizes for any verified agent: Harper authorizes
   *  BEFORE post() runs, so without this a de-elevated flair_agent 403s on the
   *  create before relaySend is ever reached (Kern P0-2). Per-send ownership
   *  (no-forge `from`, signature) is enforced inside relaySend. */
  async allowCreate(): Promise<boolean> {
    return allowVerified(ctxOf(this));
  }

  async post(content: any) {
    const auth = await resolveAgentAuth(ctxOf(this));
    return relaySend(relayDeps(), auth, content ?? {});
  }

  /** Scope a non-admin agent's collection read to the messages it is a party
   *  to (from/to === self); admin/internal unfiltered; anonymous denied. Reached
   *  via get()'s collection branch, the same way Memory.get delegates collection
   *  reads to Memory.search. */
  async search(query?: any) {
    const auth = await resolveAgentAuth(ctxOf(this));
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return super.search(query);
    return messageScopedSearch(auth.agentId, query, (q: any) => super.search(q));
  }

  /** By-id read is scoped to the two parties (from/to); anyone else gets 404,
   *  so ids can't be enumerated. Collection reads route to the party-scoped
   *  search() above (P0-1) — NOT super.get, which returns the whole table. */
  async get(target?: any) {
    if (!target || (typeof target === "object" && target.isCollection)) {
      return this.search(target);
    }
    const auth = await resolveAgentAuth(ctxOf(this));
    if (auth.kind === "anonymous") return NOT_FOUND();
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return super.get(target);
    const record = await super.get(target);
    if (!record) return NOT_FOUND();
    if (record.from !== auth.agentId && record.to !== auth.agentId) return NOT_FOUND();
    return record;
  }

  /** Direct table writes are admin/internal only — see the file header. */
  async put(content: any, context?: any) {
    const auth = await resolveAgentAuth(ctxOf(this));
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin) {
      return FORBIDDEN("forbidden: send via POST and ack via MessageAck; direct writes are not permitted");
    }
    return super.put(content, context);
  }

  /** PATCH is a distinct Harper verb (Resource.patch → type:update → TableResource.patch
   *  runs update()+save(), NEVER Message.put()), so without this override a de-elevated
   *  agent with an `update` grant could mutate ANY message — set state, rewrite
   *  body/from/to on a row it is not a party to — bypassing put()'s guard and
   *  relayConsume's recipient-only check (Kern P0). The `update:false` grant now closes
   *  this at the platform gate; this mirrors put()'s guard as defense-in-depth for the
   *  verb surface (admin/internal only). Agents ack via MessageAck, never a direct PATCH. */
  async patch(content: any, context?: any) {
    const auth = await resolveAgentAuth(ctxOf(this));
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin) {
      return FORBIDDEN("forbidden: ack via MessageAck; direct writes are not permitted");
    }
    return super.patch(content, context);
  }

  async delete(id: any, context?: any) {
    const auth = await resolveAgentAuth(ctxOf(this));
    if (auth.kind === "anonymous") return UNAUTH();
    if (auth.kind === "agent" && !auth.isAdmin) {
      return FORBIDDEN("forbidden: direct deletes are not permitted");
    }
    return super.delete(id, context);
  }
}

// ─── /MessageInbox/{to}? — the caller's unconsumed inbox, sorted by seq ──────

export class MessageInbox extends Resource {
  async allowRead(): Promise<boolean> {
    const auth = await resolveAgentAuth(ctxOf(this));
    return auth.kind !== "anonymous";
  }
  async get(pathInfo?: any) {
    const auth = await resolveAgentAuth(ctxOf(this));
    return relayInbox(relayDeps(), auth, pathId(pathInfo));
  }
}

// ─── /MessageAck  (POST {id}) — recipient acks a message ────────────────────

export class MessageAck extends Resource {
  async allowRead(): Promise<boolean> {
    const auth = await resolveAgentAuth(ctxOf(this));
    return auth.kind !== "anonymous";
  }
  /** Ack (POST) self-authorizes for any verified agent: a bare Resource
   *  subclass defaults allowCreate to super_user, which 403s every de-elevated
   *  flair_agent — the ack, the core primitive, would be admin-only as shipped
   *  (Kern P0-2). Recipient-only ownership is enforced inside relayConsume. */
  async allowCreate(): Promise<boolean> {
    return allowVerified(ctxOf(this));
  }
  async post(content: any) {
    const auth = await resolveAgentAuth(ctxOf(this));
    const id = content && typeof content === "object" ? String(content.id ?? "") : "";
    return relayConsume(relayDeps(), auth, id);
  }
}

// ─── /MessageDeadLetter/{from}? — the sender's visible failures ──────────────

export class MessageDeadLetter extends Resource {
  async allowRead(): Promise<boolean> {
    const auth = await resolveAgentAuth(ctxOf(this));
    return auth.kind !== "anonymous";
  }
  async get(pathInfo?: any) {
    const auth = await resolveAgentAuth(ctxOf(this));
    return relayDeadLetters(relayDeps(), auth, pathId(pathInfo));
  }
}

// ─── /MessageSweep  (POST) — admin/internal deadline sweep ───────────────────

export class MessageSweep extends Resource {
  async allowRead(): Promise<boolean> {
    const auth = await resolveAgentAuth(ctxOf(this));
    return auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin);
  }
  async post() {
    const auth = await resolveAgentAuth(ctxOf(this));
    return relaySweepDeadlines(relayDeps(), auth);
  }
}
