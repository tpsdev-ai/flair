import { databases } from "harper";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import { localInstanceId } from "./instance-identity.js";
import { makeAuthGate, stampAttribution } from "./record-type-kit.js";
import { RECORD_TYPES } from "./record-types.js";
import { authorizeSoulWrite, refuseLearnedSoulWrite, soulProvenance } from "./soul-write-policy.js";

// Source authorization is independent of principal ownership: an admin runtime
// may manage records elsewhere, but it cannot author identity-defining Soul.
async function enforceWriteAuth(self: any, data: any): Promise<Response | null> {
  const { auth, source, denied } = await authorizeSoulWrite(self.getContext?.());
  if (denied) return denied;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return new Response(JSON.stringify({ error: "soul_write_requires_one_record" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  data.provenance = soulProvenance(auth, source!, new Date().toISOString());
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
    // Learned artifacts cannot gain identity authority through an operator write.
    const learnedDenied = await refuseLearnedSoulWrite(content);
    if (learnedDenied) return learnedDenied;
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

  // PATCH must validate the merged value and retained legacy tags, rather
  // than treating an omitted field as proof that no learned content exists.
  async patch(content: any, query?: any) {
    const denied = await enforceWriteAuth(this, content);
    if (denied) return denied;
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
    const learnedDenied = await refuseLearnedSoulWrite({ ...existing, ...content });
    if (learnedDenied) return learnedDenied;
    return super.patch(content, query);
  }

  async put(content: any, context?: any) {
    const denied = await enforceWriteAuth(this, content);
    if (denied) return denied;
    const learnedDenied = await refuseLearnedSoulWrite(content);
    if (learnedDenied) return learnedDenied;
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

  async delete(id: any) {
    const { denied } = await authorizeSoulWrite((this as any).getContext?.());
    if (denied) return denied;
    return super.delete(id);
  }

}
