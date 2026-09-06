import { resolveAgentAuth, type AgentAuthVerdict } from "./agent-auth.js";
import { FORBIDDEN, UNAUTH } from "./record-type-kit.js";
import { buildProvenance } from "./provenance.js";
import { databases } from "harper";
import { bodyCarriesAdkScope } from "./soul-adk-guard.js";

export type SoulWriteSource = "operator" | "internal";

// Role is not source: an admin agent key or delegated OAuth identity is still
// a runtime credential. Only verified Basic admin auth enters the operator path.
export function soulWriteSource(context: any, auth: AgentAuthVerdict): SoulWriteSource | null {
  const request = context?.request ?? context;
  if (auth.kind === "internal" && context?.__flairInternal === true && !request?.headers) return "internal";
  const header = request?.headers?.get?.("authorization") ?? request?.headers?.asObject?.authorization ?? "";
  if (auth.kind === "agent" && auth.isAdmin && /^Basic\s/i.test(header)) return "operator";
  return null;
}

export async function authorizeSoulWrite(context: any) {
  const auth = await resolveAgentAuth(context);
  const source = soulWriteSource(context, auth);
  const denied = auth.kind === "anonymous" ? UNAUTH()
    : source ? null : FORBIDDEN("soul_write_requires_operator: use authenticated operator credentials");
  return { auth, source, denied };
}

export function soulProvenance(auth: AgentAuthVerdict, source: SoulWriteSource, now: string): string {
  const provenance = JSON.parse(buildProvenance(auth, now, {}));
  provenance.verified.sourceClass = source;
  return JSON.stringify(provenance);
}

export async function refuseLearnedSoulWrite(content: any): Promise<Response | null> {
  // Retain the legacy tag bridge for operator submissions while runtime writes
  // are denied independently of connector names. Stored artifacts need no tag.
  if (bodyCarriesAdkScope(content)) return FORBIDDEN("soul_value_is_learned_content");
  if (typeof content?.value !== "string" || !content.value) return null;
  if (typeof content.agentId !== "string" || !content.agentId) return FORBIDDEN("soul_owner_required");
  for (const [name, field] of [["MemoryCandidate", "claim"], ["Memory", "content"]]) {
    const table = (databases as any).flair[name];
    // Missing tables or failed reads throw before any write, rather than
    // treating unavailable provenance as proof of operator-authored content.
    for await (const row of table.search({
      conditions: [
        { attribute: "agentId", comparator: "equals", value: content.agentId },
        { attribute: field, comparator: "equals", value: content.value },
      ],
      select: ["agentId", field],
      limit: 1,
    })) {
      if (row.agentId === content.agentId && row[field] === content.value) return FORBIDDEN("soul_value_is_learned_content");
    }
  }
  return null;
}
