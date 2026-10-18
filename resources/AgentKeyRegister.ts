/**
 * AgentKeyRegister.ts — POST /AgentKeyRegister (flair#2266).
 *
 * Register an agent key. Admin only.
 *
 * A standalone CUSTOM Resource, not a verb on the Agent resource: the ordinary
 * agent-authentication middleware resolves the verification key from the STORED
 * row (resources/agent-auth.ts), and a pending row's stored value is the literal
 * string `pending`, which can never verify — so a pending agent cannot
 * authenticate as itself. The Agent resource's `allowUpdate()` admits a Basic
 * admin, but its PUT and PATCH handlers strip `publicKey` from the body
 * (resources/Agent.ts), so neither verb writes the key. Here
 * `allowCreate()` returns true and the handler
 * decides: it admits only an admin and re-reads the row, failing closed on
 * absent evidence.
 *
 * The write runs under the per-agent lock (resources/key-lock.ts, the pairing
 * composition in resources/Federation.ts) inside ONE owned transaction
 * (resources/request-transaction.ts): a fresh read, the exactly-`pending` /
 * local / non-deactivated checks, then the key, the private audit row and the
 * OrgEvent (`detail`: fingerprint; `refId` and `summary`: target id) are staged together, the COMMITTED Agent row is confirmed
 * (resources/write-back.ts) before the commit, and the stored key is read back
 * AFTER the commit. The lock serializes registrations for that agent within one
 * Harper process; raw operations-API writes and other processes do not take it.
 * A change to the fields and identity the post-commit read-back compares,
 * committed after confirmation and before commit, is caught by that read-back;
 * a commit-time pending check is a follow-up.
 * The response is returned only when the read-back is equal.
 *
 * Accepted credentials: Basic admin or a verified Ed25519 agent with the admin
 * annotation. A Harper Bearer token is refused.
 */
import { Resource, databases } from "harper";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentAuth } from "./agent-auth.js";
import { withKeyLock } from "./key-lock.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { CommittedRowChanged, confirmCommittedRow, verifyCommittedFields } from "./write-back.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { isPrincipalDeactivated } from "../src/lib/principal-status.js";
import { isForeignAgentHome, isSyncOriginatedAgentRow } from "../src/lib/agent-home-fields.js";
import { isValidAgentId, invalidAgentIdMessage } from "../src/lib/agent-id-rule.js";
import { localInstanceId } from "./instance-identity.js";
import {
  AGENT_KEY_REGISTERED_EVENT,
  AGENT_KEY_NOT_PENDING,
  AGENT_INACTIVE,
  AGENT_NOT_FOUND,
  AGENT_NOT_LOCAL,
  PENDING_PUBLIC_KEY,
  REGISTRATION_CONFLICT,
  REGISTRATION_REQUEST_INVALID,
  REGISTRATION_UNAVAILABLE,
  isCanonicalEd25519Base64url,
  keyFingerprint,
} from "../src/lib/agent-key-register.js";

/** The lock namespace for one agent's registration. */
const LOCK_NAMESPACE = "flair-agent-key-register";
/** Attempts and spacing of the per-agent lock, mirroring the pairing claim. */
const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

const jsonRefusal = (status: number, error: string, message: string, outcome?: "conflict" | "unconfirmed"): Response =>
  new Response(JSON.stringify({ error, message, ...(outcome ? { outcome } : {}) }), { status, headers: { "content-type": "application/json" } });

/** Read a header off either header-object shape Harper hands us. */
function readHeader(reqLike: any, name: string): string {
  return reqLike?.headers?.get?.(name) ?? reqLike?.headers?.asObject?.[name] ?? "";
}

/** The Harper username on the request, if any; an audit label only. */
function operatorOf(reqLike: any): string | null {
  const username = reqLike?.user?.username;
  return typeof username === "string" && username.length > 0 ? username : null;
}

/** A stored row from a table read, or null when the read refused / returned no row. */
function asRow(value: any): Record<string, any> | null {
  return value && typeof value === "object" && !(value instanceof Response) ? value : null;
}

export class AgentKeyRegister extends Resource {
  // Permissive so the handler's admin check answers a verified non-admin an
  // explicit 403 and an anonymous caller an explicit 401, rather than Harper's
  // generic denial.
  allowCreate(): boolean {
    return true;
  }

  async post(data: any) {
    const ctx = (this as any).getContext?.() ?? {};
    const req = (ctx as any).request ?? ctx;

    if (!/^(Basic|TPS-Ed25519)(\s|$)/i.test(readHeader(req, "authorization"))) {
      return jsonRefusal(401, "authentication required", "an admin credential is required to register a key");
    }

    const auth = await resolveAgentAuth(ctx);
    if (auth.kind !== "agent" || !auth.isAdmin) {
      return auth.kind === "anonymous"
        ? jsonRefusal(401, "authentication required", "an admin credential is required to register a key")
        : jsonRefusal(403, "forbidden", "an admin credential is required to register a key");
    }
    // The admin agent id (TPS-Ed25519) or the Harper username (Basic).
    const actorId = auth.agentId;

    // Validate the body.
    const body = data && typeof data === "object" ? data : {};
    const agentId = (body as any).agentId;
    const publicKey = (body as any).publicKey;
    if (!isValidAgentId(agentId)) {
      return jsonRefusal(400, REGISTRATION_REQUEST_INVALID, invalidAgentIdMessage(agentId));
    }
    if (!isCanonicalEd25519Base64url(publicKey)) {
      return jsonRefusal(400, REGISTRATION_REQUEST_INVALID, "publicKey must be a canonical base64url encoding of 32 bytes");
    }
    const registered: string = publicKey;

    // Resolve the instance ID before the transaction.
    const selfInstanceId = await localInstanceId();

    const table = (databases as any).flair?.Agent;
    const audit = (databases as any).flair?.AgentKeyRegistration;
    const events = (databases as any).flair?.OrgEvent;
    if (!table || typeof table.get !== "function" || typeof table.update !== "function" || !audit || typeof audit.put !== "function" || !events || typeof events.put !== "function") {
      return jsonRefusal(503, REGISTRATION_UNAVAILABLE, "the Agent, AgentKeyRegistration or OrgEvent store is not available on this instance");
    }

    const fingerprint = await keyFingerprint(registered);
    const operator = operatorOf(req);

    let outcome;
    try {
      outcome = await withKeyLock(
        table.primaryStore,
        [LOCK_NAMESPACE, agentId],
        () =>
          withOwnedTransaction(ctx, async (c: unknown) => {
            // Fresh read inside the owned transaction.
            const stored = asRow(await table.get(agentId, c));
            if (stored === null) return { kind: "not-found" as const };
            if (isForeignAgentHome(stored, selfInstanceId) || isSyncOriginatedAgentRow(stored)) return { kind: "not-local" as const };
            if (isPrincipalDeactivated(stored)) return { kind: "inactive" as const };
            if (stored.publicKey !== PENDING_PUBLIC_KEY) return { kind: "not-pending" as const };
            const basis = { ...stored };

            // Test-only: inert unless the fault-injection env opt-in is set and
            // armed. Placed after the fresh read and before the staging, inside
            // this owned transaction, so the concurrency test can hold this
            // registration while a second one runs or a competing write commits.
            // The name is a DIRECT string literal at the call site (flair#2382's
            // checker resolves only literals or `spec.point`); it must stay equal
            // to AGENT_KEY_REGISTER_PAUSE_POINT, which the test arms.
            const pause = txnPausePoint("agent-key-register");
            if (pause) await pause;

            const registrationId = randomUUID();
            const now = new Date().toISOString();
            // Stage the key and updatedAt (incremental update: unrelated fields
            // and the stored originator stand).
            await table.update(agentId, { publicKey: registered, updatedAt: now }, c);
            // Stage the private audit row and the OrgEvent in the SAME
            // transaction: all three commit together or none does.
            await audit.put({
              id: registrationId,
              actorId,
              operator,
              agentId,
              instanceId: selfInstanceId,
              keyFingerprint: fingerprint,
              createdAt: now,
            }, c);
            await events.put({
              id: `${actorId}-${now}-${registrationId}`,
              authorId: actorId,
              kind: AGENT_KEY_REGISTERED_EVENT,
              summary: `registered a public key for ${agentId}`,
              detail: `key fingerprint ${fingerprint}`,
              refId: agentId,
              createdAt: now,
              updatedAt: now,
            }, c);
            // Reject a row difference that persists and is visible at the confirmation read.
            // A write that restores the original values is not detected.
            await confirmCommittedRow(table, agentId, (committed) => {
              const row = asRow(committed);
              return row !== null && isDeepStrictEqual({ ...row }, basis);
            });
            // Test-only: inert unless the fault-injection env opt-in is set and
            // armed. Holds the registration after its final pre-commit
            // confirmation and before its owned transaction commits, the window
            // where a newer write can discard this write's effect (flair#2656).
            const commitPause = txnPausePoint("agent-key-register-commit");
            if (commitPause) await commitPause;
            return { kind: "registered" as const, registrationId, updatedAt: now, basis };
          }),
        LOCK_ATTEMPTS,
        LOCK_WAIT_MS,
      );
    } catch (err) {
      if (err instanceof CommittedRowChanged) {
        return jsonRefusal(409, REGISTRATION_CONFLICT, "the agent row changed while the key was being registered; nothing was changed", "conflict");
      }
      // Constant format string + a structured data object (unsafe-formatstring).
      console.error("[agent-key-register] the registration transaction failed; nothing was changed", { agentId, err });
      return jsonRefusal(503, REGISTRATION_UNAVAILABLE, "the registration could not be completed; nothing was changed");
    }

    if (outcome.kind === "busy") {
      return jsonRefusal(409, REGISTRATION_CONFLICT, "another registration of this agent is in progress; retry");
    }
    if (outcome.kind === "unavailable") {
      return jsonRefusal(503, REGISTRATION_UNAVAILABLE, "this instance's Agent store has no per-key lock, so the registration was refused");
    }

    const value = outcome.value;
    if (value.kind === "not-found") {
      return jsonRefusal(404, AGENT_NOT_FOUND, "no such agent");
    }
    if (value.kind === "not-local") {
      return jsonRefusal(403, AGENT_NOT_LOCAL, "the agent did not originate on this instance, so this instance is not its authority");
    }
    if (value.kind === "inactive") {
      return jsonRefusal(403, AGENT_INACTIVE, "the agent is deactivated");
    }
    if (value.kind === "not-pending") {
      return jsonRefusal(409, AGENT_KEY_NOT_PENDING, "the stored public key is not exactly pending; use the key-rotation path to replace an existing key");
    }

    // value.kind === "registered": read the committed key back and report the
    // result ONLY when it is equal to the key that was registered.

    // Test-only: inert unless the fault-injection env opt-in is set and armed.
    // Placed after the commit and before the read-back, so a test can commit a
    // competing key change in between and assert the read-back refusal. A DIRECT
    // string literal (flair#2382); it must stay equal to
    // AGENT_KEY_REGISTER_READ_BACK_PAUSE_POINT, which the test arms.
    const readBackPause = txnPausePoint("agent-key-register-read-back");
    if (readBackPause) await readBackPause;

    // The registration is NON-IDEMPOTENT: it transitions a pending key once and
    // writes a fresh audit row per attempt, so a retry cannot re-plan from the
    // fresh read and must not run after a post-commit mismatch. Its commit is
    // confirmed by commit-specific evidence — the AgentKeyRegistration row this
    // attempt wrote under `registrationId` — together with the staged Agent
    // fields; value equality alone does not name the attempt that committed.
    const readBackVerdict = await verifyCommittedFields(table, agentId, value.basis, { publicKey: registered, updatedAt: value.updatedAt });
    let registrationRow: any;
    let registrationReadable = true;
    try {
      registrationRow = await audit.get(value.registrationId, {});
    } catch {
      registrationReadable = false;
    }
    if (readBackVerdict === "unreadable" || !registrationReadable) {
      return jsonRefusal(503, REGISTRATION_UNAVAILABLE, "the committed key and its registration audit row could not be read back; the stored state is unconfirmed", "unconfirmed");
    }
    if (readBackVerdict !== "shown" || registrationRow == null || registrationRow.agentId !== agentId) {
      return jsonRefusal(503, REGISTRATION_UNAVAILABLE, "the committed key could not be read back as this registration's row and audit; the stored state is unconfirmed", "unconfirmed");
    }
    return new Response(
      JSON.stringify({ agentId, publicKey: registered, updatedAt: value.updatedAt, registrationId: value.registrationId }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
}
