/**
 * grant-visibility.ts — the visibility rule for a write a "write" MemoryGrant
 * authorizes.
 *
 * A write grant lets the grantee write a successor of the owner's record (a
 * cross-agent supersede: an ordinary memory through Memory.post()/put(), a
 * skill version through the shared skill-version writer). A write grant does
 * not include changing a record's visibility; visibility is set by the owner or
 * an admin. So, for the grant-authorized successor write:
 *
 *   - the successor carries the predecessor's visibility when the write omits
 *     one;
 *   - a write naming a visibility that reads differently from the
 *     predecessor's (private where it is shared, or shared where it is
 *     private) is refused with {@link grantVisibilityRefusal}, a 403 that
 *     carries only its name and a fixed message, unless an earlier validation
 *     refuses it first: an ordinary, non-skill ephemeral write naming "shared"
 *     gets 400 invalid_visibility_for_durability; an ephemeral
 *     skill write gets the skill-durability gate's 400 skill_durability; and a
 *     "session" skill write gets 400 invalid_durability on Memory POST and PUT
 *     (durability validation runs first) and 400 skill_durability on
 *     FeedMemories;
 *   - after staging the close, the writer re-reads the predecessor's committed
 *     row; if that row's visibility no longer reads the same as the
 *     successor's, the whole write is refused with
 *     {@link predecessorVisibilityChangedRefusal}, a 409: no successor, no
 *     close, no version row. A change committed after that final re-read and
 *     before the write commits is not seen by it; Harper orders the writes by
 *     transaction timestamp.
 *
 * An ordinary successor that omits visibility on a shared predecessor while
 * naming ephemeral durability carries "shared", which the ephemeral
 * private-only rule refuses (400 invalid_visibility_for_durability).
 *
 * The rule governs that one write. A later write follows the ordinary owner
 * rules: an ordinary (non-skill) successor is owned by the grantee, which may
 * later change that row's visibility as its owner; a skill successor keeps its
 * lineage owner.
 *
 * The comparison is the read predicate's: memory-visibility.ts's
 * isPrivateVisibility decides who can read a row, so a row with no stored
 * visibility reads as shared, and naming "shared" for it is not a change.
 *
 * Visibility is the one writable Memory field the read scope depends on besides
 * the owner field (memory-read-scope.ts's resolveReadScope reads `agentId` and
 * `visibility` only). The owner field is already immutable to a non-admin
 * (owner-field-guard.ts), and a skill successor keeps its lineage owner.
 *
 * Who counts as the owner or an admin is unchanged and decided where each path
 * decides the grant: the non-skill supersede (Memory.ts
 * validateAndAuthorizeSupersedes, and stageGrantedClose at the close)
 * applies this to a non-admin agent writing a successor of another agent's
 * record; the skill-version writer (skill-version-write.ts) applies it to every
 * plan whose predecessor close stands on a write grant (`grantedClose`). No
 * Harper imports.
 */
import { isPrivateVisibility, PRIVATE_VISIBILITY, SHARED_VISIBILITY } from "./memory-visibility.js";

/** The named refusal for a grant-authorized write that changes visibility. */
export const GRANT_VISIBILITY_REFUSAL = "grant_cannot_change_visibility";

/** The named refusal for a grant-authorized write whose predecessor's committed
 *  visibility, at the close's final re-read, no longer reads as the successor's. */
export const PREDECESSOR_VISIBILITY_CHANGED = "predecessor_visibility_changed";

/** 403: a write grant does not include changing a record's visibility. */
export function grantVisibilityRefusal(): Response {
  return new Response(
    JSON.stringify({
      error: GRANT_VISIBILITY_REFUSAL,
      message: "a write grant does not include changing a record's visibility; visibility is set by the owner or an admin",
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

/**
 * 409: the predecessor's committed visibility no longer reads the same as the
 * successor's, so nothing was written. A retry that omits visibility carries
 * the predecessor's current visibility; a retry that names the earlier value
 * gets the 403 {@link grantVisibilityRefusal}.
 */
export function predecessorVisibilityChangedRefusal(): Response {
  return new Response(
    JSON.stringify({
      error: PREDECESSOR_VISIBILITY_CHANGED,
      message: "the superseded record's visibility changed during this write; nothing was written. A retry that omits visibility carries its current visibility",
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

/**
 * Aborts a grant-authorized non-skill close (Memory.ts stageGrantedClose): the
 * predecessor's committed visibility reads differently from the successor's.
 * Memory.post()/put() abort the transaction the successor and the close are
 * staged in and answer {@link predecessorVisibilityChangedRefusal}.
 */
export class PredecessorVisibilityChanged extends Error {
  constructor() {
    super(`${PREDECESSOR_VISIBILITY_CHANGED}: the superseded record's visibility changed during the write`);
    this.name = "PredecessorVisibilityChanged";
  }
}

/** The visibility a row is read with: "private" for the literal, else "shared". */
export function readVisibility(visibility: unknown): typeof PRIVATE_VISIBILITY | typeof SHARED_VISIBILITY {
  return isPrivateVisibility(visibility as string | null | undefined) ? PRIVATE_VISIBILITY : SHARED_VISIBILITY;
}

/** Would `next` in place of `prior` change who can read the record? */
export function visibilityChanges(prior: unknown, next: unknown): boolean {
  return readVisibility(prior) !== readVisibility(next);
}

/**
 * The close's check for a grant-authorized successor: does the predecessor's
 * committed row (read with an empty context once the close's write is staged)
 * read with a different visibility from the successor's? The ordinary close
 * handles a missing row separately.
 */
export function committedVisibilityDiffers(committed: Record<string, any> | null | undefined, successorVisibility: unknown): boolean {
  return !!committed && visibilityChanges(committed.visibility, successorVisibility);
}

/**
 * Apply the rule to a grant-authorized successor body before it is written.
 * `requested` is the visibility the caller's body named (undefined or null when
 * it named none); `predecessor` is the owner's row the grant authorized
 * superseding. Returns the refusal, or null after setting `content.visibility`
 * to the predecessor's.
 */
export function applyGrantedVisibility(
  content: Record<string, any>,
  predecessor: Record<string, any>,
  requested: unknown,
): Response | null {
  if (requested !== undefined && requested !== null && visibilityChanges(predecessor?.visibility, requested)) {
    return grantVisibilityRefusal();
  }
  content.visibility = readVisibility(predecessor?.visibility);
  return null;
}

/**
 * The skill-version writer's check: a plan whose predecessor close stands on a
 * write grant may not carry a successor that reads differently from that
 * predecessor. Returns the refusal, or null.
 */
export function grantedSuccessorVisibilityDenial(plan: {
  kind: string;
  predecessor?: Record<string, any> | null;
  successor?: Record<string, any> | null;
  grantedClose?: unknown;
}): Response | null {
  if (plan.kind === "delete" || !plan.grantedClose || !plan.predecessor || !plan.successor) return null;
  return visibilityChanges(plan.predecessor.visibility, plan.successor.visibility) ? grantVisibilityRefusal() : null;
}
