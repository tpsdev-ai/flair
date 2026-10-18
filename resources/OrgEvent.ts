/**
 * OrgEvent.ts — Harper table resource for org-wide activity events.
 *
 * Auth (self-enforced now that the global gate is non-rejecting):
 *   Read  — any verified agent/admin (org-scoped); anonymous denied.
 *   Write — authorId must match the authenticated agent (or admin); anonymous denied.
 *   createdAt — assigned by the server on create; a write that reaches the
 *               createdAt check cannot change a stored row's value, and a
 *               record whose id the check does not read is refused there
 *               (resources/org-event-created-at.ts).
 *
 * The previous version read context.request.tpsAgent and treated a MISSING agent
 * as trusted (`if (agentId && …)` / `if (!agentId) super.delete`), so anonymous
 * requests slipped through once the gate stopped rejecting. resolveAgentAuth
 * distinguishes internal/agent/anonymous explicitly.
 */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { guardObjectBody } from "./object-body-guard.js";
import { guardOwnerFieldImmutable } from "./owner-field-guard.js";
import { invalidEntitiesResponse } from "./entity-vocab.js";
import {
  isReservedEventRecord,
  reservedEventProposedRefusal,
  reservedEventRefusal,
  reservedEventStoredRefusal,
  reservedEventWriteRefusal,
  reservedEventCheckUnavailable,
  type StoredEventRead,
} from "./org-event-reserved.js";
import {
  applyServerCreatedAt,
  collectionElementIdRefusal,
  createdAtCheckUnavailable,
  invalidEventId,
  type CreatedAtWriteMode,
  unreadableEventIdRefusal,
} from "./org-event-created-at.js";
import {
  makeAuthGate,
  resolveAuthGate,
  stampAttribution,
  FORBIDDEN,
  UNAUTH,
} from "./record-type-kit.js";
import { RECORD_TYPES } from "./record-types.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";

// See makeAuthGate's doc (record-type-kit.ts): must be wired as a genuine
// prototype method below, never a class-field assignment — Harper's
// relationship-traversal RBAC path reads allowRead off the prototype.
const orgEventAuthGate = makeAuthGate();

const readStoredEvent: StoredEventRead = (id) => (databases as any).flair.OrgEvent.get(id, {});

/** Whether any proposed record (a record or an array of them) carries a reserved marker. */
function reservedProposed(content: unknown): boolean {
  const records = Array.isArray(content) ? content : [content];
  return records.some((record) => isReservedEventRecord(record));
}

/**
 * The inherited allow* decision, found above OrgEvent's own prototype so the
 * hook here cannot call itself. A base without the hook keeps the permissive
 * default it had before this class declared one.
 */
function inheritedAllow(name: string, self: any, args: any[]): any {
  let proto = Object.getPrototypeOf(OrgEvent.prototype);
  while (proto) {
    const fn = proto[name];
    if (typeof fn === "function") return fn.apply(self, args);
    proto = Object.getPrototypeOf(proto);
  }
  return true;
}

async function readEventForMutation(id: any, context: any): Promise<any> {
  try {
    return await (databases as any).flair.OrgEvent.get(id, context);
  } catch (err) {
    throw reservedEventCheckUnavailable(err);
  }
}

function eventOutcomeRefusal(): Response {
  return new Response(JSON.stringify({
    error: "stored_row_changed", message: "the OrgEvent write outcome could not be confirmed",
  }), { status: 409, headers: { "Content-Type": "application/json" } });
}

export class OrgEvent extends (databases as any).flair.OrgEvent {
  allowRead() { return orgEventAuthGate.call(this); }

  // Create/update hooks resolve Harper's deserialized body promise.
  async allowCreate(user?: any, newData?: any, context?: any) {
    if (reservedProposed(await newData)) return false;
    return inheritedAllow("allowCreate", this, [user, newData, context]);
  }

  async allowUpdate(user?: any, updatedData?: any, context?: any) {
    if (reservedProposed(await updatedData)) return false;
    return inheritedAllow("allowUpdate", this, [user, updatedData, context]);
  }

  allowDelete(user?: any, target?: any, context?: any) {
    const id = target != null && typeof target === "object" ? (target as any).id : target;
    if (isReservedEventRecord({ id })) return false;
    return inheritedAllow("allowDelete", this, [user, target, context]);
  }

  static getResource(target: any, request: any, options?: any): any {
    const admitted = super.getResource(target, request, options);
    if (this !== OrgEvent || !["post", "put", "patch", "delete"].includes(options?.method)) return admitted;
    return Promise.resolve(admitted).then(async (resource) => {
      const body = await request?.data;
      if (options.method !== "delete") {
        if (options.isCollection && options.method === "put" && Array.isArray(body) &&
          body.some((record) => record === null || typeof record !== "object")) {
          throw Object.assign(new Error("each OrgEvent must be an object"), {
            statusCode: 400, code: "ClientError",
          });
        }
        const bodyDenial = guardObjectBody(body, { allowArrayObjects: options.method === "put" });
        if (bodyDenial) throw bodyDenial;
      }
      const auth = await resolveAgentAuth(request);
      if (auth.kind === "anonymous") throw UNAUTH();
      // Preserve the named refusal before Harper converts a denied hook to its generic 403.
      const proposed = reservedEventProposedRefusal(body);
      if (proposed) throw proposed;
      if (isReservedEventRecord({ id: target?.id })) throw reservedEventRefusal();
      if (options.isCollection && options.method === "put") {
        const reservedDenial = await reservedEventWriteRefusal(body, readStoredEvent);
        if (reservedDenial) throw reservedDenial;
        const denial = collectionElementIdRefusal(body);
        if (denial) throw denial;
      }
      return resource;
    });
  }

  // Keep a collection batch in one write scope instead of Harper's per-element dispatch.
  static async put(target: any, data?: any, context?: any) {
    if (this === OrgEvent && context && target?.isCollection) {
      const body = await data;
      if (Array.isArray(body)) {
        const resource = await this.getResource(target, context, { isCollection: true, method: "put" });
        return resource.put(body);
      }
    }
    return super.put(target, data, context);
  }

  private _auth() {
    return resolveAgentAuth((this as any).getContext?.());
  }

  /**
   * The createdAt check (resources/org-event-created-at.ts), run after this
   * verb's earlier checks. Applies to each record the write stores — the
   * content itself, or each element of an array body — reading the stored row
   * at the id the write lands on: server time with no stored row, the stored
   * value (whatever it is) with one. A record that is not an object, or whose
   * id the check does not read (isReadableEventId), is refused with
   * `invalid_event_id` (400) before any write.
   */
  private async _assignCreatedAt(
    content: any,
    mode: CreatedAtWriteMode,
    idOf: (record: any) => unknown,
  ): Promise<Response | null> {
    const records = Array.isArray(content) ? content : [content];
    for (const record of records) {
      if (record == null || typeof record !== "object" || Array.isArray(record)) return invalidEventId();
      const id = idOf(record);
      const idDenial = unreadableEventIdRefusal(id);
      if (idDenial) return idDenial;
      let stored: Record<string, unknown> | null;
      try {
        stored = ((await (databases as any).flair.OrgEvent.get(id, {})) ?? null) as Record<string, unknown> | null;
      } catch (err) {
        return createdAtCheckUnavailable(err);
      }
      if (isReservedEventRecord(stored)) return reservedEventRefusal();
      const denial = applyServerCreatedAt(record, stored, mode);
      if (denial) return denial;
    }
    return null;
  }

  private async _store(content: any, mode: CreatedAtWriteMode, pausePoint: () => Promise<void> | undefined, addressedId?: any) {
    const table = (databases as any).flair.OrgEvent;
    const records = Array.isArray(content) ? content : [content];
    const auth = await this._auth();
    const plans: { id: any; row: any; basis: any }[] = [];
    let result: any;
    try {
      await withOwnedTransaction((this as any).getContext?.(), async (c) => {
        for (const record of records) {
          const id = mode === "merge" ? addressedId : record.id;
          const idDenial = unreadableEventIdRefusal(id);
          if (idDenial) throw idDenial;
          const basis = await readEventForMutation(id, c);
          if (isReservedEventRecord(basis) || isReservedEventRecord({ id })) throw reservedEventRefusal();
          const owner = await guardOwnerFieldImmutable(this, () => basis, record, "authorId");
          if (owner) throw owner;
          if (auth.kind !== "internal") {
            const denial = applyServerCreatedAt(record, basis, mode);
            if (denial) throw denial;
          }
          plans.push({ id, basis, row: structuredClone(mode === "merge" ? { ...basis, ...record, id } : record) });
        }
        const pause = pausePoint();
        if (pause) await pause;
        result = mode === "merge"
          ? await table.patch(addressedId, content, c)
          : await table.put(content, c);
        for (const plan of plans) {
          const committed = await readEventForMutation(plan.id, {});
          if (isReservedEventRecord(committed)) throw reservedEventRefusal();
          if (!isDeepStrictEqual(committed == null ? null : { ...committed }, plan.basis == null ? null : { ...plan.basis })) {
            throw eventOutcomeRefusal();
          }
        }
        const commit = txnPausePoint("org-event-write-commit");
        if (commit) await commit;
      });
      for (const plan of plans) {
        const committed = await readEventForMutation(plan.id, {});
        if (isReservedEventRecord(committed)) return reservedEventRefusal();
        if (!committed || !isDeepStrictEqual({ ...committed }, plan.row)) {
          return eventOutcomeRefusal();
        }
      }
      return result;
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }
  }

  async post(content: any) {
    const bodyDenial = guardObjectBody(content);
    if (bodyDenial) return bodyDenial;
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();

    // Reserved events belong to the instruction-version appender. Check the
    // proposed kind before attribution; the stored row is checked under the id
    // this POST lands on, once the id is bound below.
    if (isReservedEventRecord(content)) return reservedEventRefusal();

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

    // An addressed POST binds a missing or null body id, and a string or number
    // body id whose text matches the address, to getId(); any other id type is
    // left unchanged by this step.
    // At /OrgEvent/, an absent, null or empty body id generates an id.
    // At /OrgEvent/<prefix>/, a missing body id takes the target id (<prefix>/).
    const addressedId = (this as any).getId?.();
    const addressed = typeof addressedId === "string" || typeof addressedId === "number";
    // A missing or null body id binds to the address; a string or number body id
    // binds when its text matches the address. Any other id type is left
    // unchanged by this binding step. Later checks apply to it where the write reaches
    // them: isReadableEventId first (an invalid id is refused there), then the
    // ownership check and, outside internal calls, the createdAt check.
    if (content && typeof content === "object" && addressed &&
      (content.id == null ||
        ((typeof content.id === "string" || typeof content.id === "number") &&
          String(content.id) === String(addressedId)))) {
      content.id = addressedId;
    }
    // flair#2333 (H9): avoids deterministic same-millisecond collisions (random UUID).
    if (!addressed && (content.id == null || content.id === "")) content.id = `${content.authorId}-${new Date().toISOString()}-${randomUUID()}`;
    // The effective id after binding is the id this write lands on. A reserved
    // address is refused even when the body omits `id` or carries an ordinary kind.
    if (isReservedEventRecord({ id: content.id })) return reservedEventRefusal();
    // Binding runs before validation. At the root collection, or an addressed
    // path whose body id was not bound, a remaining id the shared id rule does
    // not read is refused with invalid_event_id (400) before the ownership lookup.
    const idDenial = unreadableEventIdRefusal(content.id);
    if (idDenial) return idDenial;
    // A trusted in-process call keeps its existing stamp; every verified agent's
    // createdAt is assigned below, once the write passes its other checks.
    if (auth.kind === "internal") content.createdAt = new Date().toISOString();

    // A POST can update an existing row by naming its id. Outside internal
    // calls the createdAt check reads that row and refuses a reserved one; an
    // internal call skips that check, so it is read here.
    if (auth.kind === "internal") {
      const storedReservedDenial = await reservedEventStoredRefusal(content.id, readStoredEvent);
      if (storedReservedDenial) return storedReservedDenial;
    }

    // attention-plane vocabulary gate (flair#675): `entities`, if present,
    // must be well-formed vocabulary strings — see resources/entity-vocab.ts.
    // Field is additive/optional; absent entities is not an error.
    const entitiesError = invalidEntitiesResponse(content.entities);
    if (entitiesError) return entitiesError;

    const ownerDenial = await guardOwnerFieldImmutable(
      this,
      () => (databases as any).flair.OrgEvent.get(content.id, {}),
      content,
      RECORD_TYPES.OrgEvent.ownerField,
    );
    if (ownerDenial) return ownerDenial;

    // createdAt: server time with no stored row; the stored value with one; a
    // record whose id the check does not read is refused. (The id rule above
    // means only a non-empty string or a non-empty array of strings reaches it.)
    if (auth.kind !== "internal") {
      const createdAtDenial = await this._assignCreatedAt(content, "replace", (record) => record.id);
      if (createdAtDenial) return createdAtDenial;
    }

    return this._store(content, "replace", () => txnPausePoint("org-event-post-read"));
  }

  // PATCH routes past put(), so authorId immutability is enforced on both verbs
  // via the one shared delegate.
  async patch(content: any, _query?: any) {
    const bodyDenial = guardObjectBody(content);
    if (bodyDenial) return bodyDenial;
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    const pathId = (this as any).getId?.();
    // Reserved events: the proposed fields are checked here, and the effective
    // id is checked because a PATCH can create the row its URL names. Outside
    // internal calls the createdAt check reads the stored row at the addressed
    // id and refuses a reserved one; an internal call is checked here.
    const proposedReserved = reservedEventProposedRefusal(content);
    if (proposedReserved) return proposedReserved;
    if (isReservedEventRecord({ id: pathId })) return reservedEventRefusal();
    if (auth.kind === "internal") {
      const storedReserved = await reservedEventStoredRefusal(pathId, readStoredEvent);
      if (storedReserved) return storedReserved;
    }
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, "authorId");
    if (denial) return denial;
    // createdAt: PATCH writes the row its URL names, so the stored value is read
    // there; a URL with no id the check reads (the collection) is refused. An
    // omitted createdAt is left out of the merge and keeps that value.
    if (auth.kind !== "internal") {
      const createdAtDenial = await this._assignCreatedAt(content, "merge", () => pathId);
      if (createdAtDenial) return createdAtDenial;
    }
    return this._store(content, "merge", () => txnPausePoint("org-event-patch-read"), pathId);
  }

  async put(content: any) {
    const bodyDenial = guardObjectBody(content, { allowArrayObjects: true });
    if (bodyDenial) throw bodyDenial;
    const __ownerDenial = await guardOwnerFieldImmutable(this, () => super.get(), content, "authorId");
    if (__ownerDenial) return __ownerDenial;
    const auth = await this._auth();
    if (auth.kind === "anonymous") return UNAUTH();
    // Reserved events: a proposed reserved element refuses the whole request
    // before attribution. Outside internal calls the createdAt check reads each
    // stored row and refuses a reserved one; an internal call is checked here.
    const proposedReserved = reservedEventProposedRefusal(content);
    if (proposedReserved) throw proposedReserved;
    if (auth.kind === "internal") {
      const storedReserved = await reservedEventWriteRefusal(content, readStoredEvent);
      if (storedReserved) throw storedReserved;
    }
    // No-forge attribution — mode/field drawn from RECORD_TYPES.OrgEvent.
    // "validate-strict" (see record-type-kit.ts's stampAttribution doc):
    // rejects a mismatch INCLUDING when authorId is absent (a bare `!==`
    // compare, no truthy guard).
    const attr = stampAttribution(auth, content, RECORD_TYPES.OrgEvent.ownerField, RECORD_TYPES.OrgEvent.attribution.put, "forbidden: authorId must match authenticated agent");
    if (attr.denied) return attr.denied;

    // attention-plane vocabulary gate (flair#675) — same as post() above.
    const entitiesError = invalidEntitiesResponse(content.entities);
    if (entitiesError) return entitiesError;

    // createdAt: server time with no stored row; the stored value with one,
    // read under each record's own id; a record whose id the check does not
    // read is refused. A refusal is thrown, so one refused record fails the whole
    // request and nothing in it is written.
    if (auth.kind !== "internal") {
      const createdAtDenial = await this._assignCreatedAt(content, "replace", (record) => record.id);
      if (createdAtDenial) throw createdAtDenial;
    }

    const result = await this._store(content, "replace", () => txnPausePoint("org-event-put-read"));
    if (result instanceof Response) throw result;
    return result;
  }

  async delete(id: any, _context?: any) {
    const gate = await resolveAuthGate((this as any).getContext?.(), UNAUTH());
    if (gate.kind === "denied") return gate.response;
    const target = id != null && typeof id === "object" && !Array.isArray(id) ? id as any : null;
    const addressedKey = target ? target.id : (typeof id === "string" || Array.isArray(id) ? id : (this as any).getId?.());
    const table = (databases as any).flair.OrgEvent;
    const selected: { id: any; basis: any }[] = [];
    try {
      await withOwnedTransaction((this as any).getContext?.(), async (c) => {
        if (target && (target.isCollection === true || target.id == null)) {
          const scan = target instanceof URLSearchParams
            ? Object.assign(new (target.constructor as any)(target.toString()), target)
            : { ...target };
          if (scan instanceof URLSearchParams) {
            scan.delete("select");
            scan.delete("property");
          }
          delete scan.select;
          delete scan.property;
          scan.checkPermission = false;
          for await (const row of this.search(scan)) {
            if (isReservedEventRecord(row)) throw reservedEventRefusal();
            selected.push({ id: row.id, basis: row });
          }
        } else {
          if (isReservedEventRecord({ id: addressedKey })) throw reservedEventRefusal();
          selected.push({ id: addressedKey, basis: await readEventForMutation(addressedKey, c) });
        }
        for (const { basis } of selected) {
          if (isReservedEventRecord(basis)) throw reservedEventRefusal();
          if (basis && gate.kind === "scoped" && basis.authorId !== gate.agentId) {
            throw FORBIDDEN("forbidden: cannot delete events authored by another agent");
          }
        }
        const pause = txnPausePoint("org-event-delete-read");
        if (pause) await pause;
        for (const entry of selected) {
          const stored = await readEventForMutation(entry.id, c);
          if (isReservedEventRecord(stored)) throw reservedEventRefusal();
          await table.delete(entry.id, c);
          const committed = await readEventForMutation(entry.id, {});
          if (isReservedEventRecord(committed)) throw reservedEventRefusal();
          if (!isDeepStrictEqual(committed == null ? null : { ...committed }, entry.basis == null ? null : { ...entry.basis })) {
            throw eventOutcomeRefusal();
          }
        }
      });
      for (const entry of selected) {
        const committed = await readEventForMutation(entry.id, {});
        if (isReservedEventRecord(committed)) return reservedEventRefusal();
        if (committed) return eventOutcomeRefusal();
      }
      return true;
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }
  }
}
