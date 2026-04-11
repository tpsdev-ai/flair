import { databases } from "@harperfast/harper";
import { isAdmin } from "./auth-middleware.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";

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

  async search(query?: any) {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authAgent: string | undefined = request?.tpsAgent;
    const isAdminAgent: boolean = request?.tpsAgentIsAdmin ?? false;

    if (!authAgent || isAdminAgent) {
      return super.search(query);
    }

    // Non-admin: scope to own credentials
    const condition = { attribute: "principalId", comparator: "equals", value: authAgent };
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

    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authAgent: string | undefined = request?.tpsAgent;
    const isAdminAgent: boolean = request?.tpsAgentIsAdmin ?? false;

    // Non-admin can only see their own credentials
    if (authAgent && !isAdminAgent && result.principalId !== authAgent) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }

    // Never return token hashes
    const { tokenHash, ...safe } = result;
    return safe;
  }

  async put(content: any) {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authAgent: string | undefined = request?.tpsAgent;
    const isAdminAgent: boolean = request?.tpsAgentIsAdmin ?? false;

    if (!authAgent) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    // Only admins can create credentials for other principals
    if (!isAdminAgent && content.principalId && content.principalId !== authAgent) {
      return new Response(JSON.stringify({ error: "only admin principals can manage other principals' credentials" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }

    const rl = checkRateLimit(authAgent);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "credential");

    // Validate kind
    const validKinds = ["webauthn", "bearer-token", "ed25519", "idp"];
    if (!content.kind || !validKinds.includes(content.kind)) {
      return new Response(JSON.stringify({ error: `kind must be one of: ${validKinds.join(", ")}` }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    const now = new Date().toISOString();
    content.principalId = content.principalId || authAgent;
    content.status = content.status || "active";
    content.createdAt = content.createdAt || now;
    content.updatedAt = now;

    return super.put(content);
  }

  async delete(_: any) {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const authAgent: string | undefined = request?.tpsAgent;
    const isAdminAgent: boolean = request?.tpsAgentIsAdmin ?? false;

    if (!authAgent) {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    if (!isAdminAgent) {
      const existing = await super.get();
      if (existing?.principalId && existing.principalId !== authAgent) {
        return new Response(JSON.stringify({ error: "only admin principals can revoke other principals' credentials" }), {
          status: 403, headers: { "content-type": "application/json" },
        });
      }
    }

    return super.delete(_);
  }
}
