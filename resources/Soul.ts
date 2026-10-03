import { databases } from "harper";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import { applyOriginatorInstanceId, dropClientOriginator, resolveStoredRow, stampOriginatorOnCreate } from "./originator-instance.js";
import { makeAuthGate, stampAttribution } from "./record-type-kit.js";
import { RECORD_TYPES } from "./record-types.js";
import { authorizeSoulWrite, refuseSoulWriteContent, soulProvenance } from "./soul-write-policy.js";
import { refuseSkillAssignmentWrite } from "./skill-provenance.js";
import { recordVersion, soulAttribution, soulSubjectId, type VersionAttribution } from "./instruction-version-record.js";

// Source authorization is independent of principal ownership: an admin runtime
// may manage records elsewhere, but it cannot author identity-defining Soul.
async function enforceWriteAuth(self: any, data: any): Promise<{ denied: Response | null; attribution: VersionAttribution }> {
  const { auth, source, denied } = await authorizeSoulWrite(self.getContext?.());
  const attribution = soulAttribution(auth, source ?? "internal");
  if (denied) return { denied, attribution };
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      denied: new Response(JSON.stringify({ error: "soul_write_requires_one_record" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      }),
      attribution,
    };
  }
  data.provenance = soulProvenance(auth, source!, new Date().toISOString());
  const attr = stampAttribution(auth, data, RECORD_TYPES.Soul.ownerField, RECORD_TYPES.Soul.attribution.post, "forbidden: agentId must match authenticated agent");
  return { denied: attr.denied ?? null, attribution };
}

// A delete carries no body; source authorization is the same operator/internal
// rule as the write verbs, and its attribution is the same server-derived shape.
async function enforceDeleteAuth(self: any): Promise<{ denied: Response | null; attribution: VersionAttribution }> {
  const { auth, source, denied } = await authorizeSoulWrite(self.getContext?.());
  return { denied, attribution: soulAttribution(auth, source ?? "internal") };
}

function isStoredRow(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !(value instanceof Response) && !Array.isArray(value);
}

/** The URL-bound row id, or the canonical subject when the address carries none. */
function soulRowId(self: any, row: any, agentId: string, key: string): string {
  const urlId = (() => {
    try {
      const id = self.getId?.();
      if (typeof id === "string" || typeof id === "number") return String(id);
    } catch { /* no URL-bound id */ }
    return null;
  })();
  const bodyId = row && (typeof row.id === "string" || typeof row.id === "number") ? String(row.id) : null;
  return bodyId ?? urlId ?? soulSubjectId(agentId, key);
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
    const { denied, attribution } = await enforceWriteAuth(this, content);
    if (denied) return denied;
    // Learned artifacts cannot gain identity authority through an operator write.
    const learnedDenied = await refuseSoulWriteContent(content);
    if (learnedDenied) return learnedDenied;
    const skillSourceDenied = refuseSkillAssignmentWrite(content);
    if (skillSourceDenied) return skillSourceDenied;
    content.durability ||= "permanent";
    content.createdAt = new Date().toISOString();
    content.updatedAt = content.createdAt;
    // Write-time originatorInstanceId (federation-edge-hardening slice 1): a
    // post() is a CREATE — stamp this instance's own id, ignoring any
    // request-body value. See resources/originator-instance.ts for the full
    // contract (create/update rule; the federation merge path is the raw
    // table writer and never consults a body).
    await stampOriginatorOnCreate(content);
    // Record the new subject's first version and run the row write in one
    // transaction (resources/instruction-version-record.ts). A failure rolls
    // both back, so a Soul write through this resource is never unaudited and a
    // version is never phantom. Slice 1 callers are unguarded (no expectedVersion).
    const agentId = str(content.agentId);
    const key = str(content.key);
    const outcome = await recordVersion(this.getContext?.(), {
      subjectType: "soul",
      subjectId: soulSubjectId(agentId, key),
      agentId,
      key,
      kind: "create",
      rowId: soulRowId(this, content, agentId, key),
      value: typeof content.value === "string" ? content.value : null,
      soulSnapshot: JSON.stringify(content),
      attribution,
      createdAt: content.createdAt,
    }, () => super.post(content, context));
    return outcome.ok ? outcome.result : outcome.response;
  }

  // PATCH must validate the merged value and retained legacy tags, rather
  // than treating an omitted field as proof that no learned content exists.
  async patch(content: any, query?: any) {
    const { denied, attribution } = await enforceWriteAuth(this, content);
    if (denied) return denied;
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, "agentId");
    if (denial) return denial;
    // Fail-closed, same class as Memory's stored-state read: the stored row is
    // resolved by the URL-BOUND target id, refusing a body id that disagrees
    // with the address and refusing a lookup that FAILS (a failed read is never
    // "no stored row"). A PATCH that typically omits agentId cannot be
    // authorized without the stored state, so an absent row is refused too. See
    // resources/originator-instance.ts's resolveStoredRow.
    const resolvedStored = await resolveStoredRow(this, "Soul", content, () => super.get());
    if (resolvedStored.denial) return resolvedStored.denial;
    const existing = resolvedStored.row;
    if (!existing) {
      return new Response(JSON.stringify({ error: "soul_stored_state_unavailable" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    // The version describes the MERGED stored state, never the PATCH body.
    const merged = { ...existing, ...content };
    const learnedDenied = await refuseSoulWriteContent(merged);
    if (learnedDenied) return learnedDenied;
    // flair#1965: originatorInstanceId is server-stamped — a PATCH body value is
    // dropped so the stored value stands (a patch merges; see
    // resources/originator-instance.ts).
    dropClientOriginator(content);
    const skillSourceDenied = refuseSkillAssignmentWrite(content, existing);
    if (skillSourceDenied) return skillSourceDenied;
    const agentId = str(merged.agentId);
    const key = str(merged.key);
    const previousSubjectId = typeof existing.key === "string" && existing.key !== key
      ? soulSubjectId(str(existing.agentId) || agentId, existing.key)
      : null;
    const now = new Date().toISOString();
    const outcome = await recordVersion(this.getContext?.(), {
      subjectType: "soul",
      subjectId: soulSubjectId(agentId, key),
      agentId,
      key,
      kind: "update",
      rowId: soulRowId(this, existing, agentId, key),
      value: typeof merged.value === "string" ? merged.value : null,
      soulSnapshot: JSON.stringify(merged),
      attribution,
      createdAt: now,
      previousSubjectId,
      previousKey: previousSubjectId ? existing.key : null,
      previousRowId: previousSubjectId ? soulRowId(this, existing, agentId, key) : null,
    }, () => super.patch(content, query));
    return outcome.ok ? outcome.result : outcome.response;
  }

  async put(content: any, context?: any) {
    const { denied, attribution } = await enforceWriteAuth(this, content);
    if (denied) return denied;
    const learnedDenied = await refuseSoulWriteContent(content);
    if (learnedDenied) return learnedDenied;
    const existing = await super.get();
    const existingRow = existing && typeof existing === "object" && !(existing instanceof Response)
      ? existing
      : undefined;
    const skillSourceDenied = await refuseSkillAssignmentWrite(content, existingRow);
    if (skillSourceDenied) return skillSourceDenied;
    const ownerDenial = await guardOwnerFieldImmutable(this, () => existing, content, "agentId");
    if (ownerDenial) return ownerDenial;
    content.updatedAt = new Date().toISOString();
    // Write-time originatorInstanceId — see post() above /
    // resources/originator-instance.ts. A CREATE stamps the local id; an
    // UPDATE keeps the stored value (a body value never replaces or clears it).
    // The row is resolved by the URL-BOUND target id, never a body `id` (Harper
    // writes to the URL target); a mismatch or a failed read refuses the write.
    const resolvedOriginRow = await resolveStoredRow(this, "Soul", content, () => super.get());
    if (resolvedOriginRow.denial) return resolvedOriginRow.denial;
    await applyOriginatorInstanceId(content, resolvedOriginRow.row);
    const storedRow = resolvedOriginRow.row ?? existingRow ?? null;
    // Creation clock (flair#2139 A): an update preserves the stored createdAt
    // regardless of the request body; a genuinely new row gets a server time.
    // The CLI/client send a fresh timestamp, so leaving the body value would
    // reset the clock on every PUT.
    content.createdAt = isStoredRow(storedRow) && typeof storedRow.createdAt === "string"
      ? storedRow.createdAt
      : content.updatedAt;
    const agentId = str(content.agentId) || str(storedRow?.agentId);
    const key = str(content.key) || str(storedRow?.key);
    content.agentId = agentId;
    content.key = key;
    // A change of logical Soul key closes the old subject with a tombstone and
    // continues the new subject, in the same transaction.
    const previousSubjectId = isStoredRow(storedRow) && typeof storedRow.key === "string" && storedRow.key !== key
      ? soulSubjectId(str(storedRow.agentId) || agentId, storedRow.key)
      : null;
    const outcome = await recordVersion(this.getContext?.(), {
      subjectType: "soul",
      subjectId: soulSubjectId(agentId, key),
      agentId,
      key,
      kind: isStoredRow(storedRow) ? "update" : "create",
      rowId: soulRowId(this, content, agentId, key),
      value: typeof content.value === "string" ? content.value : null,
      soulSnapshot: JSON.stringify(content),
      attribution,
      createdAt: content.createdAt,
      previousSubjectId,
      previousKey: previousSubjectId ? storedRow.key : null,
      previousRowId: previousSubjectId ? soulRowId(this, content, agentId, key) : null,
    }, () => super.put(content, context));
    return outcome.ok ? outcome.result : outcome.response;
  }

  async delete(id: any) {
    const { denied, attribution } = await enforceDeleteAuth(this);
    if (denied) return denied;
    const existing = await super.get();
    const row = isStoredRow(existing) ? existing : null;
    // No stored row: nothing to tombstone; preserve the bare delete.
    if (!row) return super.delete(id);
    const agentId = str(row.agentId);
    const key = str(row.key);
    const now = new Date().toISOString();
    // Deleting the live row does not delete history: append a tombstone linked
    // to the preceding head, in the same transaction as the row delete.
    const outcome = await recordVersion(this.getContext?.(), {
      subjectType: "soul",
      subjectId: soulSubjectId(agentId, key),
      agentId,
      key,
      kind: "delete",
      rowId: soulRowId(this, row, agentId, key),
      value: null,
      soulSnapshot: null,
      attribution,
      createdAt: now,
    }, () => super.delete(id));
    return outcome.ok ? outcome.result : outcome.response;
  }

}
