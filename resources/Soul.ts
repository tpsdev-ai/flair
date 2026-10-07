import { randomUUID } from "node:crypto";
import { databases } from "harper";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import { applyOriginatorInstanceId, dropClientOriginator, resolveStoredRow, stampOriginatorOnCreate } from "./originator-instance.js";
import { makeAuthGate, stampAttribution } from "./record-type-kit.js";
import { RECORD_TYPES } from "./record-types.js";
import { authorizeSoulWrite, refuseSoulWriteContent, soulProvenance } from "./soul-write-policy.js";
import { refuseSkillAssignmentWrite } from "./skill-provenance.js";
import { recordVersion, soulSubjectId, type RecordVersionInput, type VersionKind } from "./instruction-version-record.js";

// Source authorization is independent of principal ownership: an admin runtime
// may manage records elsewhere, but it cannot author identity-defining Soul.
async function enforceWriteAuth(context: any, data: any): Promise<Response | null> {
  const { auth, source, denied } = await authorizeSoulWrite(context);
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

function soulRowId(self: any, row: any): string {
  const id = self.getId?.() ?? row.id ?? randomUUID();
  return String(id);
}

function versionInput(
  row: any,
  kind: VersionKind,
  previous: any,
  snapshot?: RecordVersionInput["snapshot"],
): RecordVersionInput {
  const agentId = str(row.agentId);
  const key = str(row.key);
  const previousAgentId = str(previous?.agentId);
  const previousKey = str(previous?.key);
  const identityChanged = !!previous && (previousAgentId !== agentId || previousKey !== key);
  const previousSubjectId = identityChanged ? soulSubjectId(previousAgentId, previousKey) : null;
  return {
    subjectType: "soul", subjectId: soulSubjectId(agentId, key), agentId, key,
    kind, rowId: String(row.id), snapshot,
    previousSubjectId, previousKey: previousSubjectId ? previousKey : null,
    previousAgentId: previousSubjectId ? previousAgentId : null,
    previousRowId: previousSubjectId ? String(previous.id) : null,
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// See makeAuthGate's doc (record-type-kit.ts): must be wired as a genuine
// prototype method below, never a class-field assignment — Harper's
// relationship-traversal RBAC path reads allowRead off the prototype.
const soulAuthGate = makeAuthGate();

export class Soul extends (databases as any).flair.Soul {
  /**
   * Self-authorize now that the global gate is non-rejecting. Closes the P0
   * leak: Harper routes `GET /Soul/<id>` to get() and the collection describe
   * (`GET /Soul`) to a path outside search()/allow* — neither was gated before
   * this fix, so an anonymous caller got a 200 with full soul content.
   * Deliberately NO get() override / per-agent scoping on top of this: souls
   * are identity/discovery data, intentionally readable by any verified agent —
   * same posture as Agent.ts's allowRead. Write ownership is unaffected —
   * enforceWriteAuth() below already gates post()/put().
   */
  allowRead() { return soulAuthGate.call(this); }

  async post(content: any, context?: any) {
    const ctx = this.getContext?.();
    const denied = await enforceWriteAuth(ctx, content);
    if (denied) return denied;
    const learnedDenied = await refuseSoulWriteContent(content);
    if (learnedDenied) return learnedDenied;
    const skillSourceDenied = refuseSkillAssignmentWrite(content);
    if (skillSourceDenied) return skillSourceDenied;
    const outcome = await recordVersion(ctx, {
      subjectType: "soul",
      prepare: async () => {
        content.id = soulRowId(this, content);
        content.durability ||= "permanent";
        content.createdAt = new Date().toISOString();
        content.updatedAt = content.createdAt;
        await stampOriginatorOnCreate(content);
        this.validate?.(content);
        return versionInput(content, "create", null, () => content);
      },
    }, () => super.post(content, context));
    return outcome.ok ? outcome.result : outcome.response;
  }

  async patch(content: any, query?: any) {
    const ctx = this.getContext?.();
    const denied = await enforceWriteAuth(ctx, content);
    if (denied) return denied;
    const outcome = await recordVersion(ctx, {
      subjectType: "soul",
      prepare: async (shared) => {
        const resolved = await resolveStoredRow(this, "Soul", content, () => super.get(), shared);
        if (resolved.denial) return resolved.denial;
        const existing = resolved.row;
        if (!existing) return new Response(JSON.stringify({ error: "soul_stored_state_unavailable" }), {
          status: 403, headers: { "Content-Type": "application/json" },
        });
        const ownerDenial = await guardOwnerFieldImmutable(this, () => existing, content, "agentId");
        if (ownerDenial) return ownerDenial;
        dropClientOriginator(content);
        delete content.createdAt;
        content.updatedAt = new Date().toISOString();
        this.validate?.(content, true);
        const merged = { ...existing, ...content, id: soulRowId(this, existing) };
        const learnedDenied = await refuseSoulWriteContent(merged);
        if (learnedDenied) return learnedDenied;
        const skillSourceDenied = refuseSkillAssignmentWrite(content, existing);
        if (skillSourceDenied) return skillSourceDenied;
        return versionInput(merged, "update", existing, () => ({ ...existing, ...content, id: merged.id }));
      },
    }, () => super.patch(content, query));
    return outcome.ok ? outcome.result : outcome.response;
  }

  async put(content: any, context?: any) {
    const ctx = this.getContext?.();
    const denied = await enforceWriteAuth(ctx, content);
    if (denied) return denied;
    const learnedDenied = await refuseSoulWriteContent(content);
    if (learnedDenied) return learnedDenied;
    const outcome = await recordVersion(ctx, {
      subjectType: "soul",
      prepare: async (shared) => {
        const resolved = await resolveStoredRow(this, "Soul", content, () => super.get(), shared);
        if (resolved.denial) return resolved.denial;
        const existing = resolved.row;
        const skillSourceDenied = refuseSkillAssignmentWrite(content, existing ?? undefined);
        if (skillSourceDenied) return skillSourceDenied;
        const ownerDenial = await guardOwnerFieldImmutable(this, () => existing, content, "agentId");
        if (ownerDenial) return ownerDenial;
        content.id = soulRowId(this, content);
        content.updatedAt = new Date().toISOString();
        await applyOriginatorInstanceId(content, existing);
        content.createdAt = typeof existing?.createdAt === "string" ? existing.createdAt : content.updatedAt;
        content.agentId = str(content.agentId) || str(existing?.agentId);
        content.key = str(content.key) || str(existing?.key);
        this.validate?.(content);
        return versionInput(content, existing ? "update" : "create", existing, () => content);
      },
    }, () => super.put(content, context));
    return outcome.ok ? outcome.result : outcome.response;
  }

  async delete(id: any) {
    const ctx = this.getContext?.();
    const { denied } = await authorizeSoulWrite(ctx);
    if (denied) return denied;
    const rowId = this.getId?.();
    if ((typeof rowId !== "string" && typeof rowId !== "number") || rowId === "" || this.isCollection || id?.isCollection) {
      return new Response(JSON.stringify({ error: "soul_delete_requires_one_record" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    const outcome = await recordVersion(ctx, {
      subjectType: "soul",
      prepare: async (shared) => {
        const resolved = await resolveStoredRow(this, "Soul", {}, () => super.get(), shared);
        if (resolved.denial) return resolved.denial;
        if (!resolved.row) return null;
        return versionInput(resolved.row, "delete", null);
      },
    }, () => super.delete(id));
    return outcome.ok ? outcome.result : outcome.response;
  }

}
