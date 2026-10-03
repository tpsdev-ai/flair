/**
 * InstructionVersion.ts — the read-only REST resource for instruction-version
 * history (flair#2139 slice 1). See resources/instruction-version-record.ts for
 * the append helper and the frozen shape (schemas/memory.graphql).
 *
 * Writes: every mutation verb — post, put, patch and delete — returns 403 for
 * EVERY principal, including the super_user operator, and the inherited
 * Table allow* hooks (allowCreate/allowUpdate/allowDelete) are overridden to
 * reject before any verb runs. The only application writer is the in-process
 * `recordVersion` helper. The Harper operations API (raw upsert/delete under
 * admin auth) is an explicit deferred exception: it is not audited by this
 * table (docs/api-reference.md).
 *
 * Reads: default-deny by subjectType. `allowRead` admits any verified agent
 * (Soul's rule — anonymous denied), and this resource returns only rows whose
 * subjectType slice 1 authorizes (`soul`). A row of any other type — the
 * `skill` rows a later slice will write, or an unrecognized type — is denied
 * on both the by-id and the collection read, so a later skill slice cannot
 * become org-readable through Soul's rule.
 *
 * Soul REST writes do not expose the helper's expected-head guard.
 */
import { databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { makeScopedSearch, makeAuthGate, NOT_FOUND, UNAUTH, type RecordTypeReadScope } from "./record-type-kit.js";
import { subjectTypeReadable } from "./instruction-version-record.js";

const MUTATION_DENIED = (): Response =>
  new Response(
    JSON.stringify({
      error: "instruction_version_immutable",
      message: "InstructionVersion is append-only within the application; REST writes are refused",
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );

// See makeAuthGate's doc (record-type-kit.ts): must be a genuine prototype
// method, never a class-field assignment — Harper's relationship-traversal
// RBAC path reads allowRead off the prototype.
const readGate = makeAuthGate();

// The whole table is scoped to the subject types slice 1 authorizes. The
// scope condition is forced as the OUTERMOST `and` (makeScopedSearch), so a
// caller-supplied operator or subjectType filter cannot widen past it.
const authorizedScope: () => Promise<RecordTypeReadScope> = async () => ({
  condition: { attribute: "subjectType", comparator: "equals", value: "soul" },
  isAllowed: (row) => subjectTypeReadable((row as { subjectType?: unknown } | null | undefined)?.subjectType),
});
const scopedSearch = makeScopedSearch(authorizedScope);

export class InstructionVersion extends (databases as any).flair.InstructionVersion {
  allowRead() { return readGate.call(this); }
  allowCreate() { return false; }
  allowUpdate() { return false; }
  allowDelete() { return false; }

  async post() { return MUTATION_DENIED(); }
  async put() { return MUTATION_DENIED(); }
  async patch() { return MUTATION_DENIED(); }
  async delete() { return MUTATION_DENIED(); }

  async get(target?: any) {
    if (!target || (typeof target === "object" && target.isCollection)) return this.search(target);
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") return NOT_FOUND();
    const row = await super.get(target);
    if (!row || row instanceof Response) return NOT_FOUND();
    return subjectTypeReadable((row as any).subjectType) ? row : NOT_FOUND();
  }

  async search(query?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") return UNAUTH();
    return scopedSearch("", query, (q: any) => super.search(q));
  }
}
