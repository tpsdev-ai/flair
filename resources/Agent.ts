import { databases } from "harper";
import { isAdmin, resolveAgentAuth, allowVerified, allowAdmin, invalidateAdminCache } from "./agent-auth.js";
import { agentRecordIsAdmin, reconcileAdminFields } from "./agent-admin.js";
import { admitPrincipalWrite, statusWriteRefusal } from "./agent-status-guard.js";
import { applyFederationBookkeeping, applyOriginatorInstanceId, dropClientFederationBookkeeping, resolveStoredRow, stampOriginatorOnCreate } from "./originator-instance.js";
import { localInstanceId } from "./instance-identity.js";
import { AGENT_ID_ERROR, invalidAgentIdMessage, isValidAgentId } from "../src/lib/agent-id-rule.js";
import { AGENT_HOME_STAMP_FIELD, AGENT_PRINCIPAL_WRITE_BACK_FIELD, isForeignAgentHome, isHomeLessAgentRow, isSyncOriginatedAgentRow } from "../src/lib/agent-home-fields.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";

/**
 * The id this write lands on: the URL-bound target (`getId()`) when there is
 * one, otherwise the body `id` (an in-process call, where the body id IS the
 * write key). `present` is true only when an id was SUPPLIED — a body carrying
 * an `id` key whose value is `null` is present, while a body with no `id` key
 * is absent. A non-scalar target is ignored.
 */
function writeTargetId(resource: any, content: any): { present: boolean; value: unknown } {
  try {
    const getId = resource?.getId;
    const id = typeof getId === "function" ? getId.call(resource) : undefined;
    if (typeof id === "string" || typeof id === "number") return { present: true, value: id };
  } catch {
    /* getId() threw — fall back to the body id below */
  }
  if (content != null && typeof content === "object" && "id" in content && content.id !== undefined) {
    return { present: true, value: content.id };
  }
  return { present: false, value: undefined };
}

/** A 400 refusing a SUPPLIED agent id outside the shared rule, before anything
 *  is written. An ABSENT id is allowed: a collection POST with no `id` key lets
 *  Harper generate one (a UUID, which matches the rule), and a PUT/PATCH with
 *  neither a URL target nor a body id has no id to validate. A body that
 *  supplies `id: null` is present and refused — null is not an id. */
function agentIdDenial(target: { present: boolean; value: unknown }): Response | null {
  if (!target.present) return null;
  if (isValidAgentId(target.value)) return null;
  return new Response(
    JSON.stringify({ error: AGENT_ID_ERROR, message: invalidAgentIdMessage(target.value) }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/**
 * Thrown INSIDE the guarded home stamp's owned transaction to ABORT it when the
 * committed row is no longer eligible (it gained a home or provenance) or is
 * gone. Aborting discards the staged write; the caller maps the reason to the
 * response. See Agent.applyGuardedHomeStamp (flair#2472).
 */
class AgentHomeStampAborted extends Error {
  constructor(readonly reason: "no-row" | "ineligible") {
    super(`agent home stamp aborted: ${reason}`);
    this.name = "AgentHomeStampAborted";
  }
}

/**
 * Thrown INSIDE the guarded principal write-back's owned transaction to ABORT it
 * when the committed row's home became foreign between the staging and the
 * confirmation read. Aborting discards the staged write; the caller answers
 * `originator_instance_immutable`. See Agent.applyGuardedPrincipalWriteBack
 * (flair#2473).
 */
class PrincipalWriteBackAborted extends Error {
  constructor() {
    super("agent principal write-back aborted: the committed home became foreign");
    this.name = "PrincipalWriteBackAborted";
  }
}

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
    // flair#2359 — the ONE agent-ID rule, before any field is defaulted or
    // written. A create must never store an id AgentSeed would refuse.
    const idDenial = agentIdDenial(writeTargetId(this, content));
    if (idDenial) return idDenial;

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

    // Write-time originatorInstanceId (federation-edge-hardening slice 1): a
    // post() is a CREATE — stamp this instance's own id, ignoring any
    // request-body value. See resources/originator-instance.ts for the full
    // contract (create/update rule; the federation merge path is the raw
    // table writer and never consults a body).
    await stampOriginatorOnCreate(content);
    dropClientFederationBookkeeping(content);

    return super.post(content, context);
  }

  /**
   * Authorization shared by BOTH mutation paths (PUT → put, PATCH → patch).
   *
   * It lives in one place because it previously lived only in put(), and PATCH
   * does not route through put() — so every rule written here was enforced on
   * one verb and not the other. Returns a Response to send, or null to proceed.
   *
   * Three rules:
   *   1. Only an admin principal may modify a principal OTHER than itself.
   *   2. Only an admin principal may change a principal's ADMIN STATUS — on any
   *      record, including the caller's own. Rule 1 alone never covered this:
   *      an agent editing its own record is inside its rights for ordinary
   *      fields (runtime, displayName, subjects) and must not be for the fields
   *      that decide whether it is an administrator.
   *   3. A non-admin caller may not write `status` — the principal's LIFECYCLE
   *      state — on any record, including its own (flair#2108). A body that
   *      includes `status` is refused whole, so the other fields in that
   *      request are not written either.
   *
   * `internal` (in-process maintenance, federation merge) and admin agents pass
   * through unchanged.
   */
  private async authorizePrincipalWrite(content: any): Promise<Response | null> {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    // A trusted internal call and an administrator are admitted here. Anonymous
    // and any verdict kind the auth resolver does not define are refused before
    // any mutation. A non-admin agent goes on to the rules below: a body with
    // `status` is refused (rule 3); without it, rules 1 and 2 decide.
    const admission = admitPrincipalWrite(auth);
    if (admission === "internal" || admission === "admin") return null;
    if (admission === "deny") {
      const anonymous = (auth as { kind?: unknown }).kind === "anonymous";
      return new Response(
        JSON.stringify({ error: anonymous ? "authentication required" : "unrecognized caller verdict; refused" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    // admission === "non-admin" here. Narrow the type (and stay fail-closed if a
    // future verdict shape ever slipped past admitPrincipalWrite).
    if (auth.kind !== "agent") {
      return new Response(JSON.stringify({ error: "unrecognized caller verdict; refused" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }

    // 3. A non-admin caller may not write `status`, on ANY row, including its
    // own. Refused before the target-row update, so nothing in the request is
    // applied.
    const statusDenial = statusWriteRefusal(content, false);
    if (statusDenial) return statusDenial;

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
    // flair#2359 — refuse an id outside the shared rule before any read or
    // write. A PUT to a new id is a create (Harper's put is an upsert).
    const idDenial = agentIdDenial(writeTargetId(this, content));
    if (idDenial) return idDenial;

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

    // Write-time originatorInstanceId — see post() above /
    // resources/originator-instance.ts. A CREATE stamps the local id; an
    // UPDATE keeps the stored value (a body value never replaces or clears it).
    // The row is resolved by the URL-BOUND target id, never a body `id` (Harper
    // writes to the URL target); a mismatch or a failed read refuses the write.
    const resolvedOriginRow = await resolveStoredRow(this, "Agent", content, () => super.get());
    if (resolvedOriginRow.denial) return resolvedOriginRow.denial;
    await applyOriginatorInstanceId(content, resolvedOriginRow.row);
    applyFederationBookkeeping(content, resolvedOriginRow.row);

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
    // flair#2359 — refuse an id outside the shared rule before any read or
    // write.
    const idDenial = agentIdDenial(writeTargetId(this, content));
    if (idDenial) return idDenial;

    const denial = await this.authorizePrincipalWrite(content);
    if (denial) return denial;

    // flair#2472 — the guarded home stamp, the write `flair agent stamp-home
    // --apply` sends. This is NOT an ordinary merge: it decides and writes
    // inside a FRESH OWNED transaction (see applyGuardedHomeStamp), never from
    // the request's pinned read snapshot. Handled before the generic merge so
    // it never re-stamps a stored home or re-creates a deleted row.
    if (content != null && typeof content === "object" && content[AGENT_HOME_STAMP_FIELD] === true) {
      delete content[AGENT_HOME_STAMP_FIELD];
      return this.applyGuardedHomeStamp(content);
    }

    // flair#2473 — the guarded write-back `flair principal add` sends when its
    // create-only insert was SKIPPED: the row exists, so the record is written
    // back WITHOUT the home field. It runs in a FRESH OWNED transaction (see
    // applyGuardedPrincipalWriteBack) and refuses when the row's committed home
    // became foreign, so a row that now belongs to a peer is never changed.
    if (content != null && typeof content === "object" && content[AGENT_PRINCIPAL_WRITE_BACK_FIELD] === true) {
      delete content[AGENT_PRINCIPAL_WRITE_BACK_FIELD];
      return this.applyGuardedPrincipalWriteBack(content);
    }

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
      // flair#1965 r2: an EXISTING row keeps its stored originatorInstanceId
      // (a body value is dropped); a PATCH whose URL target has no stored row is
      // a CREATE when it reaches the table and must stamp the local id (Harper's
      // patch path does not require an existing row; only an administrator's or
      // a trusted internal PATCH gets that far — resources/table-patch-policy.ts
      // refuses the rest). The row is resolved by the URL-BOUND target id, never
      // a body `id`. See resources/originator-instance.ts.
      const resolvedOriginRow = await resolveStoredRow(this, "Agent", content, () => super.get());
      if (resolvedOriginRow.denial) return resolvedOriginRow.denial;
      await applyOriginatorInstanceId(content, resolvedOriginRow.row);
      applyFederationBookkeeping(content, resolvedOriginRow.row);
      content.updatedAt = new Date().toISOString();
    }

    const result = await super.patch(content, query);
    invalidateAdminCache();
    return result;
  }

  /**
   * The guarded home stamp (flair#2472), the ONE write `flair agent stamp-home
   * --apply` sends. It is decided and applied inside a FRESH OWNED transaction,
   * never from the request's pinned read snapshot.
   *
   * Harper loads `/Agent/:id` before this override runs, so the request context
   * already carries this row in its read snapshot. A decision made from that
   * snapshot is stale: a federation merge or another creator that commits in
   * between is invisible. `withOwnedTransaction` detaches the request's
   * transaction for this call and reads the row in a scope this call OWNS, so
   * the decision is over the row as it is at write time.
   *
   * The rules, all evaluated against the committed row:
   *   - an absent row is refused (404); a stamp NEVER creates, so a row deleted
   *     since the caller's read is not re-created;
   *   - a row that is not home-less, or that carries federation-sync provenance,
   *     is reported `stamped: false` (a 200, NO patch, no `updatedAt` change);
   *   - this instance's own id — never the request body's — is the value stamped;
   *     when there is no canonical Instance row (none, or several) there is no id
   *     to stamp and the write is REFUSED by name, before any PATCH;
   *   - the update is STAGED first, then the COMMITTED row is re-read in an
   *     explicit fresh context (never this transaction's snapshot or its staged
   *     write). A row that gained a home or provenance, or that is gone, ABORTS
   *     this owned transaction and discards the staged write.
   *
   * Harper has no compare-and-set: a home or provenance committed after that
   * confirmation and before this transaction's commit is still not seen (the
   * residual window; per-id serialization is tracked in flair#2478).
   *
   * The CLI reports a row `stamped` only when this resource confirms it applied
   * the stamp (`stamped: true`): a read-back that merely shows this instance's
   * home is not enough — another writer may have set it.
   */
  private async applyGuardedHomeStamp(content: any): Promise<Response> {
    const admission = admitPrincipalWrite(await resolveAgentAuth((this as any).getContext?.()));
    if (admission !== "admin" && admission !== "internal") {
      return new Response(
        JSON.stringify({ error: "agent_home_stamp_forbidden", message: "the home stamp is an administrator or trusted-internal write" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    const target = writeTargetId(this, content);
    const id = target.present && (typeof target.value === "string" || typeof target.value === "number")
      ? String(target.value)
      : null;
    const noRow = () => new Response(
      JSON.stringify({ error: "agent_home_stamp_no_row", message: "no stored agent row to stamp" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
    const ineligible = () => new Response(
      JSON.stringify({ id, stamped: false, reason: "ineligible" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    if (id === null) return noRow();

    // Resolve everything that can yield FIRST (flair#2478 pattern): the value to
    // stamp. Nothing may await between the eligibility read and the staging, or a
    // writer could commit in that gap and be missed by the confirmation read.
    const home = await localInstanceId();
    // No canonical Instance row (none, or several): there is no id to stamp, so
    // refuse by name, inside the resource and BEFORE any PATCH. Never report the
    // row stamped.
    if (home === null) {
      return new Response(
        JSON.stringify({ error: "agent_home_stamp_no_instance", message: "this instance has no single canonical Instance row to stamp as the home; the row was not written" }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }

    const table = (databases as any).flair?.Agent;
    const readRow = async (context: unknown): Promise<Record<string, any> | null> => {
      if (!table || typeof table.get !== "function") return null;
      const row = await table.get(id, context);
      return row && typeof row === "object" && !(row instanceof Response) ? row : null;
    };
    const eligible = (row: Record<string, any>): boolean => isHomeLessAgentRow(row) && !isSyncOriginatedAgentRow(row);
    const stampBody = { originatorInstanceId: home, updatedAt: new Date().toISOString() };
    let outcome: { kind: "no-row" | "ineligible" | "applied" };
    try {
      outcome = await withOwnedTransaction((this as any).getContext?.(), async (c: unknown) => {
        // The row as this call OWNS it — a scope the request's snapshot does not pin.
        const stored = await readRow(c);
        if (stored === null) return { kind: "no-row" as const };
        if (!eligible(stored)) return { kind: "ineligible" as const };
        if (!table || typeof table.update !== "function") return { kind: "no-row" as const };
        // STAGE the home-only write in this transaction's own scope.
        await table.update(id, stampBody, c);
        // Test-only: inert unless the fault-injection env opt-in is set and armed.
        // The name is a DIRECT string literal at the call site (flair#2382's
        // checker scans resources/ and src/ and resolves only literals); it must
        // stay equal to AGENT_HOME_STAMP_PAUSE_POINT, which the integration test
        // arms (test/integration/agent-home-2433.test.ts).
        const pause = txnPausePoint("agent-home-stamp");
        if (pause) await pause;
        // CONFIRM the COMMITTED row (an explicit fresh context, never this
        // transaction's snapshot or its staged write) is still eligible. A row
        // that gained a home or provenance, or that is gone, ABORTS this owned
        // transaction: the staged write is discarded and the caller is told.
        const committed = await readRow({});
        if (committed === null) throw new AgentHomeStampAborted("no-row");
        if (!eligible(committed)) throw new AgentHomeStampAborted("ineligible");
        return { kind: "applied" as const };
      });
    } catch (err) {
      if (err instanceof AgentHomeStampAborted) return err.reason === "no-row" ? noRow() : ineligible();
      throw err;
    }

    invalidateAdminCache();
    if (outcome.kind === "no-row") return noRow();
    if (outcome.kind === "ineligible") return ineligible();
    return new Response(
      JSON.stringify({ id, stamped: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  /**
   * The guarded write-back (flair#2473), the ONE write `flair principal add`
   * sends when its create-only `insert` was SKIPPED because the row already
   * exists. The record is written back WITHOUT the home field, so a stored home
   * stands. It runs inside a FRESH OWNED transaction, never from the request's
   * pinned read snapshot, and REFUSES `originator_instance_immutable` when the
   * committed row's home is FOREIGN (a non-empty id that is not this instance's):
   * such a row now belongs to a peer, so this command must not change it.
   *
   * The update is STAGED first, then the COMMITTED row is re-read in an explicit
   * fresh context. A row whose home became foreign between the staging and that
   * confirmation ABORTS this owned transaction and discards the staged write
   * (`originator_instance_immutable`). Harper has no compare-and-set: a home that
   * becomes foreign after the confirmation and before the commit is still not
   * seen (the residual window; per-id serialization is tracked in flair#2478).
   */
  private async applyGuardedPrincipalWriteBack(content: any): Promise<Response> {
    const immutable = () => new Response(
      JSON.stringify({ error: "originator_instance_immutable", message: "originator_instance_immutable: the agent row's home is a peer's; refusing to change it" }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
    const target = writeTargetId(this, content);
    const id = target.present && (typeof target.value === "string" || typeof target.value === "number")
      ? String(target.value)
      : null;
    if (id === null) return immutable();

    // Resolve everything that can yield FIRST (flair#2478 pattern) — this
    // instance's own id — so nothing awaits between the eligibility read and the
    // staging. The body carries no home field, so the stored home stands.
    const home = await localInstanceId();
    const table = (databases as any).flair?.Agent;
    const body = { ...content, id };
    let outcome: { kind: "refused" | "applied" };
    try {
      outcome = await withOwnedTransaction((this as any).getContext?.(), async (c: unknown) => {
        if (!table || typeof table.get !== "function" || typeof table.update !== "function") {
          return { kind: "refused" as const };
        }
        const stored = await table.get(id, c);
        if (isForeignAgentHome(stored, home)) return { kind: "refused" as const };
        // STAGE the write-back in this transaction's own scope.
        await table.update(id, body, c);
        // Test-only: inert unless the fault-injection env opt-in is set and armed.
        const pause = txnPausePoint("agent-principal-write-back");
        if (pause) await pause;
        // CONFIRM the COMMITTED row's home is still not foreign. A home that
        // became a peer's ABORTS this owned transaction, discarding the staged
        // write.
        const committed = await table.get(id, {});
        if (isForeignAgentHome(committed, home)) throw new PrincipalWriteBackAborted();
        return { kind: "applied" as const };
      });
    } catch (err) {
      if (err instanceof PrincipalWriteBackAborted) return immutable();
      throw err;
    }

    invalidateAdminCache();
    if (outcome.kind === "refused") return immutable();
    return new Response(
      JSON.stringify({ id, writtenBack: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
}
