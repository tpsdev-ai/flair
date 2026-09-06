import { ADK_SCOPE_TAG_PREFIX } from "../src/rem/promote-policy.js";

/** Soul is agentId-scoped and cannot carry a per-user `adk:` tag. Writing an
 *  ADK-sourced claim there leaks that user's distilled text to every other
 *  user of the shared agentId. CLI refusal is not enough — a scripted
 *  PUT /Soul must hit the same door. */
export const ADK_SOUL_REFUSAL = "adk_sourced_claim_cannot_be_written_to_soul";

export interface SoulAdkLookup {
  searchCandidates?: (agentId: string) => AsyncIterable<{ claim?: unknown; scopeTag?: unknown; tags?: unknown }>;
  searchMemories?: (agentId: string) => AsyncIterable<{ content?: unknown; tags?: unknown; scopeTag?: unknown }>;
}

export function tagLooksAdk(tag: unknown): boolean {
  return typeof tag === "string" && tag.toLowerCase().startsWith(ADK_SCOPE_TAG_PREFIX);
}

/** Request body carries an ADK scope tag (promotion leftover or forged). */
export function bodyCarriesAdkScope(content: any): boolean {
  if (tagLooksAdk(content?.scopeTag)) return true;
  const tags = content?.tags;
  return Array.isArray(tags) && tags.some(tagLooksAdk);
}

export function rowLooksAdkSourced(row: { scopeTag?: unknown; tags?: unknown } | null | undefined): boolean {
  if (!row) return false;
  if (tagLooksAdk(row.scopeTag)) return true;
  return Array.isArray(row.tags) && row.tags.some(tagLooksAdk);
}

function adkForbidden(): Response {
  return new Response(JSON.stringify({ error: ADK_SOUL_REFUSAL }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

async function* searchByAgentId(tableName: "MemoryCandidate" | "Memory", agentId: string): AsyncIterable<any> {
  const { databases } = await import("harper");
  const table = (databases as any).flair?.[tableName];
  if (!table?.search) return;
  const query = { conditions: [{ attribute: "agentId", comparator: "equals", value: agentId }] };
  yield* table.search(query);
}

/** Refuse a Soul write whose value is an ADK-sourced claim. Body tags are
 *  sufficient; otherwise match stored MemoryCandidate.claim / Memory.content
 *  that already carries an `adk:` scope tag. */
export async function refuseAdkSourcedSoulWrite(
  content: any,
  lookup: SoulAdkLookup = {},
): Promise<Response | null> {
  if (bodyCarriesAdkScope(content)) return adkForbidden();
  const value = typeof content?.value === "string" ? content.value : "";
  const agentId = typeof content?.agentId === "string" ? content.agentId : "";
  if (!value || !agentId) return null;

  const candidates = lookup.searchCandidates
    ?? ((id: string) => searchByAgentId("MemoryCandidate", id));
  for await (const row of candidates(agentId)) {
    if (row?.claim === value && rowLooksAdkSourced(row)) return adkForbidden();
  }

  const memories = lookup.searchMemories
    ?? ((id: string) => searchByAgentId("Memory", id));
  for await (const row of memories(agentId)) {
    if (row?.content === value && rowLooksAdkSourced(row)) return adkForbidden();
  }
  return null;
}
