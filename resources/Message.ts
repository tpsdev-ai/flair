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
import { resolveAgentAuth } from "./agent-auth.js";
import { makeAuthGate, FORBIDDEN, UNAUTH, NOT_FOUND } from "./record-type-kit.js";
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

export class Message extends (databases as any).flair.Message {
  allowRead() {
    return messageAuthGate.call(this);
  }

  async post(content: any) {
    const auth = await resolveAgentAuth(ctxOf(this));
    return relaySend(relayDeps(), auth, content ?? {});
  }

  /** By-id read is scoped to the two parties (from/to); anyone else gets 404,
   *  so ids can't be enumerated. Collection reads fall through to allowRead. */
  async get(target?: any) {
    if (!target || (typeof target === "object" && target.isCollection)) {
      return super.get(target);
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
