import { databases } from "harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { stampAttribution, UNAUTH } from "./record-type-kit.js";

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
 */
export class Credential extends (databases as any).flair.Credential {
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
    const condition = { attribute: "principalId", comparator: "equals", value: auth.agentId };
    if (!query?.conditions) {
      return super.search({ conditions: [condition], ...(query || {}) });
    }
    return super.search({
      ...query,
      conditions: [condition, { conditions: query.conditions, operator: query.operator || "and" }],
      operator: "and",
    });
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

  async put(content: any) {
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

    return super.put(content);
  }

  async delete(_: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());

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
    }

    return super.delete(_);
  }
}
