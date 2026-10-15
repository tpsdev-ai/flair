import { databases } from "harper";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { guardOwnerFieldImmutable, ownerCheckUnavailable } from "./owner-field-guard.js";
import { deleteOwnedRow } from "./owner-delete-recheck.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { makeReadScope, makeScopedSearch, stampAttribution, UNAUTH } from "./record-type-kit.js";
import { isForbiddenOwnerMutation, ownerMutationRefusal } from "./record-owner-guard.js";
import { IDP_MAPPING_ADMIN_ONLY, IDP_MAPPING_IDENTITY_FIELDS, IDP_MAPPING_REFUSAL_MESSAGE, isIdpMappingChange } from "../src/lib/idp-mapping-rule.js";

const credentialReadScope = makeReadScope("owner-only", "principalId");
const credentialScopedSearch = makeScopedSearch(credentialReadScope);

/** 403 for a write src/lib/idp-mapping-rule.ts reserves for administrators and the server. */
function idpMappingRefusal(): Response {
  return new Response(JSON.stringify({ error: IDP_MAPPING_ADMIN_ONLY, message: IDP_MAPPING_REFUSAL_MESSAGE }), {
    status: 403, headers: { "content-type": "application/json" },
  });
}

/**
 * The resource-layer write rules for a verified non-admin agent, applied to one
 * record write: `stored` is the row before the write (null for a create) and
 * `next` the row the write would store.
 *
 *   - A non-admin writes only rows it owns, as every owner-scoped resource does
 *     (the owner refusal, checked first).
 *   - Only an administrator or the server creates an IdP identity mapping,
 *     changes its kind or identity fields, or reactivates it
 *     (src/lib/idp-mapping-rule.ts; the named refusal `idp_mapping_admin_only`).
 *
 * Returns the refusal, or null to proceed.
 */
function nonAdminWriteRefusal(stored: any, next: any, callerId: string): Response | null {
  if (stored && isForbiddenOwnerMutation(stored, "principalId", callerId)) return ownerMutationRefusal("Credential");
  if (isIdpMappingChange(stored, next)) return idpMappingRefusal();
  return null;
}

/** A write body the resource treats as one record: a non-null object that is not an array. */
function isRecordBody(content: unknown): content is Record<string, unknown> {
  return content != null && typeof content === "object" && !Array.isArray(content);
}

/**
 * Credential resource — authentication surfaces for Principals.
 *
 * A Principal can have multiple credentials: passkeys, bearer tokens,
 * Ed25519 signing keys, and IdP links. This resource manages the
 * credential lifecycle: creation, revocation, and lookup.
 *
 * Only admin principals can create/revoke credentials for other principals.
 * Non-admin principals can only view their own credentials (token hashes
 * are never returned in responses).
 *
 * On POST, PUT and PATCH, only an admin or the server creates an IdP identity
 * mapping (kind "idp"), changes its kind or identity fields, or reactivates it
 * (src/lib/idp-mapping-rule.ts). A non-admin agent may relabel and revoke its
 * own; DELETE of its own stays allowed under the owner check.
 */
export class Credential extends (databases as any).flair.Credential {
  private async writeAgainstStoredRow(stored: any, content: any, write: () => Promise<any>) {
    const ctx = (this as any).getContext?.();
    return withOwnedTransaction(ctx, async () => {
      const pause = txnPausePoint("credential-row-write");
      if (pause) await pause;
      const id = (this as any).getId?.() ?? stored?.id ?? content.id;
      if (id != null) {
        let committed: any;
        try {
          committed = (await (databases as any).flair.Credential.get(id, {})) ?? null;
        } catch (err) {
          throw ownerCheckUnavailable(err);
        }
        const fields = ["status", "kind", ...IDP_MAPPING_IDENTITY_FIELDS];
        if (!!committed !== !!stored || fields.some((field) => !isDeepStrictEqual(committed?.[field], stored?.[field]))) {
          throw new Response(JSON.stringify({ error: "stored_row_changed", message: "the stored record changed; retry the write" }), {
            status: 409, headers: { "content-type": "application/json" },
          });
        }
      }
      return await write();
    });
  }

  /**
   * Self-authorize (mirrors Soul.ts/Relationship.ts/WorkspaceState.ts). Harper
   * routes some request shapes (e.g. collection-describe `GET /Credential`)
   * OUTSIDE get()/search() entirely, so those in-method checks alone don't
   * cover every path — Credential was the one sibling in this sensitive class
   * missing this gate (#556/#557 swept the others). Deny anonymous/unverified
   * here; get()/search() below still enforce per-agent ownership scoping on
   * top of this for the paths they do see.
   */
  allowRead() { return allowVerified((this as any).getContext?.()); }

  /**
   * Self-authorize creation (same posture as allowRead).  Without this gate
   * Harper routes POST /Credential to the base class's post() — which has
   * no cross-principal check — letting an unauthenticated caller create
   * credentials for any principal.
   */
  allowCreate() { return allowVerified((this as any).getContext?.()); }

  /**
   * Create a credential.  No-forge attribution via stampAttribution
   * ("stamp-default" mode): a non-admin agent's credential is ALWAYS
   * attributed to the authenticated identity — we never trust
   * content.principalId from the body.  An admin may create on behalf of
   * another principal (content.principalId honored if present, else
   * defaults to the admin's own id).  Internal in-process callers keep
   * whatever principalId they pass.
   *
   * Previously Credential had no post() override — the base class's post()
   * ran with no cross-principal check, so any verified caller could create
   * a credential for any principal by setting principalId in the body.
   */
  async post(content: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") return UNAUTH();

    // No-forge attribution: stamp principalId from the authenticated
    // identity.  "stamp-default" unconditionally overwrites for non-admin;
    // admin may supply their own value (defaults to admin's id if absent).
    stampAttribution(auth, content, "principalId", "stamp-default", "forbidden: unreachable for stamp-default");

    const rl = checkRateLimit(auth.kind === "agent" ? auth.agentId : "internal");
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "credential");

    // Validate kind
    const validKinds = ["webauthn", "bearer-token", "ed25519", "idp"];
    if (!content.kind || !validKinds.includes(content.kind)) {
      return new Response(JSON.stringify({ error: `kind must be one of: ${validKinds.join(", ")}` }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // A POST creates (Harper refuses an existing id with 409), so there is no
    // stored row: a non-admin may not create an IdP identity mapping.
    if (auth.kind === "agent" && !auth.isAdmin) {
      const denial = nonAdminWriteRefusal(null, content, auth.agentId);
      if (denial) return denial;
    }

    const now = new Date().toISOString();
    content.status = content.status || "active";
    content.createdAt = content.createdAt || now;
    content.updatedAt = now;

    return super.post(content);
  }

  async search(query?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());

    // Anonymous HTTP must NOT read credentials. (Previously `!authAgent` was
    // treated as trusted/unfiltered — which leaked every credential to an
    // unauthenticated caller once the gate stopped rejecting.)
    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    // Trusted internal call or admin agent → unfiltered.
    if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) {
      return super.search(query);
    }

    // Non-admin agent: scope to own credentials.
    return credentialScopedSearch(auth.agentId, query, (q: any) => super.search(q));
  }

  async get() {
    const result = await super.get();
    if (!result) return result;

    const auth = await resolveAgentAuth((this as any).getContext?.());

    // Anonymous HTTP must NOT read a credential (previously it fell through the
    // ownership check and returned the record sans tokenHash — a metadata leak).
    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }

    // Non-admin agent can only see their own credentials. (Internal + admin pass.)
    if (auth.kind === "agent" && !auth.isAdmin && result.principalId !== auth.agentId) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }

    // Never return token hashes
    const { tokenHash, ...safe } = result;
    return safe;
  }

  // PATCH routes past put(), so the owner-field rule below is enforced on both
  // verbs via the one shared delegate. principalId owns a credential; a non-admin
  // may rotate a token on its OWN credential but never re-point it at another
  // principal. (Self-update stays legitimate — update:true is retained.)
  //
  // A non-admin's PATCH is also held to nonAdminWriteRefusal against the row as
  // the patch would leave it (stored merged with the body).
  async patch(content: any, query?: any) {
    const denial = await guardOwnerFieldImmutable(this, () => super.get(), content, "principalId");
    if (denial) return denial;
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "agent" && !auth.isAdmin) {
      if (!isRecordBody(content)) {
        return new Response(JSON.stringify({ error: "a Credential PATCH body must be one record object" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      let stored: any;
      try {
        stored = (await super.get()) ?? null;
      } catch (err) {
        return ownerCheckUnavailable(err);
      }
      const refusal = nonAdminWriteRefusal(stored, { ...(stored ?? {}), ...content }, auth.agentId);
      if (refusal) return refusal;
      return this.writeAgainstStoredRow(stored, content, () => super.patch(content, query));
    }
    return super.patch(content, query);
  }

  async put(content: any) {
    const __ownerDenial = await guardOwnerFieldImmutable(this, () => super.get(), content, "principalId");
    if (__ownerDenial) return __ownerDenial;
    const auth = await resolveAgentAuth((this as any).getContext?.());

    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    // Only admins can update credentials for other principals
    if (auth.kind === "agent" && !auth.isAdmin && content.principalId && content.principalId !== auth.agentId) {
      return new Response(JSON.stringify({ error: "only admin principals can manage other principals' credentials" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }

    const rl = checkRateLimit(auth.kind === "agent" ? auth.agentId : "internal");
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "credential");

    // Validate kind
    const validKinds = ["webauthn", "bearer-token", "ed25519", "idp"];
    if (!content.kind || !validKinds.includes(content.kind)) {
      return new Response(JSON.stringify({ error: `kind must be one of: ${validKinds.join(", ")}` }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    const now = new Date().toISOString();
    content.principalId = content.principalId || (auth.kind === "agent" ? auth.agentId : content.principalId);
    content.status = content.status || "active";
    content.createdAt = content.createdAt || now;
    content.updatedAt = now;

    // A PUT replaces the row with `content`. These refusals are thrown: Harper
    // answers a thrown Response as the response and abandons the write's
    // transaction.
    if (auth.kind === "agent" && !auth.isAdmin) {
      let stored: any;
      try {
        stored = (await super.get()) ?? null;
      } catch (err) {
        throw ownerCheckUnavailable(err);
      }
      const refusal = nonAdminWriteRefusal(stored, content, auth.agentId);
      if (refusal) throw refusal;
      return this.writeAgainstStoredRow(stored, content, () => super.put(content));
    }

    return super.put(content);
  }

  async delete(_: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);

    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    if (auth.kind === "agent" && !auth.isAdmin) {
      const existing = await super.get();
      if (existing?.principalId && existing.principalId !== auth.agentId) {
        return new Response(JSON.stringify({ error: "only admin principals can revoke other principals' credentials" }), {
          status: 403, headers: { "content-type": "application/json" },
        });
      }
      // flair#2355: a row that is no longer the caller's at the delete's re-read
      // or confirmation read is refused, not deleted
      // (resources/owner-delete-recheck.ts).
      if (existing) {
        const beforeDelete = txnPausePoint("credential-delete-pre");
        if (beforeDelete) await beforeDelete;
        const outcome = await deleteOwnedRow(ctx, {
          table: (databases as any).flair.Credential,
          tableName: "Credential",
          id: typeof _ === "string" ? _ : existing.id,
          ownerField: "principalId",
          callerId: auth.agentId,
          point: "credential-delete",
        });
        if (outcome.kind === "refused") return outcome.response;
        if (outcome.kind === "absent") return super.delete(_);
        return outcome.result;
      }
    }

    return super.delete(_);
  }
}
