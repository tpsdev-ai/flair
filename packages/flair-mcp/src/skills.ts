/**
 * skills.ts — stdio-adapter shaping for skill_* tools (flair#1575).
 *
 * Native `/mcp` implements skill_store / skill_search / skill_get as thin
 * wrappers over Memory / SemanticSearch (resources/mcp-tools.ts). This
 * package talks HTTP via FlairClient, so the wrappers here only shape
 * the request body and the client-visible result — they re-implement no
 * write, recall, or scoping logic. Server-side SkillScan, forced
 * durability=persistent, and resolveReadScope still run on the daemon.
 *
 * Progressive disclosure matches the native contract: skill_search returns
 * catalog cards (never `content` / embedding); skill_get is the disclosure
 * step for the full procedure. skill_get always strips embedding /
 * embeddingModel (flair#1579) — there is no includeEmbedding opt-in.
 */

/** The tag that marks a Memory as a skill (resources/skill-write.ts). */
export const SKILL_TAG = "skill";

const INTERNAL_MEMORY_FIELDS = ["embedding", "embeddingModel"] as const;

export function isSkillRecord(record: unknown): boolean {
  const tags = (record as { tags?: unknown } | null)?.tags;
  return Array.isArray(tags) && tags.includes(SKILL_TAG);
}

/**
 * Lightweight skill CATALOG card — id/name/trigger/description/tags/agentId.
 * `name`/`description` live in the opaque metadata JSON blob; a corrupt or
 * absent blob simply yields no name/desc. `content` and the raw embedding
 * are deliberately absent (skill_search progressive-disclosure contract).
 */
export function projectSkillCard(r: unknown): Record<string, unknown> {
  const row = (r ?? {}) as Record<string, unknown>;
  let name: string | undefined;
  let description: string | undefined;
  if (typeof row.metadata === "string" && row.metadata.length > 0) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta && typeof meta === "object") {
        if (typeof meta.name === "string") name = meta.name;
        if (typeof meta.description === "string") description = meta.description;
      }
    } catch {
      /* opaque/corrupt metadata → no name/description on the card */
    }
  }
  return {
    id: row.id,
    name,
    trigger: row.trigger,
    description,
    tags: row.tags,
    agentId: row.agentId,
  };
}

export function stripInternalMemoryFields<T extends Record<string, unknown>>(value: T): T {
  const out = { ...value };
  for (const field of INTERNAL_MEMORY_FIELDS) delete out[field];
  return out;
}

/** Body for PUT /Memory/:id — matches native skill_store's Memory.post() shape. */
export function buildSkillStoreBody(opts: {
  agentId: string;
  content: string;
  trigger?: string;
  name?: string;
  description?: string;
  tags?: string[];
  claimedClient?: string;
}): { id: string; body: Record<string, unknown> } {
  const id = `${opts.agentId}-${crypto.randomUUID()}`;
  const body: Record<string, unknown> = {
    id,
    agentId: opts.agentId,
    content: opts.content,
    tags: [SKILL_TAG, ...(Array.isArray(opts.tags) ? opts.tags : [])],
  };
  // durability is NOT set — the server forces persistent for skill-tagged
  // writes and rejects an explicit ephemeral/session.
  if (typeof opts.trigger === "string" && opts.trigger.length > 0) body.trigger = opts.trigger;
  if (opts.claimedClient) body.claimedClient = opts.claimedClient;
  const meta: Record<string, unknown> = {};
  if (typeof opts.name === "string" && opts.name.length > 0) meta.name = opts.name;
  if (typeof opts.description === "string" && opts.description.length > 0) meta.description = opts.description;
  if (Object.keys(meta).length > 0) body.metadata = JSON.stringify(meta);
  return { id, body };
}

/** SemanticSearch body for skill_search — no agentId (scope is the signed identity). */
export function buildSkillSearchBody(opts: { task: string; limit?: number }): Record<string, unknown> {
  return {
    q: opts.task,
    tag: SKILL_TAG,
    limit: opts.limit ?? 5,
    includeMetadata: true,
    includeTrigger: true,
  };
}

/**
 * Project a SemanticSearch response onto catalog cards. A guard/error payload
 * (no `results` array) is returned untouched so the caller can surface it.
 */
export function projectSkillSearchResponse(res: unknown): unknown {
  if (!res || typeof res !== "object" || !Array.isArray((res as { results?: unknown }).results)) {
    return res;
  }
  const payload = res as { results: unknown[] };
  return { ...payload, results: payload.results.map(projectSkillCard) };
}

export function formatSkillCatalog(results: Array<Record<string, unknown>>): string {
  if (results.length === 0) return "No matching skills found.";
  return results
    .map((card, i) => {
      const title = typeof card.name === "string" && card.name.length > 0 ? card.name : "(unnamed skill)";
      const trigger = typeof card.trigger === "string" && card.trigger.length > 0 ? card.trigger : "";
      const desc = typeof card.description === "string" && card.description.length > 0 ? card.description : "";
      const idStr = card.id ? `id:${card.id}` : "";
      const header = [title, trigger, idStr].filter(Boolean).join(" — ");
      return desc ? `${i + 1}. ${header}\n   ${desc}` : `${i + 1}. ${header}`;
    })
    .join("\n");
}
