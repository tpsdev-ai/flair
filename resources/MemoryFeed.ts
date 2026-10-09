import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Resource, databases } from "harper";
import { allowVerified, resolveAgentAuth } from "./agent-auth.js";
import { computeContentHash, findExistingMemoryByContentHash } from "./memory-feed-lib.js";
import { FORBIDDEN, UNAUTH, stampAttribution } from "./record-type-kit.js";
import { guardAuthorityFields, stripAuthorityFields } from "./authority-field-guard.js";
import { assertValidVisibility, assertVisibilityAllowedForDurability, PRIVATE_VISIBILITY, SHARED_VISIBILITY } from "./memory-visibility.js";
import { assertValidDurability, stampEphemeralExpiry } from "./memory-durability.js";
import { enforceSkillDurability, isSkillWrite, refuseSkillWriteSource, skillScanGate } from "./skill-write.js";
import { buildSkillSuccessorRow, closedSkillPayloadReadable, defaultSkillHooks, resolveSkillHead, runSkillVersionWrite, skillVersionVisibility, prepareSkillBody, validateSkillSnapshots, authorizeSkillOwners, skillWriteConflict } from "./skill-version-write.js";
import { deriveSkillSubjectId } from "./skill-subject.js";
import { noteMemoryUpsert, noteMemoryDelete } from "./bm25-index-service.js";
import { extractPointerInputs } from "./memory-host-source.js";
import { deletePointerRowViaTable } from "./host-pointer-adapter.js";
import { stripUndeclaredMemoryAttributes, stripServerStampedFields } from "./memory-declared-attributes.js";
import { buildProvenance } from "./provenance.js";
import { applyFederationBookkeeping, applyOriginatorInstanceId, resolveStoredRow } from "./originator-instance.js";
import { resolveReadScope } from "./memory-read-scope.js";
import { reservedSeedFeedWriteDenial, reservedSeedSubjectDenial, writeTargetIds } from "./seed-reservation.js";
import { refuseContentSuffixId } from "./memory-id-guard.js";
import { writeBackCommittedRow } from "./write-back.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { stripInlinePointerFields } from "./host-source-visibility.js";

export class FeedMemories extends Resource {
  // Self-authorize via the Ed25519 agent verify (the auth reshape removes the
  // gate's admin elevation).
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(content: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);

    // Anonymous HTTP must NOT write.
    if (auth.kind === "anonymous") {
      return UNAUTH();
    }

    const seedDenial = reservedSeedFeedWriteDenial("Memory", [...writeTargetIds(this, content), content?.supersedes]);
    if (seedDenial) return seedDenial;
    const contentSuffixDenial = refuseContentSuffixId(writeTargetIds(this, content));
    if (contentSuffixDenial) return contentSuffixDenial;

    // No-forge attribution: use the kit's stampAttribution to stamp agentId
    // from the authenticated principal, never from the body.
    //
    // Mode choice: stamp-strict (reject 403 on mismatch) over stamp-default
    // (silent overwrite). This endpoint is the ingestion path — callers are MCP
    // clients and agent-side tool calls. The defect this fix addresses was
    // trusting a body-supplied identity; the correction is to always stamp from
    // the authenticated principal.
    //
    // Deciding point (adjudicated on PR #1071): a silent overwrite means a
    // buggy client never learns it is buggy — it keeps sending the wrong
    // agentId and keeps getting 200. A strict rejection surfaces the mismatch
    // so the caller can fix it. The concern about breaking callers that
    // harmlessly echo agentId back was checked: a full search of the repo and
    // workspace for FeedMemories and /FeedMemories returns only the resource
    // definition and its own tests — no SDK wrappers, no CLI commands, no
    // internal callers construct requests with a body-supplied agentId. A
    // caller echoing the correct agentId (matching the principal) passes
    // through stamp-strict unchanged; a caller echoing a wrong one is exactly
    // the bug this slice exists to prevent.
    const attr = stampAttribution(auth, content, 'agentId', 'stamp-strict', 'forbidden: cannot attribute a feed memory to another agent');
    if (attr.denied) return attr.denied;

    // Guard against body-supplied id targeting another agent's record.
    const resolvedExisting = await resolveStoredRow(this, "Memory", content, () => null);
    if (resolvedExisting.denial) return resolvedExisting.denial;
    const existingRecord = resolvedExisting.row;
    const urlTargetId = (this as any).getId?.();
    if (content && typeof content === "object" && content.id == null &&
      (typeof urlTargetId === "string" || typeof urlTargetId === "number")) {
      content.id = urlTargetId;
    }
    if (content?.id) {
      if (existingRecord && existingRecord.agentId !== content.agentId) {
        return FORBIDDEN("forbidden: cannot write a feed memory owned by another agent");
      }
      // Preserve stored visibility on updates before applying write policy
      // (the same rule as Memory.put; only the two writable values).
      if (
        existingRecord &&
        (content.visibility === undefined || content.visibility === null) &&
        (existingRecord.visibility === PRIVATE_VISIBILITY || existingRecord.visibility === SHARED_VISIBILITY)
      ) {
        content.visibility = existingRecord.visibility;
      }
    }

    const preparedSkill = await prepareSkillBody(content, existingRecord);
    if (preparedSkill instanceof Response) return preparedSkill;
    content = preparedSkill.content;
    const agentId = content.agentId;
    const body = String(content?.content ?? "");
    if (!agentId || !body) {
      return new Response(JSON.stringify({ error: "agentId and content are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── flair#1542: skill-tagged writes are gated (SkillScan + forced durability) ──
    // This endpoint writes via the RAW table object below — NOT Memory.post()/
    // put() — so a caller could spread tags:["skill"] + trigger into the raw
    // put and land an unscanned, 30-day-reapable (durability=standard) skill.
    // Run the SAME gate Memory.post() runs, BEFORE the durability default is
    // computed so a forced "persistent" flows into the tier rule below.
    {
      const skillScanDenial = skillScanGate(content);
      if (skillScanDenial) return skillScanDenial;
      const skillSourceDenial = refuseSkillWriteSource(content);
      if (skillSourceDenial) return skillSourceDenial;
      const skillDurabilityDenial = enforceSkillDurability(content);
      if (skillDurabilityDenial) return skillDurabilityDenial;
    }

    // ── Write-side durability/visibility validation (#1009/#1238/#1257) ─────
    // This endpoint writes via the RAW table object below — NOT the exported
    // Memory resource — so it inherits NONE of Memory.post()/put()'s write
    // guards (Sherlock's #1261 review: ephemeral+shared, and any invalid
    // visibility or durability, landed through POST /FeedMemories untouched).
    // The three guards are applied here in the same order as Memory.post().
    //
    // Placed BEFORE the content-hash dedup early-return, deliberately: a
    // refused combination must refuse deterministically, not return 200 with
    // the existing record whenever a duplicate happens to exist.
    //
    // The effective durability for the tier rule is the one the record below
    // actually stamps — `content.durability ?? "standard"`. A raw table put
    // REPLACES the row, so even an update-in-place that omits durability
    // produces a "standard" row regardless of what it replaces; the stored
    // row's tier is decided entirely by this payload.
    const durability = content.durability ?? "standard";
    {
      const durabilityError = assertValidDurability(content.durability);
      if (durabilityError) {
        return new Response(JSON.stringify({ error: "invalid_durability", message: durabilityError }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const visibilityError = assertValidVisibility(content.visibility);
      if (visibilityError) {
        return new Response(JSON.stringify({ error: "invalid_visibility", message: visibilityError }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const tierError = assertVisibilityAllowedForDurability(durability, content.visibility);
      if (tierError) {
        return new Response(JSON.stringify({ error: "invalid_visibility_for_durability", message: tierError }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ── Authority-field guard (#1524 leftover) ────────────────────────────
    // Same raw-table bypass as the durability/visibility block above:
    // guardAuthorityFields sits on Memory.put/patch/post, not the raw
    // handle. A verified agent could POST {promotionStatus:"approved"}
    // here and land a forged verdict. Refuse a body that sets or changes
    // a stamp, then unconditionally strip before the raw put so even
    // stamps the guard would restore onto an omitted-field update cannot
    // ride a feed write (feed ingest is not a promotion-stamp path).
    {
      const authorityDenial = await guardAuthorityFields(
        () => content?.id ? (databases as any).flair.Memory.get(content.id) : undefined,
        content,
        "Memory",
      );
      if (authorityDenial) return authorityDenial;
    }

    if (isSkillWrite(content)) {
      const now = new Date().toISOString();
      const addressed = existingRecord;
      const predecessor = preparedSkill.predecessor;
      const successorId = addressed
        ? `${agentId}-${randomUUID()}`
        : String(content.id ?? `${agentId}-${Date.now()}-${randomUUID()}`);
      const subjectId = deriveSkillSubjectId({ newPhysicalId: successorId, storedHead: addressed, predecessor });
      const seedLineageDenial = reservedSeedSubjectDenial("Memory", [subjectId], ctx, auth);
      if (seedLineageDenial) return seedLineageDenial;
      const addressedId = addressed ? String(addressed.id) : predecessor ? String(predecessor.id) : null;
      const captured: { row: Record<string, any> | null; closed: Record<string, any> | null } = { row: null, closed: null };
      const outcome = await runSkillVersionWrite({
        ctx,
        subjectId,
        agentId,
        head: (shared) => resolveSkillHead(subjectId, addressedId, shared),
        plan: async (head, shared) => {
          const stale = await validateSkillSnapshots(addressed, predecessor, content.id ?? null, shared);
          if (stale) return stale;
          const denied = await authorizeSkillOwners(ctx, auth, [addressed, predecessor, head ?? content], shared);
          if (denied) return denied;
          if ((addressed || predecessor) && !head) return skillWriteConflict("skill_head_missing");
          if (predecessor && (!addressed || content.supersedes !== addressed.supersedes) && head?.id !== predecessor.id) return skillWriteConflict("skill_predecessor_stale");
          if (addressed && head?.id !== addressed.id) return skillWriteConflict("skill_target_stale");
          const successor = buildSkillSuccessorRow({
            base: { ...content, agentId: head?.agentId ?? agentId }, predecessorRow: head, successorId, subjectId,
            supersedes: head ? String(head.id) : null, now,
          });
          successor.provenance = buildProvenance(auth, successor.createdAt, content);
          stripAuthorityFields(successor, "Memory");
          await applyOriginatorInstanceId(successor, head);
          applyFederationBookkeeping(successor, head);
          captured.row = successor;
          captured.closed = head;
          const value = typeof successor.content === "string" ? successor.content : null;
          const visibility = skillVersionVisibility(successor);
          if (!head) return { kind: "create", predecessor: null, successor, closePatch: {}, value, visibility };
          return { kind: "update", predecessor: head, successor, closePatch: { skillSubjectId: subjectId, validTo: now, updatedAt: now }, value, visibility };
        },
        hooks: {
          ...defaultSkillHooks,
          pointer: async (shared) => {
            if (captured.closed) await deletePointerRowViaTable(String(captured.closed.id), shared);
            return null;
          },
        },
      });
      if (!outcome.ok) return outcome.response;
      const written = captured.row;
      if (captured.closed) noteMemoryDelete(String(captured.closed.id));
      if (written) noteMemoryUpsert(written);
      return written ?? { id: successorId, written: true, durability: "persistent" };
    }

    const now = new Date().toISOString();
    const contentHash = computeContentHash(agentId, body);

    const existing = await findExistingMemoryByContentHash((databases as any).flair.Memory.search(), agentId, contentHash);
    if (existing) {
      if (existing.durability === "ephemeral" && existing.expiresAt == null) {
        return repairDeduplicatedExpiry(ctx, existing);
      }
      return existing;
    }

    const record = {
      ...content,
      id: content.id ?? `${agentId}-${Date.now()}-${randomUUID()}`,
      agentId,
      content: body,
      contentHash,
      durability,
      createdAt: content.createdAt ?? now,
      updatedAt: content.updatedAt ?? now,
      archived: content.archived ?? false,
    };

    // flair#1257, omission leak: this endpoint stamps NO durability-keyed
    // visibility default (unlike Memory.post/put — Layer 1), so an ephemeral
    // feed write with visibility omitted would land with no visibility field
    // at all, which the read side resolves to NON-private (the migration
    // invariant). The refusal guard above cannot see an omission, so the
    // private-only tier invariant is closed here by stamping "private" on
    // exactly the ephemeral case. Deliberately NOT the general durability-
    // keyed default: stamping it for standard/persistent/permanent would flip
    // the visibility of every existing feed caller's writes — a behavioural
    // change this fix must not smuggle in.
    if (record.durability === "ephemeral" && (record.visibility === undefined || record.visibility === null)) {
      record.visibility = PRIVATE_VISIBILITY;
    }

    // flair#1940 A1' item 1: the feed ingest is a Memory writer too. Drop any
    // pointer inputs (hostSource/hostSourceScope/hostSourceVisibility) and every
    // undeclared attribute here. These paths discard the supplied pointer input
    // and create no pointer row; an existing pointer row stays bound to the
    // updated Memory.
    extractPointerInputs(record);
    stripUndeclaredMemoryAttributes(record);
    stripAuthorityFields(record, "Memory");
    // A1-iv items 1/3: the feed ingest is a Memory writer too — strip a
    // caller-supplied server-stamped field (instanceToken, provenance), then
    // PRESERVE the existing row's incarnation token, else generate one.
    stripServerStampedFields(record);
    let refusal: Response | undefined;
    const outcome = await writeBackCommittedRow(
      (databases as any).flair.Memory,
      record.id,
      async (priorById: any) => {
        if (priorById && priorById.agentId !== agentId) {
          refusal = FORBIDDEN("forbidden: cannot write a feed memory owned by another agent");
          return { skip: true };
        }
        const written: Record<string, any> = { ...record };
        written.instanceToken = priorById?.instanceToken ?? randomUUID();
        // Feed ingest is a full-row write: it REPLACES the stored row, so a
        // re-ingest with new content is a semantic re-authoring. Re-stamp
        // provenance from the resolved (trusted) identity and ONE server clock
        // read (inside buildProvenance) rather than carrying the stored blob
        // forward — a legacy row whose `verified.timestamp` came from a client
        // `createdAt` must not keep presenting that value after a new write
        // (flair#1960 r2). The feed body's own `createdAt` is recorded only as
        // the CLAIM `provenance.claimed.createdAt`, never as a verified
        // timestamp. The incarnation token is still preserved above (a
        // re-ingest is not a reincarnation), so only `provenance` is
        // re-derived.
        written.provenance = buildProvenance(auth, written.createdAt, content);
        // flair#1965 r2: this raw table write REPLACES the row, bypassing the
        // Memory resource's write methods, so the create/update rule is
        // applied here explicitly: a CREATE (no stored row) stamps this
        // instance's own id and ignores any body value; an UPDATE keeps the
        // STORED value (a body value neither replaces nor clears it). The
        // receiver-side federation bookkeeping (`_originatorInstanceId` et al.)
        // is likewise unsettable from a body — it stands as stored, or is
        // dropped on a create. See resources/originator-instance.ts.
        await applyOriginatorInstanceId(written, priorById);
        applyFederationBookkeeping(written, priorById);
        const expiryError = stampEphemeralExpiry(written, priorById);
        if (expiryError) {
          refusal = Response.json({ error: "invalid_expiry", message: expiryError }, { status: 400 });
          return { skip: true };
        }
        return { write: written };
      },
      { ctx, label: "MemoryFeed.ingest", pausePre: "feed-ingest-pre", pausePoint: "feed-ingest", expectedRow: existingRecord },
    );
    if (refusal) return refusal;
    if ("skip" in outcome) return feedDedupTargetChanged(record.id);
    const written = outcome.write;
    // flair#1357 — raw-table write: hook it explicitly (see bm25-index-service).
    noteMemoryUpsert(written);
    return written;
  }

  // Subscription admission: verified agents, admins and trusted internal
  // calls; anonymous HTTP is refused (the same gate as FeedSouls). Admission is
  // decided here, by the caller's resolved identity, not by which Harper user
  // the request carries. What a subscriber then RECEIVES is decided per record
  // in connect() below.
  async allowRead(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  /**
   * A non-admin subscriber receives a Memory event only when
   * `resolveReadScope(agentId).isAllowed(record)` allows the record the event
   * is decided from: the predicate Memory.get()/search() use (the reader's own
   * records at any visibility, plus every other agent's non-private records).
   * Admin agents and trusted internal calls are unfiltered, as before. The
   * request for a scoped subscription is built here from an allowlist of the
   * caller's options (see SUBSCRIPTION_OPTIONS: the record id, descendants,
   * and replay), and the server's `rowFilter` is set last; no caller-supplied
   * filter, `rawEvents`, `select` or unknown option reaches it.
   *
   * Two layers decide what a non-admin subscriber receives:
   *
   * 1. Harper's synchronous `SubscriptionRequest.rowFilter`, set to the
   *    predicate. In the pinned Harper (5.2.8) the filter is evaluated on the
   *    full stored row for the rows replayed when the subscription opens, for
   *    every live change (an update is re-read from the primary store and
   *    delivered as a full-row `put`) and for reload re-deliveries; a history
   *    replay (`startTime`, `previousCount`) is evaluated on each earlier
   *    version of the row as it was stored. An event with no stored row (a delete tombstone, a published message,
   *    a raw event) is withheld from a filtered subscriber. This layer holds
   *    only where the host Harper honours `rowFilter`.
   *
   * 2. The loop below (see readableRowEvent()), which does not rely on
   *    `rowFilter`. It delivers only a `put` or `invalidate` event whose value
   *    is an object; every other event is withheld. When that object carries a
   *    string `agentId` and a defined `visibility`, the predicate decides from
   *    those two fields of the event. Otherwise the stored row is re-read by
   *    the event id and the predicate decides from the stored row; the event is
   *    withheld when it has no id, when the re-read throws, or when the re-read
   *    returns anything other than an object with a string `agentId`. When the
   *    subscription asked for `startTime` or `previousCount`, every event also
   *    needs the record's current stored row, re-read by id, to be readable
   *    (see storedRowReadable()).
   */
  async *connect(target: any, incomingMessages: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") {
      // allowRead() refuses anonymous HTTP before connect() runs; this is the
      // in-process backstop.
      throw Object.assign(new Error("authentication required"), { statusCode: 401 });
    }

    if (auth.kind === "internal" || auth.isAdmin) {
      const subscription = await (databases as any).flair.Memory.subscribe(target);

      if (!incomingMessages) {
        return subscription;
      }

      for await (const event of subscription) {
        yield event;
      }
      return;
    }

    const scope = await resolveReadScope(auth.agentId);
    // The caller's subscription request is connect()'s second argument in
    // instance mode and its first when loadAsInstance is false, the same choice
    // Harper's own Resource.connect() makes.
    const callerRequest = (this.constructor as any).loadAsInstance === false ? target : incomingMessages;
    const request = scopedSubscriptionRequest(callerRequest, (record: any) => scope.isAllowed(record));
    const subscription = await (databases as any).flair.Memory.subscribe(request);
    const readStored = (id: any) => (databases as any).flair.Memory.get(id);
    const replaysHistory = request.startTime !== undefined || request.previousCount !== undefined;
    for await (const event of subscription) {
      if (!(await readableRowEvent(event, auth.agentId, scope.isAllowed, readStored))) continue;
      if (replaysHistory && !(await storedRowReadable(event?.id, auth.agentId, scope.isAllowed, readStored))) continue;
      yield event;
    }
  }
}

/**
 * The options a non-admin caller's subscription request may carry into the
 * table subscription, each with the type it must have. These are the options
 * Harper's `Table.subscribe` reads to choose WHICH record ids it follows and
 * WHAT it replays before live events: `id` (one record), `isCollection` and
 * `onlyChildren` (a record's descendants), and `startTime`, `previousCount`
 * and `omitCurrent` (the replay). None of them widens what the read predicate
 * allows. Every other property is dropped, including any filter, `rowFilter`,
 * `eventFilter`, `select`, `rawEvents`, `listener` and any unknown option.
 */
const SUBSCRIPTION_OPTIONS: Readonly<Record<string, (value: unknown) => boolean>> = Object.freeze({
  id: (value: unknown) =>
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((part) => part === null || typeof part === "string" || typeof part === "number")),
  isCollection: (value: unknown) => typeof value === "boolean",
  onlyChildren: (value: unknown) => typeof value === "boolean",
  startTime: (value: unknown) => typeof value === "number" && Number.isFinite(value),
  previousCount: (value: unknown) => typeof value === "number" && Number.isFinite(value),
  omitCurrent: (value: unknown) => typeof value === "boolean",
});

/**
 * Build the scoped subscription request: the allowlisted options the caller
 * supplied with the expected type, then the server-owned `rowFilter`, set last.
 */
function scopedSubscriptionRequest(callerRequest: any, rowFilter: (record: any) => boolean): any {
  const request: any = {};
  if (callerRequest != null && typeof callerRequest === "object") {
    for (const [option, hasExpectedType] of Object.entries(SUBSCRIPTION_OPTIONS)) {
      const value = callerRequest[option];
      if (value !== undefined && hasExpectedType(value)) request[option] = value;
    }
  }
  request.rowFilter = rowFilter;
  return request;
}

/**
 * The scoped memory feed's second layer: may this event reach the reader?
 *
 * - Only a `put` or `invalidate` event whose value is an object is a
 *   candidate; every other event (a delete, a message, a `put` without an
 *   object value) is withheld.
 * - The read predicate reads `agentId` and `visibility`. If the event's value
 *   carries a string `agentId` and a defined `visibility`, the predicate
 *   decides from those two fields.
 * - Otherwise (a partial value, or a row stored without a `visibility` field)
 *   the stored row is re-read by the event id, and the predicate decides from
 *   the stored row. The event is withheld when it has no id, when the re-read
 *   throws, or when the re-read returns anything other than an object with a
 *   string `agentId`.
 *
 * The event itself is what is delivered; the stored row is only the input to
 * the decision.
 */
async function readableRowEvent(
  event: any,
  readerId: string,
  isAllowed: (record: any) => boolean,
  readStored: (id: any) => Promise<any> | any,
): Promise<boolean> {
  if (!event || (event.type !== "put" && event.type !== "invalidate")) return false;
  const row = event.value;
  if (row == null || typeof row !== "object") return false;
  if (typeof row.agentId === "string" && row.visibility !== undefined) {
    if (!isAllowed(row)) return false;
  } else if (!(await storedRowReadable(event.id, readerId, isAllowed, readStored))) {
    return false;
  }
  return closedSkillPayloadReadable(row, readerId);
}

/**
 * Re-read the stored row by id and apply the read predicate to it. An absent
 * id, a read that throws, or a result that is not an object with a string
 * `agentId` returns false.
 *
 * Also used for every event of a subscription that asked for `startTime` or
 * `previousCount`: Harper then replays earlier versions of a record, and each
 * version carries its own `agentId` and `visibility`. Such an event reaches a
 * non-admin subscriber only when the record's current stored row is readable
 * too, so a record that is private or deleted now is not replayed from its
 * earlier versions.
 */
async function storedRowReadable(
  id: any,
  readerId: string,
  isAllowed: (record: any) => boolean,
  readStored: (id: any) => Promise<any> | any,
): Promise<boolean> {
  if (id == null) return false;
  let stored: any;
  try {
    stored = await readStored(id);
  } catch {
    return false;
  }
  if (stored == null || typeof stored !== "object" || typeof stored.agentId !== "string") return false;
  if (!isAllowed(stored)) return false;
  return closedSkillPayloadReadable(stored, readerId);
}

/** The named error for a dedup expiry repair whose matched row changed during the request (flair#2358). */
export const FEED_DEDUP_TARGET_CHANGED_ERROR = "feed_dedup_target_changed";

/** Attempts of the dedup expiry repair before it gives up on a row that keeps changing. */
const FEED_DEDUP_REPAIR_ATTEMPTS = 3;

function feedDedupTargetChanged(id: string): Response {
  return Response.json({
    error: FEED_DEDUP_TARGET_CHANGED_ERROR,
    message: `the stored row ${JSON.stringify(id)} this write matched changed during the request; retry the write`,
  }, { status: 409 });
}

/** The row is still the dedup match: the same id, owner and content hash. */
function isDedupMatch(row: any, match: any): boolean {
  return row != null && typeof row === "object" && String(row.id) === String(match.id) &&
    row.agentId === match.agentId && row.contentHash === match.contentHash;
}

/**
 * flair#2358: stamp the tier expiry (stampEphemeralExpiry) on the ephemeral
 * row the content-hash dedup matched by agentId + contentHash. The match's id
 * is refused first when it is a reserved seed id or ends in `.content`. In a
 * transaction this call owns, the row is re-read; unless its id, agentId and
 * contentHash equal the match's, the request is refused (409
 * FEED_DEDUP_TARGET_CHANGED_ERROR). A matching row that is no longer
 * ephemeral, or already has an expiry, is returned from that read. Otherwise a
 * committed read must equal the transaction's read before the write, else the
 * repair starts over (FEED_DEDUP_REPAIR_ATTEMPTS attempts, then the 409). A
 * change committed after that read and before the commit follows Harper's
 * timestamp order. After the commit, an owned read must show the match with
 * the written expiry (else the 409); that row is returned. Returned rows carry
 * no inline pointer fields (stripInlinePointerFields).
 */
async function repairDeduplicatedExpiry(ctx: unknown, match: any): Promise<any> {
  const id = String(match.id);
  const idDenial = reservedSeedFeedWriteDenial("Memory", [id]) ?? refuseContentSuffixId([id]);
  if (idDenial) return idDenial;
  for (let attempt = 1; attempt <= FEED_DEDUP_REPAIR_ATTEMPTS; attempt++) {
    const outcome: { kind: "changed" } | { kind: "retry" } | { kind: "current"; row: any } | { kind: "written"; row: any } =
      await withOwnedTransaction(ctx, async (c) => {
        const stored = await (databases as any).flair.Memory.get(id, c);
        if (!isDedupMatch(stored, match)) return { kind: "changed" as const };
        if (stored.durability !== "ephemeral" || stored.expiresAt != null) return { kind: "current" as const, row: stored };
        // Test-only: inert unless the fault-injection env opt-in is set and armed.
        const pause = txnPausePoint("feed-dedup-repair");
        if (pause) await pause;
        // The committed row, in an explicit fresh context (not this transaction's snapshot).
        const committed = await (databases as any).flair.Memory.get(id, {});
        if (!isDeepStrictEqual(committed, stored)) return { kind: "retry" as const };
        const row: any = { ...stored };
        // A stored null is "no expiry": drop it so the shared rule stamps a fresh
        // tier TTL rather than refusing the null as malformed.
        delete row.expiresAt;
        const error = stampEphemeralExpiry(row);
        if (error) throw new Error(`flair: deduplicated ephemeral row ${id} could not be repaired (${error})`);
        await (databases as any).flair.Memory.put(row, c);
        return { kind: "written" as const, row };
      });
    if (outcome.kind === "retry") continue;
    if (outcome.kind === "changed") return feedDedupTargetChanged(id);
    if (outcome.kind === "current") return stripInlinePointerFields(outcome.row);
    const confirmed = await withOwnedTransaction(ctx, async (c) => (databases as any).flair.Memory.get(id, c));
    if (!isDedupMatch(confirmed, match) || confirmed.expiresAt !== outcome.row.expiresAt) return feedDedupTargetChanged(id);
    return stripInlinePointerFields(confirmed);
  }
  return feedDedupTargetChanged(id);
}
