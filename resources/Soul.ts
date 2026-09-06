import { databases } from "harper";
import { resolveAgentAuth, type AgentAuthVerdict } from "./agent-auth.js";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import { localInstanceId } from "./instance-identity.js";
import { makeAuthGate, stampAttribution, UNAUTH } from "./record-type-kit.js";
import { RECORD_TYPES } from "./record-types.js";
import { refuseAdkSourcedSoulWrite } from "./soul-adk-guard.js";

/**
 * Deny anonymous; enforce per-agent write ownership for non-admin agents.
 * The previous header-based check only fired when an agent WAS present (it read
 * x-tps-agent), so an anonymous request — which carries no x-tps-agent — slipped
 * through. With the non-rejecting gate, each write path self-enforces (resolveAgentAuth
 * distinguishes internal/agent/anonymous). Mirrors the WorkspaceState pattern.
 *
 * No-forge attribution — mode/field drawn from RECORD_TYPES.Soul (record-
 * types slice 2, flair#520) rather than hand-typed literals. "validate-
 * truthy" (see record-type-kit.ts's stampAttribution doc) — rejects a
 * PRESENT, mismatched agentId; passes through untouched when absent. Same
 * idiom as Memory.post()/put().
 */
async function enforceWriteAuth(self: any, data: any): Promise<Response | null> {
  const auth: AgentAuthVerdict = await resolveAgentAuth((self as any).getContext?.());
  if (auth.kind === "anonymous") return UNAUTH();
  const attr = stampAttribution(auth, data, RECORD_TYPES.Soul.ownerField, RECORD_TYPES.Soul.attribution.post, "forbidden: agentId must match authenticated agent");
  return attr.denied ?? null;
}

// See makeAuthGate's doc (record-type-kit.ts): must be wired as a genuine
// prototype method below, never a class-field assignment — Harper's
// relationship-traversal RBAC path reads allowRead off the prototype.
const soulAuthGate = makeAuthGate();

export class Soul extends (databases as any).flair.Soul {
  /**
   * Self-authorize now that the global gate is non-rejecting. Closes the P0
   * leak: Harper routes `GET /Soul/<id>` to get() and the collection
   * describe (`GET /Soul`) to a path outside search()/allow* — neither was
   * gated before this fix, so an anonymous caller got a 200 with full soul
   * content. Deliberately NO get() override / per-agent scoping on top of
   * this: souls are identity/discovery data, intentionally readable by any
   * verified agent — same posture as Agent.ts's allowRead. Write ownership
   * is unaffected — enforceWriteAuth() below already gates post()/put().
   */
  allowRead() { return soulAuthGate.call(this); }

  async post(content: any, context?: any) {
    const denied = await enforceWriteAuth(this, content);
    if (denied) return denied;
    // ADK-sourced claims are per-user; Soul is agentId-scoped. Refuse here
    // so a scripted PUT/POST/PATCH cannot bypass the CLI promote check.
    const adkDenied = await refuseAdkSourcedSoulWrite(content);
    if (adkDenied) return adkDenied;
    content.durability ||= "permanent";
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;
    // Write-time originatorInstanceId stamp (federation-edge-hardening slice
    // 1) — see resources/Memory.ts's stampOriginatorInstanceId doc for the
    // full contract. No-op if already set (never fires for a genuine local
    // write; a federation-synced record never reaches this method — the
    // merge path writes via the raw table object, bypassing this class).
    if (content.originatorInstanceId == null) {
      content.originatorInstanceId = await localInstanceId();
    }
    return super.post(content, context);
  }

  // PATCH routes past put() (enforceWriteAuth covers post()/put() only), so
  // agentId immutability is enforced on both verbs via the one shared delegate.
  // ADK refusal must see the merged row: a typical PATCH omits agentId/tags,
  // which would skip the value-match backstop if we checked the body alone.
  async patch(content: any, query?: any) {
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
    if (denial) return denial;
    // Fail-closed, same as Memory's stored-state read: a throw aborts the
    // write; missing/unreadable stored state cannot authorize a PATCH that
    // typically omits agentId (that used to skip the ADK value-match).
    const existing = await super.get();
    if (!existing || typeof existing !== "object" || existing instanceof Response) {
      return new Response(JSON.stringify({ error: "soul_stored_state_unavailable" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    const adkDenied = await refuseAdkSourcedSoulWrite({ ...existing, ...content });
    if (adkDenied) return adkDenied;
    return super.patch(content, query);
  }

  async put(content: any, context?: any) {
    const denied = await enforceWriteAuth(this, content);
    if (denied) return denied;
    const adkDenied = await refuseAdkSourcedSoulWrite(content);
    if (adkDenied) return adkDenied;
    const ownerDenial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
    if (ownerDenial) return ownerDenial;
    content.updatedAt = new Date().toISOString();
    // Write-time originatorInstanceId stamp — see post() above / Memory.ts's
    // stampOriginatorInstanceId doc. No-op if already set.
    if (content.originatorInstanceId == null) {
      content.originatorInstanceId = await localInstanceId();
    }
    return super.put(content, context);
  }
}
