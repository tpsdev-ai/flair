import { databases } from "harper";
import { isAdmin, resolveAgentAuth, allowVerified, allowAdmin, invalidateAdminCache } from "./agent-auth.js";
import { agentRecordIsAdmin, reconcileAdminFields } from "./agent-admin.js";
import { localInstanceId } from "./instance-identity.js";

/**
 * Agent resource — serves as the Principal table in 1.0.
 *
 * The Agent table is extended (not replaced) to serve as the Principal
 * model. The `kind` field distinguishes humans from agents. Pre-1.0
 * records without `kind` are treated as agents with default trust tier.
 *
 * Principal fields added in 1.0:
 *   - kind: "human" | "agent"
 *   - displayName: human-friendly label
 *   - status: "active" | "deactivated"
 *   - defaultTrustTier: "endorsed" | "corroborated" | "unverified"
 *   - admin: boolean
 *   - runtime: how to reach this principal
 *   - subjects: soul-level subject interests
 */
export class Agent extends (databases as any).flair.Agent {
  // Self-authorize now that the global gate is non-rejecting. Verified agents read
  // the principal table for discovery; an agent updates only its OWN record (put
  // handler enforces ownership). Creating/deleting principals is admin-only
  // (flair_agent grant: insert=false, delete=false). Anonymous denied throughout.
  allowRead()   { return allowVerified((this as any).getContext?.()); }
  allowCreate() { return allowAdmin((this as any).getContext?.()); }
  allowUpdate() { return allowVerified((this as any).getContext?.()); }
  allowDelete() { return allowAdmin((this as any).getContext?.()); }

  async post(content: any, context: any) {
    const now = new Date().toISOString();

    // Backward compat: set type for legacy code
    content.type ||= "agent";

    // 1.0 Principal defaults
    content.kind ||= "agent";
    content.status ||= "active";
    content.displayName ||= content.name;

    // flair#941 — the two admin fields are reconciled BEFORE anything derives
    // from them, so `role` and `admin` agree on disk whichever one the caller
    // used. Replaces `content.admin ??= false`, which defaulted the mirror
    // without ever consulting the authority: a caller who passed role:"admin"
    // got a record that was an admin at the gate and a non-admin to every
    // reporter. allowCreate() is allowAdmin(), so this path is admin-only.
    reconcileAdminFields(content);

    // Trust tier defaults per kind — derived from the SAME predicate the gate
    // uses, so an admin principal cannot land on the non-admin default just
    // because the caller spelled admin the other way.
    if (!content.defaultTrustTier) {
      content.defaultTrustTier = agentRecordIsAdmin(content) ? "endorsed" : "unverified";
    }

    content.createdAt = now;
    content.updatedAt = now;

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

  /**
   * Authorization shared by BOTH mutation paths (PUT → put, PATCH → patch).
   *
   * It lives in one place because it previously lived only in put(), and PATCH
   * does not route through put() — so every rule written here was enforced on
   * one verb and not the other. Returns a Response to send, or null to proceed.
   *
   * Two rules:
   *   1. Only an admin principal may modify a principal OTHER than itself.
   *   2. Only an admin principal may change a principal's ADMIN STATUS — on any
   *      record, including the caller's own. Rule 1 alone never covered this:
   *      an agent editing its own record is inside its rights for ordinary
   *      fields (runtime, displayName, subjects) and must not be for the fields
   *      that decide whether it is an administrator.
   *
   * `internal` (in-process maintenance, federation merge) and admin agents pass
   * through unchanged.
   */
  private async authorizePrincipalWrite(content: any): Promise<Response | null> {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    // Anonymous denied (defense-in-depth alongside allowUpdate; the old check read
    // tpsAgent and treated a missing agent as trusted, so anonymous slipped through).
    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    if (auth.kind !== "agent" || auth.isAdmin) return null;

    const existing = await Promise.resolve(super.get()).catch(() => null);

    // 1. Only admin principals can modify OTHER principals.
    if (existing && existing.id !== auth.agentId) {
      return new Response(JSON.stringify({ error: "only admin principals can modify other principals" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }

    // 2. Only admin principals can change admin status. Compare the RESULTING
    // status against the stored one so an ordinary self-update that simply
    // doesn't mention either field is unaffected, and a no-op restatement of
    // the caller's existing status is not a spurious denial.
    const touchesPrivilegeFields =
      content != null && typeof content === "object" && ("role" in content || "admin" in content);
    if (touchesPrivilegeFields) {
      const merged = { ...(existing ?? {}), ...content };
      const wouldBeAdmin = agentRecordIsAdmin(merged) || merged.admin === true;
      const isAdminNow = agentRecordIsAdmin(existing) || (existing?.admin === true);
      if (wouldBeAdmin !== isAdminNow) {
        return new Response(JSON.stringify({ error: "only admin principals can change a principal's admin status" }), {
          status: 403, headers: { "content-type": "application/json" },
        });
      }
    }

    return null;
  }

  async put(content: any) {
    const denial = await this.authorizePrincipalWrite(content);
    if (denial) return denial;

    content.updatedAt = new Date().toISOString();

    // Protect immutable fields
    delete content.createdAt;
    delete content.publicKey; // key rotation goes through dedicated endpoint

    // Keep the two admin fields agreeing on disk — see resources/agent-admin.ts.
    // Only an admin can have reached here with a privilege change (see
    // authorizePrincipalWrite), so this normalises an authorized intent; it
    // never manufactures one.
    reconcileAdminFields(content);

    // Write-time originatorInstanceId stamp — see post() above / Memory.ts's
    // stampOriginatorInstanceId doc. No-op if already set.
    if (content.originatorInstanceId == null) {
      content.originatorInstanceId = await localInstanceId();
    }

    const result = await super.put(content);
    invalidateAdminCache();
    return result;
  }

  /**
   * PATCH → Harper's partial update (`Resource.patch(data, query)`; see
   * harper/dist/server/REST.js's method switch and Resource.js's static patch).
   *
   * This override exists because there was none. Every per-record authorization
   * rule this resource enforces was written in put(), and PATCH does not route
   * through put() — so none of those rules ran on a PATCH. allowUpdate() is
   * allowVerified(), which means the only check a PATCH ever met was "are you
   * some verified agent"; the rules that make the principal table safe (you may
   * only edit yourself; you may not change your own admin status) were not
   * among them.
   *
   * That is the shape flair#941 keeps running into: a check that reads as
   * complete because it exists, and simply is not on the path the caller took.
   * Both verbs now share authorizePrincipalWrite().
   */
  async patch(content: any, query?: any) {
    const denial = await this.authorizePrincipalWrite(content);
    if (denial) return denial;

    if (content != null && typeof content === "object") {
      // A partial update must not be able to leave the record's two admin
      // fields disagreeing, so reconcile against the MERGED result rather than
      // the patch alone — patching only `role` has to carry the mirror with it.
      if ("role" in content || "admin" in content) {
        const existing = await Promise.resolve(super.get()).catch(() => null);
        const merged = reconcileAdminFields({ ...(existing ?? {}), ...content });
        content.role = merged.role;
        content.admin = merged.admin;
      }
      // Immutable fields, matching put().
      delete content.createdAt;
      delete content.publicKey;
      content.updatedAt = new Date().toISOString();
    }

    const result = await super.patch(content, query);
    invalidateAdminCache();
    return result;
  }
}
