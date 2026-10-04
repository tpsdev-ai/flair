/**
 * skill-write-policy.ts — the shared skill-write CREDENTIAL classification
 * (flair#2139 S2, implementing the flair#1741 fix).
 *
 * A skill is a Memory tagged "skill". Writes are the create/update/delete of
 * that row and the FeedMemories ingest. Before this module, an admin agent key
 * (a TPS-Ed25519 signature whose principal is in the admin set) was treated as
 * an OPERATOR by record-type-kit.ts's stampAttribution and by Memory's
 * supersede/delete guards — it could rewrite or delete ANY agent's skill
 * (#1741). The adopted rule (soul-write-policy.ts's precedent) is: **role is
 * not source**. An admin agent key or a delegated OAuth identity is still a
 * RUNTIME credential. Only a verified Basic administrator enters the operator
 * path, and only a deliberate internal call enters the internal path.
 *
 * Classification:
 *   - operator: an authenticated Basic administrator.
 *   - agent:    any other verified runtime identity — Ed25519 or OAuth —
 *               whether or not `isAdmin` is set. It retains own-skill writes
 *               and the explicit write-grant supersede allowance.
 *   - internal: a deliberate in-process call (`__flairInternal`, no request).
 *   - null:     anything else (anonymous — the caller is refused).
 *
 * The class is read from the raw Authorization header and the auth verdict,
 * never from a body field or connector label. No Harper imports.
 */
import { resolveAgentAuth, type AgentAuthVerdict } from "./agent-auth.js";
import { FORBIDDEN, UNAUTH } from "./record-type-kit.js";

export type SkillWriteSource = "operator" | "agent" | "internal";

/**
 * The credential class of a skill write, or null when the caller may not write.
 * `context` is the resource context (getContext()), carrying `request` (or the
 * request itself) and — for the internal path — the deliberate marker.
 */
export function skillWriteSource(context: any, auth: AgentAuthVerdict): SkillWriteSource | null {
  const request = context?.request ?? context;
  // A deliberate internal call: no HTTP request at all and the marker set.
  if (auth.kind === "internal" && context?.__flairInternal === true && !request?.headers) return "internal";
  const header =
    request?.headers?.get?.("authorization") ?? request?.headers?.asObject?.authorization ?? "";
  // Role is not source: only verified Basic admin auth is the operator class.
  if (auth.kind === "agent" && auth.isAdmin && /^Basic\s/i.test(header)) return "operator";
  // Every other verified runtime identity is an agent, admin-or-not.
  if (auth.kind === "agent") return "agent";
  return null;
}

/** Resolve the auth verdict and the credential class together. */
export async function classifySkillWrite(context: any): Promise<{ auth: AgentAuthVerdict; source: SkillWriteSource | null }> {
  const auth = await resolveAgentAuth(context);
  return { auth, source: skillWriteSource(context, auth) };
}

/**
 * Authorize a skill version write. Returns the resolved verdict, the source
 * class, and a denial Response when the caller may not write at all (anonymous
 * → 401; an unrecognized principal → 403). This is the skill analog of
 * soul-write-policy.ts's authorizeSoulWrite, used by the InstructionVersion
 * append helper's subject-type dispatch.
 */
export async function authorizeSkillVersionWrite(context: any): Promise<{
  auth: AgentAuthVerdict;
  source: SkillWriteSource | null;
  denied: Response | null;
}> {
  const { auth, source } = await classifySkillWrite(context);
  const denied = auth.kind === "anonymous"
    ? UNAUTH()
    : source
      ? null
      : FORBIDDEN("skill_write_requires_verified_identity");
  return { auth, source, denied };
}
