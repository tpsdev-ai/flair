/**
 * grant-visibility.ts — the visibility rule for a write a "write" MemoryGrant
 * authorizes.
 *
 * A write grant lets the grantee write a successor of the owner's record (a
 * cross-agent supersede: an ordinary memory through Memory.post()/put(), a
 * skill version through the shared skill-version writer). A write grant does
 * not include changing a record's visibility; visibility is set by the owner or
 * an admin. So, for a grant-authorized successor:
 *
 *   - it carries the predecessor's visibility when the write omits one;
 *   - a write naming a visibility that reads differently from the
 *     predecessor's (private where it is shared, or shared where it is
 *     private) is refused with {@link grantVisibilityRefusal}, a 403 that
 *     carries only its name and a fixed message.
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
 * validateAndAuthorizeSupersedes) applies this to a non-admin agent writing a
 * successor of another agent's record; the skill-version writer
 * (skill-version-write.ts) applies it to every plan whose predecessor close
 * stands on a write grant (`grantedClose`). No Harper imports.
 */
import { isPrivateVisibility, PRIVATE_VISIBILITY, SHARED_VISIBILITY } from "./memory-visibility.js";

/** The named refusal for a grant-authorized write that changes visibility. */
export const GRANT_VISIBILITY_REFUSAL = "grant_cannot_change_visibility";

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

/** The visibility a row is read with: "private" for the literal, else "shared". */
export function readVisibility(visibility: unknown): typeof PRIVATE_VISIBILITY | typeof SHARED_VISIBILITY {
  return isPrivateVisibility(visibility as string | null | undefined) ? PRIVATE_VISIBILITY : SHARED_VISIBILITY;
}

/** Would `next` in place of `prior` change who can read the record? */
export function visibilityChanges(prior: unknown, next: unknown): boolean {
  return readVisibility(prior) !== readVisibility(next);
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
