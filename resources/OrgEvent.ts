/**
 * OrgEvent.ts — Harper table resource for org-wide activity events.
 *
 * Auth (self-enforced now that the global gate is non-rejecting):
 *   Read  — any verified agent/admin (org-scoped); anonymous denied.
 *   Write — authorId must match the authenticated agent (or admin); anonymous denied.
 *
 * The previous version read context.request.tpsAgent and treated a MISSING agent
 * as trusted (`if (agentId && …)` / `if (!agentId) super.delete`), so anonymous
 * requests slipped through once the gate stopped rejecting. resolveAgentAuth
 * distinguishes internal/agent/anonymous explicitly.
 */

import { randomUUID } from "node:crypto";
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import { invalidEntitiesResponse } from "./entity-vocab.js";
import {
  makeAuthGate,
  resolveAuthGate,
  stampAttribution,
  FORBIDDEN,
  UNAUTH,
} from "./record-type-kit.js";
import { RECORD_TYPES } from "./record-types.js";

// See makeAuthGate's doc (record-type-kit.ts): must be wired as a genuine
// prototype method below, never a class-field assignment — Harper's
// relationship-traversal RBAC path reads allowRead off the prototype.
const orgEventAuthGate = makeAuthGate();

export class OrgEvent extends (databases as any).flair.OrgEvent {
  allowRead() { return orgEventAuthGate.call(this); }

  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
  }

  async post(content: any) {
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();

    // No-forge attribution — mode/field drawn from RECORD_TYPES.OrgEvent
    // (record-types slice 2, flair#520) rather than hand-typed literals.
    // "stamp-default" (see record-type-kit.ts's stampAttribution doc): a
    // non-admin agent's events are ALWAYS attributed to its authenticated
    // identity (from the Ed25519 signature), never the body — an agent can
    // only publish AS itself. We overwrite `authorId` rather than 403'ing a
    // mismatch so a CLI client never has to echo its own id into the body
    // (mirrors A2A message/send's "sender must match params.agentId" guard
    // and Presence's "agentId from signature, NOT from body"). Admin agents
    // may publish on behalf of another agent (body authorId honored, else
    // their own).
    // "stamp-default" never denies (no rejection branch for non-admin) —
    // the forbiddenMessage arg is dead for this mode, passed for signature
    // completeness only.
    stampAttribution(auth, content, RECORD_TYPES.OrgEvent.ownerField, RECORD_TYPES.OrgEvent.attribution.post, "forbidden: unreachable for stamp-default");

    // The id this POST writes. For a POST addressed to one record
    // (`/OrgEvent/<id>`): the addressed id when the body has no `id` or an `id`
    // equal to the address as text (`0` for `/OrgEvent/0`), otherwise the
    // body's `id` (for a non-admin, a differing scalar body id was already
    // refused by the owner-scoped write guard). For a POST to the collection:
    // the body's `id` when it supplies one. In either case an id is generated
    // when the result is absent or the empty string. The raw put() below is an
    // upsert: an existing event at that id is updated, subject to the
    // owner-field rule that follows. This id selection applies to every
    // caller, administrators and in-process calls included.
    const addressedId = (this as any).getId?.();
    if (content && typeof content === "object" &&
      (typeof addressedId === "string" || typeof addressedId === "number") &&
      (content.id == null || String(content.id) === String(addressedId))) {
      content.id = addressedId;
    }
    // flair#2333 (H9): avoids deterministic same-millisecond collisions (random UUID).
    if (content.id == null || content.id === "") content.id = `${content.authorId}-${new Date().toISOString()}-${randomUUID()}`;
    content.createdAt = new Date().toISOString();

    // attention-plane vocabulary gate (flair#675): `entities`, if present,
    // must be well-formed vocabulary strings — see resources/entity-vocab.ts.
    // Field is additive/optional; absent entities is not an error.
    const entitiesError = invalidEntitiesResponse(content.entities);
    if (entitiesError) return entitiesError;

    // flair#2333 (N2): refuses a non-admin POST naming a row observed at the
    // guard's lookup as owned by another agent. This read-then-write check is
    // not atomic; a row appearing after the lookup is not covered.
    const ownerDenial = await guardOwnerFieldImmutable(
      this,
      () => (databases as any).flair.OrgEvent.get(content.id, {}),
      content,
      RECORD_TYPES.OrgEvent.ownerField,
    );
    if (ownerDenial) return ownerDenial;

    // Harper 5: table resources use put() for create/upsert (post() removed).
    return (databases as any).flair.OrgEvent.put(content);
  }

  // PATCH routes past put(), so authorId immutability is enforced on both verbs
  // via the one shared delegate.
  async patch(content: any, query?: any) {
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, "authorId");
    if (denial) return denial;
    return super.patch(content, query);
  }

  async put(content: any) {
    // put() and post() write the body's `id` through a raw table put(). For an
    // addressed write, the shared owner-scoped write guard
    // (resources/owner-scoped-write-policy.ts) refuses a non-admin request
    // whose scalar body `id` names a record other than the addressed one, and
    // post() gives a body with no `id` the addressed id; a collection POST
    // writes a generated id under post()'s own owner-field rule.
    const __ownerDenial = await guardOwnerFieldImmutable(this, () => super.get(), content, "authorId");
    if (__ownerDenial) return __ownerDenial;
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    // No-forge attribution — mode/field drawn from RECORD_TYPES.OrgEvent.
    // "validate-strict" (see record-type-kit.ts's stampAttribution doc):
    // rejects a mismatch INCLUDING when authorId is absent (a bare `!==`
    // compare, no truthy guard).
    const attr = stampAttribution(auth, content, RECORD_TYPES.OrgEvent.ownerField, RECORD_TYPES.OrgEvent.attribution.put, "forbidden: authorId must match authenticated agent");
    if (attr.denied) return attr.denied;

    // attention-plane vocabulary gate (flair#675) — same as post() above.
    const entitiesError = invalidEntitiesResponse(content.entities);
    if (entitiesError) return entitiesError;

    return (databases as any).flair.OrgEvent.put(content);
  }

  async delete(id: any, context?: any) {
    // Dispatch shape shared via record-type-kit.ts's resolveAuthGate — same
    // three-way branch Memory.ts/Relationship.ts/WorkspaceState.ts use.
    const gate = await resolveAuthGate((this as any).getContext?.(), UNAUTH());
    if (gate.kind === "denied") return gate.response;
    if (gate.kind === "unfiltered") return super.delete(id, context);

    const record = await this.get(id);
    if (!record) return super.delete(id, context);
    if (record.authorId !== gate.agentId) {
      return FORBIDDEN("forbidden: cannot delete events authored by another agent");
    }
    return super.delete(id, context);
  }
}
